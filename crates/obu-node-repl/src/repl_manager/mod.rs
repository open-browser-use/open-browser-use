//! REPL manager for the Node child running `kernel.js`.

pub mod kernel_state;
pub mod node_version;
pub mod spawn;
pub mod stdio_codec;

pub use kernel_state::{DisplayEntry, ExecRegistry, JsExecResult, KernelState, TruncationInfo};
pub use node_version::{NodeVersion, required_node_version, resolve_compatible_node};
pub use spawn::{SpawnOptions, SpawnedKernel};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use crate::native_pipe::{
    broker::NativePipeBroker,
    protocol::{KernelIn, KernelOut, NativePipeResponse},
};
use anyhow::{Context, Result, anyhow};
use obu_wire::runtime_dir::{resolve_runtime_dir, validate_owner_only_dir};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// JavaScript kernel source embedded at compile time.
pub const KERNEL_JS: &str = include_str!("../../embedded/kernel.js");
/// Meriyah parser bundled next to the kernel at spawn time.
pub const MERIYAH_JS: &str = include_str!("../../embedded/meriyah.umd.min.js");

/// Runtime manager configuration.
#[derive(Debug, Clone)]
pub struct ManagerOptions {
    /// Session identifier passed to the kernel.
    pub session_id: String,
    /// Working directory for user code.
    pub working_dir: PathBuf,
    /// Initial module search roots.
    pub module_dirs: Vec<PathBuf>,
    /// Trusted code directories.
    pub trusted_code_paths: Vec<PathBuf>,
    /// Trusted source hashes.
    pub trusted_module_sha256s: Vec<String>,
    /// Trust every imported module.
    pub trust_all: bool,
    /// Default timeout for `exec` calls.
    pub default_timeout: Duration,
    /// Browser backends discoverable by trusted SDK code.
    pub backends: Vec<DiscoveredBackend>,
    /// Backend discovery diagnostics exposed through `globalThis.obuRepl`.
    pub backend_discovery_diagnostics: Vec<BackendDiscoveryDiagnostic>,
    /// Capability tokens keyed by canonical backend socket path.
    pub backend_auth_tokens: HashMap<PathBuf, String>,
}

/// Backend inventory item exposed through `globalThis.obuRepl.discoverBackends()`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiscoveredBackend {
    /// Backend type, e.g. `cdp` or `webextension`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Stable backend name.
    pub name: String,
    /// Socket path for the backend's `obu-host` connection.
    #[serde(rename = "socketPath")]
    pub socket_path: String,
    /// Optional backend metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Diagnostic explaining why a runtime backend descriptor was ignored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BackendDiscoveryDiagnostic {
    /// Descriptor file or directory path.
    pub source: String,
    /// Human-readable reason the descriptor was ignored.
    pub reason: String,
}

impl ManagerOptions {
    /// Construct options from CLI values and OBU environment variables.
    pub fn from_cli(cli: &crate::cli::Cli) -> Result<Self> {
        let working_dir = cli
            .working_dir
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let session_id = cli
            .session_id
            .clone()
            .unwrap_or_else(|| format!("obu-{}", Uuid::new_v4().simple()));

        let module_dirs = split_env_paths("OBU_NODE_REPL_MODULE_DIRS");
        let mut trusted_code_paths = split_env_paths("OBU_TRUSTED_CODE_PATHS");
        let mut trusted_module_sha256s = split_env_list("OBU_TRUSTED_MODULE_SHA256S");
        seed_sdk_trust(
            &module_dirs,
            &mut trusted_code_paths,
            &mut trusted_module_sha256s,
        )?;

        let inventory = discover_backend_inventory();
        Ok(Self {
            session_id,
            working_dir,
            module_dirs,
            trusted_code_paths,
            trusted_module_sha256s,
            trust_all: std::env::var("OBU_TRUST_ALL_CODE").as_deref() == Ok("1"),
            default_timeout: Duration::from_secs(30),
            backends: inventory.backends,
            backend_discovery_diagnostics: inventory.diagnostics,
            backend_auth_tokens: inventory.auth_tokens,
        })
    }

