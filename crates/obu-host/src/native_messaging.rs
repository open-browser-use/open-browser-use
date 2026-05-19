//! Chrome Native Messaging mode for the WebExtension backend.

use std::collections::HashMap;
use std::hash::Hash;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{Stdin, Stdout};
use tokio::sync::{Mutex, oneshot, watch};
use tokio_util::codec::{FramedRead, FramedWrite};
use uuid::Uuid;

use obu_wire::{
    ErrorCode, ErrorObject, FrameCodec, Hello, HelloAck, MinVersion, Request, Response, RpcMessage,
    VersionMismatch,
    envelope::Id,
    runtime_dir::{ensure_owner_only_dir, resolve_runtime_dir, validate_owner_only_dir},
};

use crate::backends::{
    BrowserBackend,
    webext::{ExtensionTransport, WebExtensionBackend},
};
use crate::cli::Cli;
use crate::dispatcher::Dispatcher;
use crate::error::{HostError, Result};
use crate::policy::ConfiguredHostPolicy;
use crate::socket::{Listener, unix::UnixSockListener};

type NativeReader = FramedRead<Stdin, FrameCodec>;
type NativeWriter = FramedWrite<Stdout, FrameCodec>;

const MIN_EXTENSION_VERSION: &str = "0.1.0";
const DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS: u64 = 30_000;
const EXTENSION_RESPONSE_OVERSHOOT_MS: u64 = 5_000;

/// Run `obu-host` as a Chrome Native Messaging host.
pub async fn run(_args: Cli) -> anyhow::Result<()> {
    let mut reader = FramedRead::new(tokio::io::stdin(), FrameCodec);
    let writer = Arc::new(Mutex::new(FramedWrite::new(
        tokio::io::stdout(),
        FrameCodec,
    )));

    let Some(first_frame) = reader.next().await else {
        return Ok(());
    };
    let first_frame = first_frame?;
    let first_value: Value = serde_json::from_slice(&first_frame)?;
    let hello: Hello = serde_json::from_value(first_value.clone())?;

    let host_version = parse_version(env!("CARGO_PKG_VERSION"))?;
    let min_extension_version = parse_version(MIN_EXTENSION_VERSION)?;
    if host_version < hello.min_host_version {
        send_native(
            &writer,
            &VersionMismatch {
                message: format!(
                    "open-browser-use host v{} is too old for extension v{}. Update @open-browser-use/cli.",
                    host_version, hello.extension_version
                ),
            },
        )
        .await?;
        return Ok(());
    }
    if hello.extension_version < min_extension_version {
        send_native(
            &writer,
            &VersionMismatch {
                message: format!(
                    "open-browser-use extension v{} is too old for host v{}. Update the extension.",
                    hello.extension_version, host_version
                ),
            },
        )
        .await?;
        return Ok(());
    }

    send_native(
        &writer,
        &HelloAck {
            host_version,
            min_extension_version,
        },
    )
    .await?;

    let extension_metadata = extension_metadata(&first_value, &hello);
    let extension_transport = Arc::new(NativeExtensionTransport::new(writer.clone()));
    let browser_kind = extension_metadata
        .get("browser_kind")
        .and_then(Value::as_str)
        .unwrap_or("chrome")
        .to_string();
    let backend = Arc::new(
        WebExtensionBackend::new(browser_kind, extension_metadata.clone())
            .with_transport(extension_transport.clone()),
    );
    let backend_for_dispatcher: Arc<dyn BrowserBackend> = backend.clone();

    let sdk_token = Uuid::new_v4().simple().to_string();
    let mut listener = bind_sdk_socket()?;
    let registration = Arc::new(Mutex::new(Some(RuntimeDescriptorRegistration::write(
        listener.path(),
        &sdk_token,
        extension_metadata,
        std::process::id(),
    )?)));

    let dispatcher = Arc::new(Dispatcher::new_with_policy(
        env!("CARGO_PKG_VERSION").into(),
        backend_for_dispatcher,
        Arc::new(ConfiguredHostPolicy::from_env()),
    ));
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let token_for_accept = sdk_token.clone();
    let dispatcher_for_accept = dispatcher.clone();
    let accept_loop = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;

                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        break;
                    }
                }
                peer = listener.accept() => {
                    let peer = peer?;
                    if *stop_rx.borrow() {
                        break;
                    }
                    let dispatcher = dispatcher_for_accept.clone();
                    let token = token_for_accept.clone();
                    tokio::spawn(async move {
                        if let Err(error) = dispatcher.serve_peer(peer.stream, Some(&token)).await {
                            tracing::warn!(%error, "native-mode SDK peer ended with error");
                        }
                    });
                }
            }
        }
        Ok::<(), HostError>(())
    });

    let native_loop = serve_native_messages(
        reader,
        writer,
        backend,
        extension_transport,
        stop_tx,
        registration.clone(),
    )
    .await;
    accept_loop.abort();
    drop(registration.lock().await.take());
    native_loop.map_err(Into::into)
}

