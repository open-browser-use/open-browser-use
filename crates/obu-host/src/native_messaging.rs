//! Chrome Native Messaging mode for the WebExtension backend.

use std::collections::{HashMap, VecDeque};
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
use crate::runtime_descriptor_lifecycle::{
    RuntimeDescriptorDropPlan, RuntimeDescriptorLifecycleEventKind, plan_runtime_descriptor_drop,
    plan_runtime_descriptor_write,
};
use crate::socket::{Listener, unix::UnixSockListener};

type NativeReader = FramedRead<Stdin, FrameCodec>;
type NativeWriter = FramedWrite<Stdout, FrameCodec>;

const MIN_EXTENSION_VERSION: &str = "0.1.0";
const DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS: u64 = 30_000;
const MAX_EXTENSION_TRANSPORT_DIAGNOSTICS: usize = 20;

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
    close_runtime_descriptor_registration(&registration, "native_messaging_loop_finished").await;
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
            close_runtime_descriptor_registration(registration, "stop_browser_control").await;
            Response::ok(request.id, Value::Null)
        }
        "takeBrowserControl" => match apply_extension_control_state(backend, request.params, true) {
            Ok(()) => Response::ok(request.id, Value::Null),
            Err(error) => Response::err(
                request.id,
                ErrorObject::new(ErrorCode::InvalidParams, error.to_string()),
            ),
        },
        "resumeBrowserControl" => match apply_extension_control_state(backend, request.params, false) {
            Ok(()) => Response::ok(request.id, Value::Null),
            Err(error) => Response::err(
                request.id,
                ErrorObject::new(ErrorCode::InvalidParams, error.to_string()),
            ),
        },
        other => Response::err(
            request.id,
            ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("native host method not found: {other}"),
            ),
        ),
    }
}