    /// Deterministic test defaults.
    pub fn for_tests() -> Self {
        Self {
            session_id: format!("obu-test-{}", Uuid::new_v4().simple()),
            working_dir: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            module_dirs: Vec::new(),
            trusted_code_paths: Vec::new(),
            trusted_module_sha256s: Vec::new(),
            trust_all: false,
            default_timeout: Duration::from_secs(30),
            backends: Vec::new(),
            backend_discovery_diagnostics: Vec::new(),
            backend_auth_tokens: HashMap::new(),
        }
    }
}

#[derive(Clone)]
struct BrokerPolicy {
    connect_timeout: Duration,
    allowed_paths: Option<Vec<PathBuf>>,
    capability_token: Option<String>,
}

impl BrokerPolicy {
    fn from_env() -> Result<Self> {
        let connect_timeout = std::env::var("OBU_NATIVE_PIPE_CONNECT_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(10));
        let allowed_paths = split_env_socket_paths("OBU_SANDBOX_ALLOWED_UNIX_SOCKETS")?;
        let capability_token = std::env::var("OBU_CAPABILITY_TOKEN").ok();
        Ok(Self {
            connect_timeout,
            allowed_paths,
            capability_token,
        })
    }
}

struct KernelGeneration {
    native_pipe: Arc<NativePipeBroker>,
    kernel_stdin: Arc<Mutex<stdio_codec::StdioWriter>>,
    pending_exec_results: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    ready_rx: Option<oneshot::Receiver<()>>,
    handshake_token: Arc<Mutex<Option<String>>>,
    cancel: CancellationToken,
}

/// Orchestrates one persistent JavaScript kernel.
pub struct JsRuntimeManager {
    options: ManagerOptions,
    state: Mutex<KernelState>,
    kernel: Mutex<Option<SpawnedKernel>>,
    registry: Arc<Mutex<ExecRegistry>>,
    sink: Arc<Mutex<Option<crate::display_router::ProgressSink>>>,
    module_dirs: StdMutex<Vec<PathBuf>>,
    broker_policy: BrokerPolicy,
    generation: Mutex<Option<KernelGeneration>>,
}

impl JsRuntimeManager {
    /// Construct a manager. Call `boot` to eagerly spawn, or `exec` to spawn on
    /// first use.
    pub async fn new(options: ManagerOptions) -> Result<Self> {
        Ok(Self {
            module_dirs: StdMutex::new(options.module_dirs.clone()),
            options,
            state: Mutex::new(KernelState::Idle),
            kernel: Mutex::new(None),
            registry: Arc::new(Mutex::new(ExecRegistry::default())),
            sink: Arc::new(Mutex::new(None)),
            broker_policy: BrokerPolicy::from_env()?,
            generation: Mutex::new(None),
        })
    }

    /// Spawn the Node child if it is not already ready.
    pub async fn boot(&self) -> Result<()> {
        {
            let mut state = self.state.lock().await;
            if *state == KernelState::Ready {
                return Ok(());
            }
            *state = KernelState::Spawning;
        }

        let spawn_opts = SpawnOptions {
            session_id: self.options.session_id.clone(),
            working_dir: self.options.working_dir.clone(),
            module_dirs: self.module_dirs.lock().expect("module dir lock").clone(),
            trusted_code_paths: self.options.trusted_code_paths.clone(),
            trusted_module_sha256s: self.options.trusted_module_sha256s.clone(),
            trust_all: self.options.trust_all,
            backends: self.options.backends.clone(),
            backend_discovery_diagnostics: self.options.backend_discovery_diagnostics.clone(),
        };
        let mut kernel = SpawnedKernel::spawn(spawn_opts)
            .await
            .context("spawn JavaScript kernel")?;
        let kernel_reader = kernel
            .reader
            .take()
            .ok_or_else(|| anyhow!("kernel stdout reader already taken"))?;
        let kernel_stdin = Arc::new(Mutex::new(
            kernel
                .writer
                .take()
                .ok_or_else(|| anyhow!("kernel stdin writer already taken"))?,
        ));

        let (kernel_inbox_tx, kernel_inbox_rx) = mpsc::channel::<KernelIn>(64);
        let native_pipe = Arc::new(NativePipeBroker::with_token_map(
            kernel_inbox_tx.clone(),
            self.broker_policy.connect_timeout,
            self.broker_policy.allowed_paths.clone(),
            self.broker_policy.capability_token.clone(),
            self.options.backend_auth_tokens.clone(),
        ));
        let pending_exec_results = Arc::new(Mutex::new(HashMap::new()));
        let handshake_token = Arc::new(Mutex::new(None));
        let cancel = CancellationToken::new();
        let (ready_tx, ready_rx) = oneshot::channel();

        tokio::spawn(spawn_outbox_pump(
            kernel_inbox_rx,
            kernel_stdin.clone(),
            cancel.clone(),
        ));
        tokio::spawn(spawn_stdout_demux(
            kernel_reader,
            pending_exec_results.clone(),
            self.registry.clone(),
            self.sink.clone(),
            native_pipe.clone(),
            kernel_inbox_tx,
            handshake_token.clone(),
            ready_tx,
            cancel.clone(),
        ));

        *self.kernel.lock().await = Some(kernel);
        *self.generation.lock().await = Some(KernelGeneration {
            native_pipe,
            kernel_stdin,
            pending_exec_results,
            ready_rx: Some(ready_rx),
            handshake_token,
            cancel,
        });
        self.wait_for_ready().await?;
        *self.state.lock().await = KernelState::Ready;
        Ok(())
    }