async fn serve_native_messages(
    mut reader: NativeReader,
    writer: Arc<Mutex<NativeWriter>>,
    backend: Arc<WebExtensionBackend>,
    extension_transport: Arc<NativeExtensionTransport>,
    stop_tx: watch::Sender<bool>,
    registration: Arc<Mutex<Option<RuntimeDescriptorRegistration>>>,
) -> Result<()> {
    while let Some(frame) = reader.next().await {
        let frame = frame?;
        let message: RpcMessage = match serde_json::from_slice(&frame) {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!(%error, "dropping malformed native-messaging JSON-RPC frame");
                continue;
            }
        };
        match message {
            RpcMessage::Request(request) => {
                let response =
                    handle_extension_request(request, &backend, &stop_tx, &registration).await;
                send_native(&writer, &response).await?;
            }
            RpcMessage::Response(response) => extension_transport.complete_response(response).await,
            RpcMessage::Notification(notification) => {
                backend.handle_notification(notification.method, notification.params);
            }
        }
    }
    extension_transport
        .fail_all("native messaging port closed")
        .await;
    Ok(())
}

async fn handle_extension_request(
    request: Request,
    backend: &WebExtensionBackend,
    stop_tx: &watch::Sender<bool>,
    registration: &Arc<Mutex<Option<RuntimeDescriptorRegistration>>>,
) -> Response {
    match request.method.as_str() {
        "ping" => Response::ok(request.id, Value::String("pong".into())),
        "stopBrowserControl" => {
            backend.stop();
            let _ = stop_tx.send(true);
            drop(registration.lock().await.take());
            Response::ok(request.id, Value::Null)
        }
        other => Response::err(
            request.id,
            ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("native host method not found: {other}"),
            ),
        ),
    }
}

struct NativeExtensionTransport {
    writer: Arc<Mutex<NativeWriter>>,
    next_id: AtomicI64,
    pending: StdMutex<HashMap<i64, oneshot::Sender<Response>>>,
}

struct PendingRemovalGuard<'a, K, V>
where
    K: Copy + Eq + Hash,
{
    pending: &'a StdMutex<HashMap<K, V>>,
    id: K,
}