fn apply_extension_control_state(
    backend: &WebExtensionBackend,
    params: Value,
    human_takeover: bool,
) -> anyhow::Result<()> {
    let sessions = params
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("sessions must be an array"))?;
    for session in sessions {
        let session_id = session
            .get("session_id")
            .or_else(|| session.get("sessionId"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("session_id must be a non-empty string"))?;
        let turn_id = session
            .get("turn_id")
            .or_else(|| session.get("turnId"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("turn_id must be a non-empty string"))?;
        backend
            .registry()
            .set_human_takeover(session_id, Some(turn_id), human_takeover)?;
    }
    Ok(())
}

async fn close_runtime_descriptor_registration(
    registration: &Arc<Mutex<Option<RuntimeDescriptorRegistration>>>,
    reason: &str,
) {
    if let Some(registration) = registration.lock().await.take() {
        registration.close(reason);
    } else {
        let plan = plan_runtime_descriptor_drop(None, reason);
        trace_runtime_descriptor_drop(None, reason, &plan);
    }
}

struct NativeExtensionTransport {
    writer: Arc<Mutex<NativeWriter>>,
    next_id: AtomicI64,
    pending: StdMutex<HashMap<i64, PendingExtensionRequest>>,
    diagnostics: StdMutex<VecDeque<Value>>,
}

struct PendingExtensionRequest {
    method: String,
    started_at_unix_ms: u64,
    timeout_ms: u64,
    responder: Option<oneshot::Sender<Response>>,
    timed_out_at_unix_ms: Option<u64>,
}

impl NativeExtensionTransport {
    fn new(writer: Arc<Mutex<NativeWriter>>) -> Self {
        Self {
            writer,
            next_id: AtomicI64::new(1),
            pending: StdMutex::new(HashMap::new()),
            diagnostics: StdMutex::new(VecDeque::new()),
        }
    }

    async fn complete_response(&self, response: Response) {
        let Some(id) = response_id(&response.id) else {
            return;
        };
        if let Some(mut pending) = self
            .pending
            .lock()
            .expect("native extension pending lock")
            .remove(&id)
        {
            if let Some(tx) = pending.responder.take() {
                if !tx.is_closed() {
                    let _ = tx.send(response);
                    return;
                }
            }
            self.record_diagnostic(late_response_event(id, pending, response));
        }
    }

    async fn fail_all(&self, message: &str) {
        let pending =
            std::mem::take(&mut *self.pending.lock().expect("native extension pending lock"));
        for (id, mut pending) in pending {
            let response = Response::err(
                Id::Number(id),
                ErrorObject::new(ErrorCode::InternalError, message),
            );
            if let Some(tx) = pending.responder.take() {
                if !tx.is_closed() {
                    let _ = tx.send(response);
                    continue;
                }
            }
            self.record_diagnostic(late_transport_closed_event(id, pending, message));
        }
    }

    fn diagnostics(&self) -> Value {
        let pending = self
            .pending
            .lock()
            .expect("native extension pending lock")
            .values()
            .map(|pending| {
                json!({
                    "method": pending.method,
                    "started_at_unix_ms": pending.started_at_unix_ms,
                    "timeout_ms": pending.timeout_ms,
                    "timed_out_at_unix_ms": pending.timed_out_at_unix_ms,
                    "awaiting_late_completion": pending
                        .responder
                        .as_ref()
                        .map(oneshot::Sender::is_closed)
                        .unwrap_or(true),
                })
            })
            .collect::<Vec<_>>();
        let recent_events = self
            .diagnostics
            .lock()
            .expect("native extension diagnostics lock")
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        json!({
            "pending": pending,
            "recent_events": recent_events,
            "recent_event_count": recent_events.len(),
        })
    }

    fn record_diagnostic(&self, event: Value) {
        let mut diagnostics = self
            .diagnostics
            .lock()
            .expect("native extension diagnostics lock");
        push_bounded_transport_diagnostic(&mut diagnostics, event);
    }
}

#[async_trait]
impl ExtensionTransport for NativeExtensionTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        let timeout_ms = params
            .get("timeoutMs")
            .or_else(|| params.get("client_timeout_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS);
        let started_at_unix_ms = unix_millis_now();
        self.pending
            .lock()
            .expect("native extension pending lock")
            .insert(
                id,
                PendingExtensionRequest {
                    method: method.to_string(),
                    started_at_unix_ms,
                    timeout_ms,
                    responder: Some(tx),
                    timed_out_at_unix_ms: None,
                },
            );
        let request = Request::new(id, method, params);
        if let Err(error) = send_native(&self.writer, &request).await {
            self.pending
                .lock()
                .expect("native extension pending lock")
                .remove(&id);
            return Err(error);
        }
        let response = match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), rx)
            .await
        {
            Ok(response) => response.map_err(|_| {
                HostError::Protocol(format!("extension response dropped: {method}"))
            })?,
            Err(_) => {
                let timed_out_at_unix_ms = unix_millis_now();
                if let Some(pending) = self
                    .pending
                    .lock()
                    .expect("native extension pending lock")
                    .get_mut(&id)
                {
                    pending.responder = None;
                    pending.timed_out_at_unix_ms = Some(timed_out_at_unix_ms);
                }
                self.record_diagnostic(json!({
                    "kind": "timed_out_awaiting_late_completion",
                    "request_id": id,
                    "method": method,
                    "started_at_unix_ms": started_at_unix_ms,
                    "timed_out_at_unix_ms": timed_out_at_unix_ms,
                    "elapsed_ms": timed_out_at_unix_ms.saturating_sub(started_at_unix_ms),
                    "timeout_ms": timeout_ms,
                }));
                return Err(HostError::Timeout(format!(
                    "extension request timed out: {method}; late completion will be reported in transport diagnostics"
                )));
            }
        };
        if let Some(error) = response.error {
            return Err(HostError::rpc(error));
        }
        Ok(response.result.unwrap_or(Value::Null))
    }

    fn diagnostics(&self) -> Value {
        NativeExtensionTransport::diagnostics(self)
    }
}

fn late_response_event(id: i64, pending: PendingExtensionRequest, response: Response) -> Value {
    let completed_at_unix_ms = unix_millis_now();
    let mut event = json!({
        "kind": if response.error.is_some() { "timed_out_late_error" } else { "timed_out_late_success" },
        "request_id": id,
        "method": pending.method,
        "started_at_unix_ms": pending.started_at_unix_ms,
        "timed_out_at_unix_ms": pending.timed_out_at_unix_ms,
        "completed_at_unix_ms": completed_at_unix_ms,
        "elapsed_ms": completed_at_unix_ms.saturating_sub(pending.started_at_unix_ms),
        "timeout_ms": pending.timeout_ms,
    });
    if let Some(error) = response.error
        && let Some(object) = event.as_object_mut()
    {
        object.insert("error_code".into(), json!(error.code));
        object.insert("error_message".into(), json!(error.message));
        if let Some(data) = error.data {
            object.insert("error_data".into(), data);
        }
    }
    event
}