    async fn wait_for_ready(&self) -> Result<()> {
        let rx = self
            .generation
            .lock()
            .await
            .as_mut()
            .ok_or_else(|| anyhow!("kernel generation missing while waiting for ready"))?
            .ready_rx
            .take()
            .ok_or_else(|| anyhow!("kernel ready waiter already consumed"))?;
        rx.await.map_err(|_| anyhow!("kernel EOF before ready"))?;
        Ok(())
    }

    /// Execute JavaScript in the persistent kernel.
    pub async fn exec(&self, source: &str, timeout_ms: Option<u64>) -> Result<JsExecResult> {
        self.exec_with_turn_id(source, timeout_ms, None).await
    }

    /// Execute JavaScript with an optional client-supplied turn id.
    pub async fn exec_with_turn_id(
        &self,
        source: &str,
        timeout_ms: Option<u64>,
        client_turn_id: Option<String>,
    ) -> Result<JsExecResult> {
        if *self.state.lock().await != KernelState::Ready {
            self.boot().await?;
        }

        let exec_id = format!("exec-{}", Uuid::new_v4().simple());
        {
            let mut state = self.state.lock().await;
            if *state != KernelState::Ready {
                return Err(anyhow!("kernel is busy"));
            }
            *state = KernelState::Executing;
        }
        self.registry.lock().await.start(exec_id.clone());

        let turn_id = client_turn_id.unwrap_or_else(|| exec_id.clone());
        let outcome = self
            .exec_inner(source, timeout_ms, &exec_id, &turn_id)
            .await;
        match &outcome {
            Ok(_) => *self.state.lock().await = KernelState::Ready,
            Err(_) => {
                self.kill_kernel().await;
                *self.state.lock().await = KernelState::Idle;
                *self.registry.lock().await = ExecRegistry::default();
            }
        }
        outcome
    }

    async fn exec_inner(
        &self,
        source: &str,
        timeout_ms: Option<u64>,
        exec_id: &str,
        turn_id: &str,
    ) -> Result<JsExecResult> {
        self.sync_module_dirs_to_kernel().await?;
        let mut result_rx = self.register_exec_waiter(exec_id).await?;
        let frame = json!({
            "type": "exec",
            "id": exec_id,
            "source": source,
            "request_meta": {
                "x-obu-turn-metadata": {
                    "session_id": self.options.session_id.clone(),
                    "turn_id": turn_id,
                }
            },
        });
        let writer = self.kernel_stdin().await?;
        if let Err(error) = writer.lock().await.send(&frame).await {
            self.remove_exec_waiter(exec_id).await;
            return Err(error).context("send exec frame to kernel");
        }

        let timeout = Duration::from_millis(
            timeout_ms.unwrap_or(self.options.default_timeout.as_millis() as u64),
        );
        let frame = match tokio::time::timeout(timeout, &mut result_rx).await {
            Ok(Ok(frame)) => frame,
            Ok(Err(_)) => return Err(anyhow!("kernel EOF during exec {exec_id}")),
            Err(_) => {
                self.remove_exec_waiter(exec_id).await;
                return Err(anyhow!(
                    "JavaScript execution timed out after {}ms",
                    timeout.as_millis()
                ));
            }
        };
        self.parse_exec_result(exec_id, frame).await
    }