impl<K, V> Drop for PendingRemovalGuard<'_, K, V>
where
    K: Copy + Eq + Hash,
{
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl NativeExtensionTransport {
    fn new(writer: Arc<Mutex<NativeWriter>>) -> Self {
        Self {
            writer,
            next_id: AtomicI64::new(1),
            pending: StdMutex::new(HashMap::new()),
        }
    }

    async fn complete_response(&self, response: Response) {
        let Some(id) = response_id(&response.id) else {
            return;
        };
        if let Some(tx) = self
            .pending
            .lock()
            .expect("native extension pending lock")
            .remove(&id)
        {
            let _ = tx.send(response);
        }
    }

    async fn fail_all(&self, message: &str) {
        let pending =
            std::mem::take(&mut *self.pending.lock().expect("native extension pending lock"));
        for (id, tx) in pending {
            let _ = tx.send(Response::err(
                Id::Number(id),
                ErrorObject::new(ErrorCode::InternalError, message),
            ));
        }
    }
}

#[async_trait]
impl ExtensionTransport for NativeExtensionTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("native extension pending lock")
            .insert(id, tx);
        let _pending_guard = PendingRemovalGuard {
            pending: &self.pending,
            id,
        };
        let timeout_ms = params
            .get("timeoutMs")
            .or_else(|| params.get("client_timeout_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS)
            .saturating_add(EXTENSION_RESPONSE_OVERSHOOT_MS);
        let request = Request::new(id, method, params);
        if let Err(error) = send_native(&self.writer, &request).await {
            return Err(error);
        }
        let response =
            match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx).await {
                Ok(response) => response.map_err(|_| {
                    HostError::Protocol(format!("extension response dropped: {method}"))
                })?,
                Err(_) => {
                    return Err(HostError::Timeout(format!(
                        "extension request timed out: {method}"
                    )));
                }
            };
        if let Some(error) = response.error {
            return Err(HostError::Protocol(error.message));
        }
        Ok(response.result.unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::PendingRemovalGuard;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[test]
    fn pending_guard_removes_entry_on_drop() {
        let pending = Mutex::new(HashMap::from([(7_i64, "pending")]));
        {
            let _guard = PendingRemovalGuard {
                pending: &pending,
                id: 7,
            };
            assert!(pending.lock().expect("pending lock").contains_key(&7));
        }
        assert!(!pending.lock().expect("pending lock").contains_key(&7));
    }
}

fn response_id(id: &Id) -> Option<i64> {
    match id {
        Id::Number(value) => Some(*value),
        Id::String(value) => value.parse().ok(),
    }
}

async fn send_native<T: serde::Serialize>(
    writer: &Arc<Mutex<NativeWriter>>,
    value: &T,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)
        .map(Bytes::from)
        .map_err(|error| HostError::Protocol(error.to_string()))?;
    writer.lock().await.send(bytes).await?;
    Ok(())
}

fn parse_version(raw: &str) -> anyhow::Result<MinVersion> {
    raw.parse()
        .map_err(|error| anyhow::anyhow!("parse version {raw}: {error}"))
}

fn bind_sdk_socket() -> Result<UnixSockListener> {
    let runtime_root = resolve_runtime_dir();
    ensure_owner_only_dir(&runtime_root)?;
    let descriptor_dir = runtime_root.join("webextension");
    ensure_owner_only_dir(&descriptor_dir)?;
    let path = descriptor_dir.join(format!("{}.sock", Uuid::new_v4().simple()));
    UnixSockListener::bind(&path)
}

fn extension_metadata(raw_hello: &Value, hello: &Hello) -> Value {
    let browser_kind = std::env::var("OBU_BROWSER_KIND").ok().or_else(|| {
        raw_hello
            .get("browser_kind")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    json!({
        "native_host_name": raw_hello
            .get("native_host_name")
            .and_then(Value::as_str)
            .unwrap_or("dev.obu.host"),
        "browser_kind": browser_kind.as_deref().unwrap_or("chrome"),
        "extension_id": raw_hello
            .get("extension_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        "extension_version": hello.extension_version.to_string(),
        "extension_instance_id": raw_hello
            .get("extension_instance_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown"),
        "manifest_version": hello.manifest_version,
    })
}

struct RuntimeDescriptorRegistration {
    descriptor_path: PathBuf,
}

impl RuntimeDescriptorRegistration {
    fn write(socket_path: &Path, sdk_auth_token: &str, metadata: Value, pid: u32) -> Result<Self> {
        let runtime_root = resolve_runtime_dir();
        validate_owner_only_dir(&runtime_root)?;
        let dir = runtime_root.join("webextension");
        validate_owner_only_dir(&dir)?;

        let id = Uuid::new_v4().simple().to_string();
        let descriptor_path = dir.join(format!("{id}.json"));
        let tmp_path = dir.join(format!("{id}.json.tmp"));
        let descriptor = json!({
            "schema_version": 1,
            "type": "webextension",
            "name": metadata
                .get("browser_kind")
                .and_then(Value::as_str)
                .unwrap_or("chrome"),
            "socketPath": socket_path.to_string_lossy(),
            "sdk_auth_token": sdk_auth_token,
            "pid": pid,
            "startedAt": started_at(),
            "metadata": metadata,
        });

        write_owner_only_json(&tmp_path, &descriptor)?;
        std::fs::rename(&tmp_path, &descriptor_path)?;
        Ok(Self { descriptor_path })
    }
}

impl Drop for RuntimeDescriptorRegistration {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.descriptor_path);
    }
}

fn write_owner_only_json(path: &Path, value: &Value) -> Result<()> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path)?;
    serde_json::to_writer(file, value)
        .map_err(|error| HostError::Protocol(format!("write descriptor json: {error}")))?;
    Ok(())
}

fn started_at() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}