fn late_transport_closed_event(id: i64, pending: PendingExtensionRequest, message: &str) -> Value {
    let completed_at_unix_ms = unix_millis_now();
    json!({
        "kind": "timed_out_late_transport_closed",
        "request_id": id,
        "method": pending.method,
        "started_at_unix_ms": pending.started_at_unix_ms,
        "timed_out_at_unix_ms": pending.timed_out_at_unix_ms,
        "completed_at_unix_ms": completed_at_unix_ms,
        "elapsed_ms": completed_at_unix_ms.saturating_sub(pending.started_at_unix_ms),
        "timeout_ms": pending.timeout_ms,
        "error_message": message,
    })
}

fn push_bounded_transport_diagnostic(diagnostics: &mut VecDeque<Value>, event: Value) {
    diagnostics.push_back(event);
    while diagnostics.len() > MAX_EXTENSION_TRANSPORT_DIAGNOSTICS {
        diagnostics.pop_front();
    }
}

fn response_id(id: &Id) -> Option<i64> {
    match id {
        Id::Number(value) => Some(*value),
        Id::String(value) => value.parse().ok(),
    }
}

fn unix_millis_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
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
    let profile_metadata = sanitize_profile_metadata(raw_hello.get("profile_metadata"));
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
        "profileIdHash": profile_metadata.get("profileIdHash").cloned().unwrap_or(Value::Null),
        "profileIsLastUsed": profile_metadata.get("profileIsLastUsed").cloned().unwrap_or(Value::Null),
        "profileOrdering": profile_metadata.get("profileOrdering").cloned().unwrap_or(Value::Null),
        "profileRuntimeBinding": profile_metadata
            .get("profileRuntimeBinding")
            .cloned()
            .unwrap_or_else(|| Value::String("webextension".into())),
        "profile_metadata": profile_metadata,
    })
}

fn sanitize_profile_metadata(raw: Option<&Value>) -> Value {
    let mut profile = serde_json::Map::new();
    let Some(raw) = raw.and_then(Value::as_object) else {
        profile.insert(
            "profileRuntimeBinding".into(),
            Value::String("webextension".into()),
        );
        return Value::Object(profile);
    };
    if let Some(value) = raw.get("profileIdHash").and_then(Value::as_str) {
        profile.insert("profileIdHash".into(), Value::String(value.to_string()));
    }
    if let Some(value) = raw.get("profileIsLastUsed").and_then(Value::as_bool) {
        profile.insert("profileIsLastUsed".into(), Value::Bool(value));
    }
    if let Some(value) = raw.get("profileOrdering").and_then(Value::as_i64) {
        profile.insert("profileOrdering".into(), Value::Number(value.into()));
    }
    let binding = raw
        .get("profileRuntimeBinding")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "webextension" | "cdp" | "unknown"))
        .unwrap_or("webextension");
    profile.insert(
        "profileRuntimeBinding".into(),
        Value::String(binding.to_string()),
    );
    if let Some(redacted) = raw
        .get("diagnostics")
        .and_then(Value::as_object)
        .and_then(|diagnostics| diagnostics.get("profilePathRedacted"))
        .and_then(Value::as_str)
    {
        profile.insert(
            "diagnostics".into(),
            json!({ "profilePathRedacted": redacted }),
        );
    }
    Value::Object(profile)
}

struct RuntimeDescriptorRegistration {
    descriptor_path: Option<PathBuf>,
}

impl RuntimeDescriptorRegistration {
    fn write(socket_path: &Path, sdk_auth_token: &str, metadata: Value, pid: u32) -> Result<Self> {
        let runtime_root = resolve_runtime_dir();
        validate_owner_only_dir(&runtime_root)?;
        let dir = runtime_root.join("webextension");
        validate_owner_only_dir(&dir)?;

        let id = Uuid::new_v4().simple().to_string();
        let plan = plan_runtime_descriptor_write(
            &dir,
            &id,
            socket_path,
            sdk_auth_token,
            metadata,
            pid,
            started_at(),
        );

        write_owner_only_json(&plan.tmp_path, &plan.descriptor)?;
        std::fs::rename(&plan.tmp_path, &plan.descriptor_path)?;
        tracing::debug!(
            event = ?plan.event.kind,
            descriptor_path = %plan.descriptor_path.display(),
            "runtime descriptor lifecycle"
        );
        Ok(Self {
            descriptor_path: Some(plan.descriptor_path),
        })
    }

    fn close(mut self, reason: &str) {
        self.remove_descriptor_file(reason);
    }