    async fn register_exec_waiter(&self, exec_id: &str) -> Result<oneshot::Receiver<Value>> {
        let pending = self.pending_exec_results().await?;
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(exec_id.to_string(), tx);
        Ok(rx)
    }

    async fn remove_exec_waiter(&self, exec_id: &str) {
        if let Ok(pending) = self.pending_exec_results().await {
            pending.lock().await.remove(exec_id);
        }
    }

    async fn pending_exec_results(
        &self,
    ) -> Result<Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>> {
        self.generation
            .lock()
            .await
            .as_ref()
            .map(|generation| generation.pending_exec_results.clone())
            .ok_or_else(|| anyhow!("kernel generation missing"))
    }

    async fn kernel_stdin(&self) -> Result<Arc<Mutex<stdio_codec::StdioWriter>>> {
        self.generation
            .lock()
            .await
            .as_ref()
            .map(|generation| generation.kernel_stdin.clone())
            .ok_or_else(|| anyhow!("kernel generation missing"))
    }

    async fn sync_module_dirs_to_kernel(&self) -> Result<()> {
        let dirs = self.module_dirs.lock().expect("module dir lock").clone();
        if dirs.is_empty() {
            return Ok(());
        }
        let writer = self.kernel_stdin().await?;
        for dir in dirs {
            writer
                .lock()
                .await
                .send(&json!({ "type": "add_module_dir", "path": dir }))
                .await?;
        }
        Ok(())
    }

    async fn parse_exec_result(&self, exec_id: &str, frame: Value) -> Result<JsExecResult> {
        let frame_exec_id = frame
            .get("exec_id")
            .or_else(|| frame.get("id"))
            .and_then(Value::as_str);
        if frame_exec_id != Some(exec_id) {
            tracing::warn!(?frame, expected = exec_id, "exec result id mismatch");
        }

        if frame.get("ok").and_then(Value::as_bool) == Some(false) {
            let message = frame
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("JavaScript execution failed");
            let _ = self.registry.lock().await.finish();
            return Err(anyhow!("JavaScript error: {message}"));
        }

        let displays = self.registry.lock().await.finish();
        Ok(JsExecResult {
            stdout: frame
                .get("stdout")
                .or_else(|| frame.get("output"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            stderr: frame
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            result: frame.get("result").cloned().unwrap_or(Value::Null),
            duration_ms: frame
                .get("duration_ms")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            truncated: None,
            displays,
        })
    }

    /// Restart the kernel and clear REPL state.
    pub async fn reset(&self) -> Result<()> {
        *self.state.lock().await = KernelState::Restarting;
        self.kill_kernel().await;
        *self.registry.lock().await = ExecRegistry::default();
        *self.state.lock().await = KernelState::Idle;
        self.boot().await
    }

    /// Add a module search directory. The directory is sent to the kernel before
    /// subsequent execs and included at spawn time after reset.
    pub fn add_module_dir(&self, dir: PathBuf) {
        if !dir.is_absolute() {
            tracing::warn!(dir = %dir.display(), "ignoring non-absolute module dir");
            return;
        }
        let mut dirs = self.module_dirs.lock().expect("module dir lock");
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }

    /// Install or clear the display progress sink.
    pub async fn set_progress_sink(&self, sink: Option<crate::display_router::ProgressSink>) {
        *self.sink.lock().await = sink;
    }

    /// Test helper exposing whether the kernel native-pipe handshake was seen.
    #[doc(hidden)]
    pub async fn observed_handshake_token_for_tests(&self) -> Option<String> {
        let handshake = self
            .generation
            .lock()
            .await
            .as_ref()
            .map(|generation| generation.handshake_token.clone())?;
        handshake.lock().await.clone()
    }

    async fn kill_kernel(&self) {
        if let Some(generation) = self.generation.lock().await.take() {
            generation.cancel.cancel();
            generation.native_pipe.close_all().await;
            generation.pending_exec_results.lock().await.clear();
        }
        if let Some(mut kernel) = self.kernel.lock().await.take() {
            let _ = kernel.child.start_kill();
            let _ = kernel.child.wait().await;
        }
    }
}

async fn spawn_outbox_pump(
    mut rx: mpsc::Receiver<KernelIn>,
    stdin: Arc<Mutex<stdio_codec::StdioWriter>>,
    cancel: CancellationToken,
) {
    loop {
        let Some(message) = (tokio::select! {
            _ = cancel.cancelled() => None,
            message = rx.recv() => message,
        }) else {
            break;
        };
        let value = match serde_json::to_value(&message) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, "failed to serialize native-pipe kernel frame");
                continue;
            }
        };
        if stdin.lock().await.send(&value).await.is_err() {
            break;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn spawn_stdout_demux(
    mut reader: stdio_codec::StdioReader,
    pending_exec_results: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    registry: Arc<Mutex<ExecRegistry>>,
    sink: Arc<Mutex<Option<crate::display_router::ProgressSink>>>,
    broker: Arc<NativePipeBroker>,
    kernel_inbox: mpsc::Sender<KernelIn>,
    handshake_token: Arc<Mutex<Option<String>>>,
    ready_tx: oneshot::Sender<()>,
    cancel: CancellationToken,
) {
    let mut ready_tx = Some(ready_tx);
    loop {
        let frame = tokio::select! {
            _ = cancel.cancelled() => return,
            frame = reader.next() => match frame {
                Ok(Some(frame)) => frame,
                Ok(None) => return,
                Err(error) => {
                    tracing::warn!(%error, "kernel stdout demux failed");
                    return;
                }
            },
        };

        if let Ok(typed) = serde_json::from_value::<KernelOut>(frame.clone()) {
            match typed {
                KernelOut::NativePipeHandshake(handshake) => {
                    *handshake_token.lock().await = Some(handshake.token);
                }
                KernelOut::NativePipeRequest(request) => {
                    let expected = handshake_token.lock().await.clone();
                    if !matches!(
                        expected.as_deref(),
                        Some(token) if constant_time_eq(token.as_bytes(), request.token.as_bytes())
                    ) {
                        tracing::warn!(
                            request_id = %request.id,
                            "native-pipe request rejected: handshake token mismatch"
                        );
                        let _ = kernel_inbox
                            .send(KernelIn::NativePipeResponse(NativePipeResponse {
                                id: request.id,
                                ok: false,
                                error: Some("native pipe handshake token mismatch".to_string()),
                                result: None,
                            }))
                            .await;
                        continue;
                    }
                    tokio::spawn(broker.clone().dispatch_request(request));
                }
            }
            continue;
        }

        match frame.get("type").and_then(Value::as_str).unwrap_or("") {
            "display" => handle_display_frame(&registry, &sink, frame).await,
            "emit_image" => handle_emit_image_frame(&registry, frame).await,
            "exec_result" => {
                let Some(exec_id) = frame
                    .get("exec_id")
                    .or_else(|| frame.get("id"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                else {
                    tracing::warn!(?frame, "exec_result without exec id");
                    continue;
                };
                if let Some(tx) = pending_exec_results.lock().await.remove(&exec_id) {
                    let _ = tx.send(frame);
                } else {
                    tracing::warn!(%exec_id, "exec_result with no waiter");
                }
            }
            "ready" => {
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(());
                }
            }
            other => tracing::debug!(other, ?frame, "unhandled kernel frame"),
        }
    }
}

async fn handle_display_frame(
    registry: &Arc<Mutex<ExecRegistry>>,
    sink: &Arc<Mutex<Option<crate::display_router::ProgressSink>>>,
    frame: Value,
) {
    let at_ms = frame.get("at_ms").and_then(Value::as_u64).unwrap_or(0);
    let kind = frame
        .get("payload_type")
        .and_then(Value::as_str)
        .unwrap_or("text")
        .to_string();
    let value = frame.get("value").cloned().unwrap_or(Value::Null);
    let progress = {
        let mut registry = registry.lock().await;
        registry.progress_counter += 1;
        registry.displays.push(DisplayEntry {
            at_ms,
            kind: kind.clone(),
            value: value.clone(),
        });
        registry.progress_counter
    };

    let display_kind = crate::display_router::classify(&kind);
    let Some(message) = crate::display_router::to_stream_message(display_kind, &value) else {
        return;
    };
    if let Some(sink) = sink.lock().await.as_ref().cloned() {
        sink(crate::display_router::ProgressFrame { progress, message });
    }
}

async fn handle_emit_image_frame(registry: &Arc<Mutex<ExecRegistry>>, frame: Value) {
    let Some(image_url) = frame.get("image_url").and_then(Value::as_str) else {
        return;
    };
    let mut registry = registry.lock().await;
    registry.progress_counter += 1;
    registry.displays.push(DisplayEntry {
        at_ms: 0,
        kind: "image".to_string(),
        value: json!({ "image_url": image_url }),
    });
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for index in 0..max {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(a ^ b);
    }
    diff == 0
}

fn split_env_paths(name: &str) -> Vec<PathBuf> {
    std::env::var_os(name)
        .map(|raw| std::env::split_paths(&raw).collect())
        .unwrap_or_default()
}

fn split_env_socket_paths(name: &str) -> Result<Option<Vec<PathBuf>>> {
    let Some(raw) = std::env::var_os(name) else {
        return Ok(None);
    };
    let mut paths = Vec::new();
    for path in std::env::split_paths(&raw) {
        if !path.is_absolute() {
            return Err(anyhow!(
                "{name} contains non-absolute socket path: {}",
                path.display()
            ));
        }
        paths.push(
            std::fs::canonicalize(&path)
                .with_context(|| format!("canonicalize {name} path {}", path.display()))?,
        );
    }
    Ok(Some(paths))
}

fn split_env_list(name: &str) -> Vec<String> {
    std::env::var(name)
        .ok()
        .map(|raw| {
            raw.split(':')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Default)]
struct BackendInventory {
    backends: Vec<DiscoveredBackend>,
    diagnostics: Vec<BackendDiscoveryDiagnostic>,
    auth_tokens: HashMap<PathBuf, String>,
}

enum RuntimeDescriptorRead {
    Usable(DiscoveredBackend, PathBuf, String),
    Ignored(String),
}

fn discover_backend_inventory() -> BackendInventory {
    let mut inventory = BackendInventory {
        backends: parse_backends_env(),
        diagnostics: Vec::new(),
        auth_tokens: HashMap::new(),
    };
    discover_runtime_descriptors(&mut inventory);
    inventory
}

fn parse_backends_env() -> Vec<DiscoveredBackend> {
    let raw = std::env::var("OBU_BACKENDS")
        .ok()
        .or_else(|| std::env::var("OBU_EXTRA_BACKENDS").ok())
        .unwrap_or_default();
    raw.split(';')
        .filter_map(|entry| {
            let entry = entry.trim();
            if entry.is_empty() {
                return None;
            }
            let mut parts = entry.splitn(3, ':');
            let kind = parts.next()?.trim();
            let name = parts.next()?.trim();
            let socket_path = parts.next()?.trim();
            if kind.is_empty() || name.is_empty() || socket_path.is_empty() {
                tracing::warn!(entry, "ignoring malformed OBU_BACKENDS entry");
                return None;
            }
            Some(DiscoveredBackend {
                kind: kind.to_string(),
                name: name.to_string(),
                socket_path: socket_path.to_string(),
                metadata: None,
            })
        })
        .collect()
}

fn discover_runtime_descriptors(inventory: &mut BackendInventory) {
    let root = runtime_dir();
    if let Err(error) = validate_runtime_root(&root) {
        tracing::warn!(path = %root.display(), %error, "ignoring runtime backend root");
        inventory.diagnostics.push(BackendDiscoveryDiagnostic {
            source: root.display().to_string(),
            reason: error.to_string(),
        });
        return;
    }
    let dir = root.join("webextension");
    if let Err(error) = validate_runtime_descriptor_dir(&dir) {
        tracing::warn!(path = %dir.display(), %error, "ignoring runtime backend descriptor directory");
        inventory.diagnostics.push(BackendDiscoveryDiagnostic {
            source: dir.display().to_string(),
            reason: error.to_string(),
        });
        return;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match read_runtime_descriptor(&path) {
            Ok(RuntimeDescriptorRead::Usable(backend, canonical_socket, token)) => {
                inventory.backends.push(backend);
                inventory.auth_tokens.insert(canonical_socket, token);
            }
            Ok(RuntimeDescriptorRead::Ignored(reason)) => {
                tracing::warn!(path = %path.display(), reason = %reason, "ignoring runtime backend descriptor");
                inventory.diagnostics.push(BackendDiscoveryDiagnostic {
                    source: path.display().to_string(),
                    reason,
                });
            }
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "ignoring runtime backend descriptor");
                inventory.diagnostics.push(BackendDiscoveryDiagnostic {
                    source: path.display().to_string(),
                    reason: error.to_string(),
                });
            }
        }
    }
}

fn read_runtime_descriptor(path: &std::path::Path) -> Result<RuntimeDescriptorRead> {
    validate_descriptor_file(path)?;

    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("read descriptor {}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parse descriptor {}", path.display()))?;
    if value.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Ok(RuntimeDescriptorRead::Ignored(format!(
            "unsupported schema_version {}",
            value
                .get("schema_version")
                .map(Value::to_string)
                .unwrap_or_else(|| "missing".to_string())
        )));
    }
    if value.get("type").and_then(Value::as_str) != Some("webextension") {
        return Ok(RuntimeDescriptorRead::Ignored(format!(
            "unsupported descriptor type {}",
            value
                .get("type")
                .map(Value::to_string)
                .unwrap_or_else(|| "missing".to_string())
        )));
    }