    fn remove_descriptor_file(&mut self, reason: &str) {
        let descriptor_path = self.descriptor_path.as_deref();
        let plan = plan_runtime_descriptor_drop(descriptor_path, reason);
        trace_runtime_descriptor_drop(plan.remove_path.as_deref(), reason, &plan);
        if let Some(path) = &plan.remove_path {
            match std::fs::remove_file(path) {
                Ok(()) => self.descriptor_path = None,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.descriptor_path = None;
                }
                Err(error) => {
                    tracing::warn!(
                        descriptor_path = %path.display(),
                        reason,
                        error = %error,
                        "runtime descriptor removal failed; retaining path for retry"
                    );
                    // Keep descriptor_path set so Drop / next cleanup retries.
                }
            }
        }
    }
}

impl Drop for RuntimeDescriptorRegistration {
    fn drop(&mut self) {
        if self.descriptor_path.is_some() {
            self.remove_descriptor_file("registration_dropped");
        }
    }
}

fn trace_runtime_descriptor_drop(
    _remove_path: Option<&Path>,
    reason: &str,
    plan: &RuntimeDescriptorDropPlan,
) {
    match plan.event.kind {
        RuntimeDescriptorLifecycleEventKind::Dropped => {
            if let Some(path) = &plan.event.descriptor_path {
                tracing::debug!(
                    event = ?plan.event.kind,
                    descriptor_path = %path.display(),
                    reason,
                    "runtime descriptor lifecycle"
                );
            }
        }
        RuntimeDescriptorLifecycleEventKind::DropSkipped => {
            tracing::debug!(
                event = ?plan.event.kind,
                reason,
                "runtime descriptor lifecycle"
            );
        }
        RuntimeDescriptorLifecycleEventKind::Fresh => {}
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_timeout_success_error_and_transport_closed_events_are_structured() {
        let success = late_response_event(
            7,
            pending_request("createTab"),
            Response::ok(Id::Number(7), json!({ "tabId": 7 })),
        );
        assert_eq!(success["kind"], "timed_out_late_success");
        assert_eq!(success["request_id"], 7);
        assert_eq!(success["method"], "createTab");
        assert_eq!(success["timeout_ms"], 5);
        assert!(success.get("error_code").is_none());

        let error = late_response_event(
            8,
            pending_request("click"),
            Response::err(
                Id::Number(8),
                ErrorObject::new(ErrorCode::InternalError, "click failed")
                    .with_data(json!({ "code": "synthetic_click_failure" })),
            ),
        );
        assert_eq!(error["kind"], "timed_out_late_error");
        assert_eq!(error["request_id"], 8);
        assert_eq!(error["method"], "click");
        assert_eq!(error["error_code"], ErrorCode::InternalError.value());
        assert_eq!(error["error_message"], "click failed");
        assert_eq!(error["error_data"], json!({ "code": "synthetic_click_failure" }));

        let closed = late_transport_closed_event(9, pending_request("goto"), "native port closed");
        assert_eq!(closed["kind"], "timed_out_late_transport_closed");
        assert_eq!(closed["request_id"], 9);
        assert_eq!(closed["method"], "goto");
        assert_eq!(closed["error_message"], "native port closed");
    }

    fn pending_request(method: &str) -> PendingExtensionRequest {
        PendingExtensionRequest {
            method: method.into(),
            started_at_unix_ms: 1,
            timeout_ms: 5,
            responder: None,
            timed_out_at_unix_ms: Some(6),
        }
    }

    #[test]
    fn descriptor_drop_retains_path_when_remove_fails() {
        let dir = tempfile::tempdir().unwrap(); // a directory, not a file
        let mut reg = RuntimeDescriptorRegistration {
            descriptor_path: Some(dir.path().to_path_buf()),
        };
        reg.remove_descriptor_file("test"); // remove_file on a dir => non-NotFound error
        assert!(
            reg.descriptor_path.is_some(),
            "path must be retained when remove_file fails"
        );
    }

    #[test]
    fn descriptor_drop_clears_path_when_already_absent() {
        let mut reg = RuntimeDescriptorRegistration {
            descriptor_path: Some(std::path::PathBuf::from("/definitely/not/here.json")),
        };
        reg.remove_descriptor_file("test"); // NotFound => treat as dropped
        assert!(
            reg.descriptor_path.is_none(),
            "NotFound means already gone"
        );
    }

    #[test]
    fn descriptor_drop_clears_path_when_remove_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("descriptor.json");
        std::fs::write(&file_path, b"{}").unwrap();
        let mut reg = RuntimeDescriptorRegistration {
            descriptor_path: Some(file_path.clone()),
        };
        reg.remove_descriptor_file("test");
        assert!(reg.descriptor_path.is_none(), "successful remove must clear the path");
        assert!(!file_path.exists(), "file must actually be removed");
    }
}