    let Some(socket_path) = value.get("socketPath").and_then(Value::as_str) else {
        return Ok(RuntimeDescriptorRead::Ignored(
            "socketPath missing".to_string(),
        ));
    };
    let Some(token) = value.get("sdk_auth_token").and_then(Value::as_str) else {
        return Ok(RuntimeDescriptorRead::Ignored(
            "sdk_auth_token missing".to_string(),
        ));
    };
    let canonical_socket = validate_descriptor_socket(socket_path)?;
    if !descriptor_process_alive(&value) {
        let _ = std::fs::remove_file(path);
        return Ok(RuntimeDescriptorRead::Ignored(
            "descriptor process is not alive".to_string(),
        ));
    }
    if !probe_runtime_descriptor(&canonical_socket, token, &value) {
        let _ = std::fs::remove_file(path);
        return Ok(RuntimeDescriptorRead::Ignored(
            "descriptor probe failed".to_string(),
        ));
    }
    let mut metadata = value.get("metadata").cloned();
    if let Some(meta) = metadata.as_mut().and_then(Value::as_object_mut)
        && let Some(started_at) = value.get("startedAt")
    {
        meta.insert("startedAt".to_string(), started_at.clone());
    }

    let backend = DiscoveredBackend {
        kind: "webextension".to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("chrome")
            .to_string(),
        socket_path: canonical_socket.to_string_lossy().to_string(),
        metadata,
    };
    Ok(RuntimeDescriptorRead::Usable(
        backend,
        canonical_socket,
        token.to_string(),
    ))
}

fn validate_runtime_root(path: &Path) -> Result<()> {
    match validate_owner_only_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn validate_runtime_descriptor_dir(path: &Path) -> Result<()> {
    match validate_owner_only_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
fn validate_descriptor_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(anyhow!("descriptor is a symlink"));
    }
    if metadata.uid() != current_uid()? {
        return Err(anyhow!("descriptor is not owned by current user"));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(anyhow!("descriptor permissions must be owner-only"));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_descriptor_file(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn validate_descriptor_socket(raw: &str) -> Result<PathBuf> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    let canonical = std::fs::canonicalize(raw)
        .with_context(|| format!("canonicalize descriptor socket {raw}"))?;
    let metadata = std::fs::metadata(&canonical)
        .with_context(|| format!("stat descriptor socket {}", canonical.display()))?;
    if !metadata.file_type().is_socket() {
        return Err(anyhow!("descriptor socket path is not a socket"));
    }
    if metadata.uid() != current_uid()? {
        return Err(anyhow!("descriptor socket is not owned by current user"));
    }
    let mode = metadata.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(anyhow!("descriptor socket permissions must be owner-only"));
    }
    Ok(canonical)
}

#[cfg(not(unix))]
fn validate_descriptor_socket(raw: &str) -> Result<PathBuf> {
    std::fs::canonicalize(raw).with_context(|| format!("canonicalize descriptor socket {raw}"))
}

#[cfg(unix)]
fn current_uid() -> Result<u32> {
    let output = std::process::Command::new("id")
        .arg("-u")
        .output()
        .context("run id -u")?;
    if !output.status.success() {
        return Err(anyhow!("id -u failed with status {}", output.status));
    }
    let raw = std::str::from_utf8(&output.stdout)
        .context("parse id -u output as utf-8")?
        .trim();
    raw.parse::<u32>().context("parse id -u output")
}

#[cfg(unix)]
fn descriptor_process_alive(value: &Value) -> bool {
    let Some(pid) = value.get("pid").and_then(Value::as_u64) else {
        return false;
    };
    if pid == 0 || pid > i32::MAX as u64 {
        return false;
    }
    let Ok(output) = std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .output()
    else {
        return false;
    };
    output.status.success()
        || std::str::from_utf8(&output.stderr)
            .map(|stderr| stderr.contains("Operation not permitted"))
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn descriptor_process_alive(_value: &Value) -> bool {
    true
}

#[cfg(unix)]
fn probe_runtime_descriptor(socket: &Path, token: &str, descriptor: &Value) -> bool {
    match probe_runtime_descriptor_inner(socket, token, descriptor) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(socket = %socket.display(), %error, "runtime backend descriptor probe failed");
            false
        }
    }
}

#[cfg(unix)]
fn probe_runtime_descriptor_inner(socket: &Path, token: &str, descriptor: &Value) -> Result<()> {
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket)
        .with_context(|| format!("connect descriptor socket {}", socket.display()))?;
    let timeout = Some(Duration::from_millis(500));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;

    write_probe_frame(
        &mut stream,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "auth",
            "params": { "capability_token": token },
        }),
    )?;
    let auth = read_probe_frame(&mut stream)?;
    if auth.get("error").is_some() {
        return Err(anyhow!("descriptor socket auth rejected"));
    }

    write_probe_frame(
        &mut stream,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "getInfo",
            "params": {},
        }),
    )?;
    let info = read_probe_frame(&mut stream)?;
    if let Some(error) = info.get("error") {
        return Err(anyhow!("getInfo failed during descriptor probe: {error}"));
    }
    let result = info
        .get("result")
        .ok_or_else(|| anyhow!("getInfo descriptor probe missing result"))?;
    let expected_name = descriptor
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("chrome");
    if result.get("type").and_then(Value::as_str) != Some("webextension") {
        return Err(anyhow!("getInfo type does not match descriptor"));
    }
    if result.get("name").and_then(Value::as_str) != Some(expected_name) {
        return Err(anyhow!("getInfo name does not match descriptor"));
    }
    if let Some(expected_metadata) = descriptor.get("metadata")
        && result.pointer("/metadata/backend") != Some(expected_metadata)
    {
        return Err(anyhow!("getInfo metadata does not match descriptor"));
    }
    Ok(())
}

#[cfg(unix)]
fn write_probe_frame(stream: &mut impl std::io::Write, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let len = u32::try_from(bytes.len()).map_err(|_| anyhow!("probe frame too large"))?;
    stream.write_all(&len.to_le_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

#[cfg(unix)]
fn read_probe_frame(stream: &mut impl std::io::Read) -> Result<Value> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > 1024 * 1024 {
        return Err(anyhow!("probe frame too large"));
    }
    let mut bytes = vec![0u8; len];
    stream.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).context("parse descriptor probe response")
}

#[cfg(not(unix))]
fn probe_runtime_descriptor(_socket: &Path, _token: &str, _descriptor: &Value) -> bool {
    true
}

fn runtime_dir() -> PathBuf {
    resolve_runtime_dir()
}

fn seed_sdk_trust(
    module_dirs: &[PathBuf],
    trusted_code_paths: &mut Vec<PathBuf>,
    trusted_module_sha256s: &mut Vec<String>,
) -> Result<()> {
    for module_dir in module_dirs {
        let candidate =
            if module_dir.file_name().and_then(|name| name.to_str()) == Some("node_modules") {
                module_dir.join("@open-browser-use").join("sdk")
            } else {
                module_dir
                    .join("node_modules")
                    .join("@open-browser-use")
                    .join("sdk")
            };
        if !candidate.join("package.json").exists() {
            continue;
        }
        let sdk = crate::sdk_discovery::discover_at(&candidate)?;
        if !trusted_code_paths.contains(&sdk.dir) {
            trusted_code_paths.push(sdk.dir);
        }
        if !trusted_module_sha256s.contains(&sdk.hash) {
            trusted_module_sha256s.push(sdk.hash);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn native_pipe_token_compare_requires_exact_match() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(!constant_time_eq(b"token", b"tokem"));
        assert!(!constant_time_eq(b"token", b"token-extra"));
        assert!(!constant_time_eq(b"token", b""));
    }
}
