//! REPL manager for the Node child running `kernel.js`.

pub mod kernel_state;
pub mod node_version;
pub mod runtime_descriptor_lifecycle;
pub mod spawn;
pub mod stdio_codec;

pub use kernel_state::{
    DisplayEntry, ExecRegistry, JsExecResult, KernelState, MAX_DISPLAY_COUNT, TruncationInfo,
};
pub use node_version::{NodeVersion, required_node_version, resolve_compatible_node};
pub use runtime_descriptor_lifecycle::{
    RuntimeDescriptorReadIssue, RuntimeDescriptorReadReasonCode, RuntimeDescriptorReadState,
    RuntimeDescriptorSetupIssue, RuntimeDescriptorSetupReasonCode, RuntimeDescriptorSetupState,
    plan_runtime_descriptor_ignored, plan_runtime_descriptor_setup, plan_runtime_descriptor_usable,
    rendered_descriptor_value,
};
pub use spawn::{SpawnOptions, SpawnedKernel};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use crate::native_pipe::{
    broker::NativePipeBroker,
    protocol::{KernelIn, KernelOut, NativePipeResponse},
};
use anyhow::{Context, Result, anyhow};
use obu_wire::runtime_dir::{resolve_runtime_dir, validate_owner_only_dir};
use serde::{Deserialize, Serialize};
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
    /// Whether `js_reset` should refresh runtime descriptors before the next kernel boot.
    pub dynamic_backend_discovery: bool,
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
    /// Runtime descriptor lifecycle state when the diagnostic came from descriptor discovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_state: Option<RuntimeDescriptorReadState>,
    /// Stable runtime descriptor diagnostic reason code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<RuntimeDescriptorReadReasonCode>,
    /// Runtime descriptor setup lifecycle state when discovery failed before descriptor read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_lifecycle_state: Option<RuntimeDescriptorSetupState>,
    /// Stable runtime descriptor setup reason code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_reason_code: Option<RuntimeDescriptorSetupReasonCode>,
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
            default_timeout: Duration::from_secs(90),
            backends: inventory.backends,
            backend_discovery_diagnostics: inventory.diagnostics,
            backend_auth_tokens: inventory.auth_tokens,
            dynamic_backend_discovery: true,
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
            default_timeout: Duration::from_secs(90),
            backends: Vec::new(),
            backend_discovery_diagnostics: Vec::new(),
            backend_auth_tokens: HashMap::new(),
            dynamic_backend_discovery: false,
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

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AgentRuntimeKernelLifecycle {
    Idle {
        generation: u64,
    },
    Spawning {
        generation: u64,
    },
    Ready {
        generation: u64,
    },
    Executing {
        generation: u64,
        exec_id: String,
        turn_id: String,
    },
    Restarting {
        previous_generation: u64,
    },
    Failed {
        generation: u64,
        stage: &'static str,
        error_message: String,
        recovered: bool,
    },
}

/// Orchestrates one persistent JavaScript kernel.
pub struct JsRuntimeManager {
    options: ManagerOptions,
    state: Mutex<KernelState>,
    kernel_lifecycle: Mutex<AgentRuntimeKernelLifecycle>,
    kernel_generation: Mutex<u64>,
    lifecycle: Mutex<()>,
    kernel: Mutex<Option<SpawnedKernel>>,
    registry: Arc<Mutex<ExecRegistry>>,
    sink: Arc<Mutex<Option<crate::display_router::ProgressSink>>>,
    module_dirs: StdMutex<Vec<PathBuf>>,
    backend_state: StdMutex<BackendInventory>,
    broker_policy: BrokerPolicy,
    generation: Mutex<Option<KernelGeneration>>,
    /// Set by the native-pipe broker when a brokered connection drops, and
    /// consumed by the exec path to re-discover the live backend descriptor
    /// before the next exec so cached SDK handles reconnect to the new socket.
    backend_inventory_dirty: Arc<AtomicBool>,
}

impl JsRuntimeManager {
    /// Construct a manager. Call `boot` to eagerly spawn, or `exec` to spawn on
    /// first use.
    pub async fn new(options: ManagerOptions) -> Result<Self> {
        let backend_state = BackendInventory {
            backends: options.backends.clone(),
            diagnostics: options.backend_discovery_diagnostics.clone(),
            auth_tokens: options.backend_auth_tokens.clone(),
        };
        Ok(Self {
            module_dirs: StdMutex::new(options.module_dirs.clone()),
            backend_state: StdMutex::new(backend_state),
            options,
            state: Mutex::new(KernelState::Idle),
            kernel_lifecycle: Mutex::new(AgentRuntimeKernelLifecycle::Idle { generation: 0 }),
            kernel_generation: Mutex::new(0),
            lifecycle: Mutex::new(()),
            kernel: Mutex::new(None),
            registry: Arc::new(Mutex::new(ExecRegistry::default())),
            sink: Arc::new(Mutex::new(None)),
            broker_policy: BrokerPolicy::from_env()?,
            generation: Mutex::new(None),
            backend_inventory_dirty: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Session identifier for this MCP/kernel session.
    pub fn session_id(&self) -> &str {
        &self.options.session_id
    }

    /// Read-only browser-use readiness status for MCP clients.
    pub async fn browser_status(&self) -> Result<Value> {
        if self.options.dynamic_backend_discovery {
            self.refresh_backend_inventory().await?;
        }
        let inventory = self.backend_inventory();
        self.sync_backend_inventory_to_kernel(&inventory).await?;
        let (sdk_bootstrap, sdk_bootstrap_detail) = self.sdk_bootstrap_status();
        let product_error = browser_status_product_error(sdk_bootstrap, &inventory);
        let (verify_hint, doctor_hint) = browser_status_hints(product_error.as_ref());
        let advisories = browser_status_advisories(&inventory);
        Ok(json!({
            "sdk_bootstrap": sdk_bootstrap,
            "sdk_bootstrap_detail": sdk_bootstrap_detail,
            "kernel_lifecycle": self.kernel_lifecycle.lock().await.clone(),
            "kernel_generation": *self.kernel_generation.lock().await,
            "backends": inventory.backends,
            "diagnostics": inventory.diagnostics,
            "runtime_dir": runtime_dir().to_string_lossy(),
            "verify_hint": verify_hint,
            "doctor_hint": doctor_hint,
            "product_error": product_error,
            "advisories": advisories,
        }))
    }

    /// Spawn the Node child if it is not already ready.
    pub async fn boot(&self) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        self.boot_locked().await
    }

    async fn boot_locked(&self) -> Result<()> {
        {
            let mut state = self.state.lock().await;
            if *state == KernelState::Ready {
                return Ok(());
            }
            *state = KernelState::Spawning;
        }
        let next_generation = *self.kernel_generation.lock().await + 1;
        *self.kernel_lifecycle.lock().await = AgentRuntimeKernelLifecycle::Spawning {
            generation: next_generation,
        };

        let inventory = self.backend_inventory();
        let spawn_opts = SpawnOptions {
            session_id: self.options.session_id.clone(),
            working_dir: self.options.working_dir.clone(),
            module_dirs: self.module_dirs.lock().expect("module dir lock").clone(),
            trusted_code_paths: self.options.trusted_code_paths.clone(),
            trusted_module_sha256s: self.options.trusted_module_sha256s.clone(),
            trust_all: self.options.trust_all,
            backends: inventory.backends,
            backend_discovery_diagnostics: inventory.diagnostics,
        };
        let mut kernel = match SpawnedKernel::spawn(spawn_opts).await {
            Ok(kernel) => kernel,
            Err(error) => {
                self.set_kernel_failed(next_generation, "spawn", error.to_string(), false)
                    .await;
                return Err(error).context("spawn JavaScript kernel");
            }
        };
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
            inventory.auth_tokens,
            self.backend_inventory_dirty.clone(),
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
            kernel_stdin.clone(),
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
        if let Err(error) = self.wait_for_ready().await {
            self.set_kernel_failed(next_generation, "ready", error.to_string(), false)
                .await;
            return Err(error);
        }
        *self.state.lock().await = KernelState::Ready;
        *self.kernel_generation.lock().await = next_generation;
        *self.kernel_lifecycle.lock().await = AgentRuntimeKernelLifecycle::Ready {
            generation: next_generation,
        };
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
        self.exec_with_turn_id_and_progress_sink(source, timeout_ms, client_turn_id, None)
            .await
    }

    /// Execute JavaScript and install a progress sink only while this exec owns the kernel.
    pub async fn exec_with_turn_id_and_progress_sink(
        &self,
        source: &str,
        timeout_ms: Option<u64>,
        client_turn_id: Option<String>,
        progress_sink: Option<crate::display_router::ProgressSink>,
    ) -> Result<JsExecResult> {
        let _lifecycle = self
            .lifecycle
            .try_lock()
            .map_err(|_| anyhow!("kernel is busy"))?;
        // If the broker saw a disconnect, re-discover the live backend BEFORE any
        // (re)boot so a fresh kernel spawns with — and a live kernel is re-synced
        // to — the current socket/token. This is what lets cached SDK handles
        // transparently reconnect after a host restart.
        self.refresh_backend_inventory_if_disconnected().await?;
        // KernelState::Failed and KernelState::Idle both trigger a re-boot here.
        if *self.state.lock().await != KernelState::Ready {
            self.boot_locked().await?;
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
        let generation = *self.kernel_generation.lock().await;
        *self.kernel_lifecycle.lock().await = AgentRuntimeKernelLifecycle::Executing {
            generation,
            exec_id: exec_id.clone(),
            turn_id: turn_id.clone(),
        };
        let installed_progress_sink = progress_sink.is_some();
        if let Some(sink) = progress_sink {
            self.set_progress_sink(Some(sink)).await;
        }
        let outcome = self
            .exec_inner(source, timeout_ms, &exec_id, &turn_id, generation)
            .await;
        if installed_progress_sink {
            self.set_progress_sink(None).await;
        }
        match &outcome {
            Ok(_) => {
                *self.state.lock().await = KernelState::Ready;
                *self.kernel_lifecycle.lock().await =
                    AgentRuntimeKernelLifecycle::Ready { generation };
            }
            Err(_) => {
                self.kill_kernel().await;
                self.set_kernel_failed(
                    generation,
                    "exec",
                    outcome
                        .as_ref()
                        .err()
                        .map(ToString::to_string)
                        .unwrap_or_default(),
                    true,
                )
                .await;
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
        generation: u64,
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
                },
                "x-obu-runtime-metadata": {
                    "kernel_generation": generation,
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

    async fn sync_backend_inventory_to_kernel(&self, inventory: &BackendInventory) -> Result<()> {
        let Some((native_pipe, writer)) = self.generation.lock().await.as_ref().map(|generation| {
            (
                generation.native_pipe.clone(),
                generation.kernel_stdin.clone(),
            )
        }) else {
            return Ok(());
        };

        native_pipe.set_capability_tokens_by_path(inventory.auth_tokens.clone());
        writer
            .lock()
            .await
            .send(&json!({
                "type": "set_backend_inventory",
                "backends": inventory.backends,
                "backend_diagnostics": inventory.diagnostics,
            }))
            .await
            .context("send backend inventory to kernel")?;
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

        let error = if frame.get("ok").and_then(Value::as_bool) == Some(false) {
            Some(
                frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("JavaScript execution failed")
                    .to_string(),
            )
        } else {
            None
        };
        let (displays, displays_total) = self.registry.lock().await.finish();
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
            truncated: TruncationInfo::default(),
            displays,
            displays_total,
            response_meta: frame
                .get("response_meta")
                .filter(|value| !value.is_null())
                .cloned(),
            error,
            error_detail: frame
                .get("error_detail")
                .filter(|value| !value.is_null())
                .cloned(),
        })
    }

    /// Restart the kernel and clear REPL state.
    pub async fn reset(&self) -> Result<()> {
        let _lifecycle = self.lifecycle.lock().await;
        let previous_generation = *self.kernel_generation.lock().await;
        *self.state.lock().await = KernelState::Restarting;
        *self.kernel_lifecycle.lock().await = AgentRuntimeKernelLifecycle::Restarting {
            previous_generation,
        };
        self.kill_kernel().await;
        *self.registry.lock().await = ExecRegistry::default();
        self.refresh_backend_inventory().await?;
        *self.state.lock().await = KernelState::Idle;
        self.boot_locked().await
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

    fn sdk_bootstrap_status(&self) -> (&'static str, Value) {
        let candidates = sdk_candidate_roots(&self.options.working_dir, &self.options.module_dirs);
        let searched = candidates
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let mut diagnostics = Vec::new();
        for candidate in candidates {
            if !candidate.join("package.json").exists() {
                continue;
            }
            match crate::sdk_discovery::discover_at(&candidate) {
                Ok(info) => {
                    let trusted_by_path = self
                        .options
                        .trusted_code_paths
                        .iter()
                        .any(|trusted| is_same_or_within_dir(&info.dir, trusted));
                    let trusted_by_hash = self.options.trusted_module_sha256s.contains(&info.hash);
                    let trusted = self.options.trust_all || trusted_by_path || trusted_by_hash;
                    let detail = json!({
                        "status": if trusted { "available" } else { "untrusted" },
                        "path": info.dir.to_string_lossy(),
                        "version": info.version,
                        "trusted_by": {
                            "trust_all": self.options.trust_all,
                            "path": trusted_by_path,
                            "hash": trusted_by_hash,
                        },
                        "searched": searched,
                    });
                    return (if trusted { "available" } else { "untrusted" }, detail);
                }
                Err(error) => diagnostics.push(json!({
                    "path": candidate.to_string_lossy(),
                    "reason": error.to_string(),
                })),
            }
        }
        if diagnostics.is_empty() {
            (
                "missing",
                json!({
                    "status": "missing",
                    "searched": searched,
                }),
            )
        } else {
            (
                "untrusted",
                json!({
                    "status": "untrusted",
                    "searched": searched,
                    "diagnostics": diagnostics,
                }),
            )
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

    /// Single failure transition point: atomically writes both `kernel_lifecycle`
    /// and the coarse `state` field.
    ///
    /// Order: `kernel_lifecycle` is written first, then `state`.  This ensures
    /// that any reader who observes the coarse `Failed` or `Idle` state will
    /// also see a fully-populated `AgentRuntimeKernelLifecycle::Failed` variant.
    ///
    /// `recovered: true` means the kernel was killed after a bad exec and the
    /// next call to `exec` (or `boot`) will re-boot a fresh child; the coarse
    /// state is set to `Idle` (re-bootable).
    ///
    /// `recovered: false` means the spawn or ready-handshake attempt left no
    /// usable child process; the coarse state is set to `Failed` (not
    /// re-bootable without an explicit reset).
    async fn set_kernel_failed(
        &self,
        generation: u64,
        stage: &'static str,
        error_message: String,
        recovered: bool,
    ) {
        *self.kernel_lifecycle.lock().await = AgentRuntimeKernelLifecycle::Failed {
            generation,
            stage,
            error_message,
            recovered,
        };
        // Coarse state is a derived compatibility view: a recovered exec failure
        // returns to Idle (re-bootable); spawn/ready failure parks at Failed.
        *self.state.lock().await = if recovered {
            KernelState::Idle
        } else {
            KernelState::Failed
        };
    }

    #[cfg(test)]
    pub(super) async fn coarse_state_for_tests(&self) -> KernelState {
        *self.state.lock().await
    }

    #[cfg(test)]
    fn mark_backend_inventory_dirty_for_tests(&self) {
        self.backend_inventory_dirty.store(true, Ordering::Relaxed);
    }

    #[cfg(test)]
    fn backend_inventory_dirty_for_tests(&self) -> bool {
        self.backend_inventory_dirty.load(Ordering::Relaxed)
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

    fn backend_inventory(&self) -> BackendInventory {
        if self.options.dynamic_backend_discovery {
            self.backend_state
                .lock()
                .expect("backend inventory lock")
                .clone()
        } else {
            BackendInventory {
                backends: self.options.backends.clone(),
                diagnostics: self.options.backend_discovery_diagnostics.clone(),
                auth_tokens: self.options.backend_auth_tokens.clone(),
            }
        }
    }

    async fn refresh_backend_inventory(&self) -> Result<()> {
        if !self.options.dynamic_backend_discovery {
            return Ok(());
        }
        let inventory = tokio::task::spawn_blocking(discover_backend_inventory)
            .await
            .context("refresh browser backend inventory task failed")?;
        *self.backend_state.lock().expect("backend inventory lock") = inventory;
        Ok(())
    }

    /// When the native-pipe broker has observed a disconnect (host restart or MV3
    /// service-worker recycle), re-scan runtime descriptors and republish the live
    /// inventory + capability tokens to the kernel. Cheap on the hot path: the
    /// (probe-backed) re-discovery runs only after an actual disconnect, so the
    /// next exec's cached SDK handles reconnect to the new socket instead of
    /// failing with `ERR_TRANSPORT_CLOSED`.
    async fn refresh_backend_inventory_if_disconnected(&self) -> Result<()> {
        // Peek, don't consume: the broker clears the flag only when a connection
        // is successfully re-established, so every exec keeps re-discovering until
        // the restarted host is reachable (handles slow host relaunch).
        if !self.backend_inventory_dirty.load(Ordering::Relaxed) {
            return Ok(());
        }
        self.refresh_backend_inventory().await?;
        let inventory = self.backend_inventory();
        self.sync_backend_inventory_to_kernel(&inventory).await?;
        Ok(())
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
        let line = match stdio_codec::encode_line(&message) {
            Ok(line) => line,
            Err(error) => {
                tracing::warn!(%error, "failed to serialize native-pipe kernel frame");
                continue;
            }
        };
        if stdin.lock().await.send_line(&line).await.is_err() {
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
    kernel_stdin: Arc<Mutex<stdio_codec::StdioWriter>>,
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
            "emit_image" => handle_emit_image_frame(&registry, &kernel_stdin, frame).await,
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
        registry.push_display(DisplayEntry {
            at_ms,
            kind: kind.clone(),
            value: value.clone(),
        })
    };

    let display_kind = crate::display_router::classify(&kind);
    let Some(message) = crate::display_router::to_stream_message(display_kind, &value) else {
        return;
    };
    if let Some(sink) = sink.lock().await.as_ref().cloned() {
        sink(crate::display_router::ProgressFrame { progress, message });
    }
}

async fn handle_emit_image_frame(
    registry: &Arc<Mutex<ExecRegistry>>,
    kernel_stdin: &Arc<Mutex<stdio_codec::StdioWriter>>,
    frame: Value,
) {
    let Some(id) = frame
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    let Some(image_url) = frame.get("image_url").and_then(Value::as_str) else {
        let _ = kernel_stdin
            .lock()
            .await
            .send(&json!({
                "type": "emit_image_result",
                "id": id,
                "ok": false,
                "error": "emit_image missing image_url"
            }))
            .await;
        return;
    };
    {
        let mut registry = registry.lock().await;
        registry.push_display(DisplayEntry {
            at_ms: 0,
            kind: "image".to_string(),
            value: json!({ "image_url": image_url }),
        });
    }
    let _ = kernel_stdin
        .lock()
        .await
        .send(&json!({
            "type": "emit_image_result",
            "id": id,
            "ok": true
        }))
        .await;
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

#[derive(Clone, Default)]
struct BackendInventory {
    backends: Vec<DiscoveredBackend>,
    diagnostics: Vec<BackendDiscoveryDiagnostic>,
    auth_tokens: HashMap<PathBuf, String>,
}

const VERIFY_HINT: &str = "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>";
const VERIFY_REPAIR_HINT: &str = "obu verify --repair --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>";
const DOCTOR_BROWSER_REPAIR_HINT: &str = "obu doctor browser --repair";
const OPEN_POPUP_HINT: &str =
    "Open the open-browser-use pairing page, click Resume if enabled, then rerun verify.";

fn browser_status_product_error(
    sdk_bootstrap: &str,
    inventory: &BackendInventory,
) -> Option<Value> {
    if sdk_bootstrap != "available" {
        return Some(product_error("setup_missing"));
    }
    if inventory.backends.is_empty() && !inventory.diagnostics.is_empty() {
        if inventory.diagnostics.iter().any(|diagnostic| {
            diagnostic.setup_reason_code
                == Some(RuntimeDescriptorSetupReasonCode::DescriptorMissing)
        }) {
            return Some(product_error("browser_popup_boundary"));
        }
        if inventory
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.setup_lifecycle_state.is_some())
        {
            return Some(product_error("setup_missing"));
        }
        if inventory.diagnostics.iter().any(|diagnostic| {
            diagnostic.lifecycle_state == Some(RuntimeDescriptorReadState::Invalid)
        }) {
            return Some(product_error("invalid_descriptor"));
        }
        if inventory
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.lifecycle_state == Some(RuntimeDescriptorReadState::Stale))
        {
            return Some(product_error("stale_descriptor"));
        }
        return Some(product_error("setup_missing"));
    }
    if inventory.backends.is_empty() {
        return Some(product_error("browser_popup_boundary"));
    }
    None
}

#[derive(Deserialize)]
struct ProductErrorSchema {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    errors: Vec<ProductErrorSchemaEntry>,
}

#[derive(Deserialize)]
struct ProductErrorSchemaEntry {
    code: String,
    title: String,
    summary: String,
    #[serde(rename = "nextAction")]
    next_action: ProductErrorSchemaNextAction,
}

#[derive(Deserialize)]
struct ProductErrorSchemaNextAction {
    kind: String,
    summary: String,
    command: Option<String>,
}

fn product_error_entry(code: &str) -> &'static ProductErrorSchemaEntry {
    static PRODUCT_ERROR_ENTRIES: OnceLock<Vec<ProductErrorSchemaEntry>> = OnceLock::new();
    PRODUCT_ERROR_ENTRIES
        .get_or_init(|| {
            let schema: ProductErrorSchema =
                serde_json::from_str(include_str!("../../../../product-errors.json"))
                    .expect("product-errors.json parses");
            assert_eq!(
                schema.schema_version, 1,
                "product-errors.json schema version"
            );
            schema.errors
        })
        .iter()
        .find(|entry| entry.code == code)
        .unwrap_or_else(|| panic!("missing product error schema entry {code}"))
}

fn product_error(code: &str) -> Value {
    let entry = product_error_entry(code);
    json!({
        "code": entry.code,
        "title": entry.title,
        "summary": entry.summary,
        "next_action": {
            "kind": entry.next_action.kind,
            "summary": entry.next_action.summary,
            "command": entry.next_action.command,
        }
    })
}

fn browser_status_hints(product_error: Option<&Value>) -> (&'static str, &'static str) {
    let code = product_error
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str);
    match code {
        Some("setup_missing") => (VERIFY_REPAIR_HINT, DOCTOR_BROWSER_REPAIR_HINT),
        Some("invalid_descriptor") => (VERIFY_REPAIR_HINT, DOCTOR_BROWSER_REPAIR_HINT),
        Some("stale_descriptor") => (VERIFY_HINT, DOCTOR_BROWSER_REPAIR_HINT),
        Some("browser_popup_boundary") => (OPEN_POPUP_HINT, DOCTOR_BROWSER_REPAIR_HINT),
        _ => (VERIFY_HINT, DOCTOR_BROWSER_REPAIR_HINT),
    }
}

fn browser_status_advisories(inventory: &BackendInventory) -> Vec<Value> {
    let mut advisories = Vec::new();
    for backend in &inventory.backends {
        let Some(pending_update) = backend
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.pointer("/diagnostics/extension/pending_update"))
            .filter(|value| value.is_object())
        else {
            continue;
        };
        advisories.push(json!({
            "code": "pending_extension_update",
            "title": "Extension update pending",
            "summary": "The WebExtension has an update waiting for browser control to become idle.",
            "backend": backend.name,
            "pending_update": pending_update,
        }));
    }
    for backend in &inventory.backends {
        let Some(overlay_release) = backend
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.pointer("/diagnostics/extension/overlay_release"))
            .and_then(|value| value.as_array())
            .filter(|rows| !rows.is_empty())
        else {
            continue;
        };
        advisories.push(json!({
            "code": "overlay_release_pending",
            "title": "Overlay release pending",
            "summary": "The WebExtension still has pending or failed overlay release cleanup.",
            "backend": backend.name,
            "overlay_release": overlay_release,
        }));
    }
    advisories
}

enum RuntimeDescriptorRead {
    Usable(DiscoveredBackend, PathBuf, String),
    Ignored(runtime_descriptor_lifecycle::RuntimeDescriptorIgnoredPlan),
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
        let issue = runtime_root_setup_issue(&error);
        push_setup_diagnostic(inventory, &root, issue);
        return;
    }
    let dir = root.join("webextension");
    if let Err(error) = validate_runtime_descriptor_dir(&dir) {
        tracing::warn!(path = %dir.display(), %error, "ignoring runtime backend descriptor directory");
        let issue = descriptor_dir_setup_issue(&error);
        push_setup_diagnostic(inventory, &dir, issue);
        return;
    }
    let Ok(entries) = std::fs::read_dir(&dir) else {
        push_setup_diagnostic(
            inventory,
            &dir,
            RuntimeDescriptorSetupIssue::DescriptorDirUnreadable {
                reason: "runtime descriptor directory cannot be read".to_string(),
            },
        );
        return;
    };
    let mut descriptor_count = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        descriptor_count += 1;
        match read_runtime_descriptor(&path) {
            Ok(RuntimeDescriptorRead::Usable(backend, canonical_socket, token)) => {
                inventory.backends.push(backend);
                inventory.auth_tokens.insert(canonical_socket, token);
            }
            Ok(RuntimeDescriptorRead::Ignored(plan)) => {
                tracing::warn!(path = %path.display(), reason = %plan.reason, lifecycle_state = ?plan.lifecycle_state, reason_code = ?plan.reason_code, "ignoring runtime backend descriptor");
                inventory.diagnostics.push(BackendDiscoveryDiagnostic {
                    source: path.display().to_string(),
                    reason: plan.reason,
                    lifecycle_state: Some(plan.lifecycle_state),
                    reason_code: Some(plan.reason_code),
                    setup_lifecycle_state: None,
                    setup_reason_code: None,
                });
            }
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "ignoring runtime backend descriptor");
                inventory.diagnostics.push(BackendDiscoveryDiagnostic {
                    source: path.display().to_string(),
                    reason: error.to_string(),
                    lifecycle_state: None,
                    reason_code: None,
                    setup_lifecycle_state: None,
                    setup_reason_code: None,
                });
            }
        }
    }
    if descriptor_count == 0 {
        push_setup_diagnostic(
            inventory,
            &dir,
            RuntimeDescriptorSetupIssue::DescriptorMissing,
        );
    }
}

fn push_setup_diagnostic(
    inventory: &mut BackendInventory,
    source: &Path,
    issue: RuntimeDescriptorSetupIssue,
) {
    let plan = plan_runtime_descriptor_setup(issue);
    inventory.diagnostics.push(BackendDiscoveryDiagnostic {
        source: source.display().to_string(),
        reason: plan.reason,
        lifecycle_state: None,
        reason_code: None,
        setup_lifecycle_state: Some(plan.setup_lifecycle_state),
        setup_reason_code: Some(plan.setup_reason_code),
    });
}

fn runtime_root_setup_issue(error: &anyhow::Error) -> RuntimeDescriptorSetupIssue {
    if io_error_kind(error, std::io::ErrorKind::NotFound) {
        return RuntimeDescriptorSetupIssue::RuntimeRootMissing;
    }
    if setup_safety_validation_failed(error) {
        return RuntimeDescriptorSetupIssue::RuntimeRootInvalid {
            reason: error.to_string(),
        };
    }
    if io_error_kind(error, std::io::ErrorKind::PermissionDenied) {
        return RuntimeDescriptorSetupIssue::RuntimeRootUnreadable {
            reason: error.to_string(),
        };
    }
    RuntimeDescriptorSetupIssue::RuntimeRootInvalid {
        reason: error.to_string(),
    }
}

fn descriptor_dir_setup_issue(error: &anyhow::Error) -> RuntimeDescriptorSetupIssue {
    if io_error_kind(error, std::io::ErrorKind::NotFound) {
        return RuntimeDescriptorSetupIssue::DescriptorDirMissing;
    }
    if setup_safety_validation_failed(error) {
        return RuntimeDescriptorSetupIssue::DescriptorDirInvalid {
            reason: error.to_string(),
        };
    }
    if io_error_kind(error, std::io::ErrorKind::PermissionDenied) {
        return RuntimeDescriptorSetupIssue::DescriptorDirUnreadable {
            reason: error.to_string(),
        };
    }
    RuntimeDescriptorSetupIssue::DescriptorDirInvalid {
        reason: error.to_string(),
    }
}

fn io_error_kind(error: &anyhow::Error, kind: std::io::ErrorKind) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|io| io.kind() == kind)
}

fn setup_safety_validation_failed(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("owner-only")
        || message.contains("not owned by current user")
        || message.contains("is a symlink")
        || message.contains("not a directory")
}

fn read_runtime_descriptor(path: &std::path::Path) -> Result<RuntimeDescriptorRead> {
    if let Err(error) = validate_descriptor_file(path) {
        return Ok(RuntimeDescriptorRead::Ignored(
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::DescriptorFileInvalid {
                reason: error.to_string(),
            }),
        ));
    }

    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("read descriptor {}", path.display()))?;
    let value: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            return Ok(RuntimeDescriptorRead::Ignored(
                plan_runtime_descriptor_ignored(
                    RuntimeDescriptorReadIssue::DescriptorJsonInvalid {
                        reason: format!("descriptor_json_invalid: {error}"),
                    },
                ),
            ));
        }
    };
    if value.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Ok(RuntimeDescriptorRead::Ignored(
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::UnsupportedSchemaVersion {
                value: rendered_descriptor_value(value.get("schema_version")),
            }),
        ));
    }
    if value.get("type").and_then(Value::as_str) != Some("webextension") {
        return Ok(RuntimeDescriptorRead::Ignored(
            plan_runtime_descriptor_ignored(
                RuntimeDescriptorReadIssue::UnsupportedDescriptorType {
                    value: rendered_descriptor_value(value.get("type")),
                },
            ),
        ));
    }

    let Some(socket_path) = value.get("socketPath").and_then(Value::as_str) else {
        return Ok(RuntimeDescriptorRead::Ignored(
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::SocketPathMissing),
        ));
    };
    let Some(token) = value.get("sdk_auth_token").and_then(Value::as_str) else {
        return Ok(RuntimeDescriptorRead::Ignored(
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::SdkAuthTokenMissing),
        ));
    };
    let canonical_socket = match validate_descriptor_socket(socket_path) {
        Ok(path) => path,
        Err(error) => {
            return Ok(RuntimeDescriptorRead::Ignored(
                plan_runtime_descriptor_ignored(
                    RuntimeDescriptorReadIssue::DescriptorSocketInvalid {
                        reason: error.to_string(),
                    },
                ),
            ));
        }
    };
    if !descriptor_process_alive(&value) {
        return Ok(RuntimeDescriptorRead::Ignored(
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::DescriptorProcessNotAlive),
        ));
    }
    let Some(probe_result) = probe_runtime_descriptor(&canonical_socket, token, &value) else {
        return Ok(RuntimeDescriptorRead::Ignored(
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::DescriptorProbeFailed),
        ));
    };
    let usable_plan = plan_runtime_descriptor_usable();
    let mut metadata = value.get("metadata").cloned();
    if let Some(meta) = metadata.as_mut().and_then(Value::as_object_mut)
        && let Some(started_at) = value.get("startedAt")
    {
        meta.insert("startedAt".to_string(), started_at.clone());
    }
    if let Some(diagnostics) = probe_result.pointer("/metadata/diagnostics").cloned() {
        let meta = metadata.get_or_insert_with(|| json!({}));
        if let Some(object) = meta.as_object_mut() {
            object.insert("diagnostics".to_string(), diagnostics);
        }
    }
    let meta = metadata.get_or_insert_with(|| json!({}));
    if let Some(object) = meta.as_object_mut() {
        object.insert(
            "runtimeDescriptorLifecycle".to_string(),
            json!({
                "state": usable_plan.lifecycle_state,
            }),
        );
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
    validate_owner_only_dir(path).map_err(Into::into)
}

fn validate_runtime_descriptor_dir(path: &Path) -> Result<()> {
    validate_owner_only_dir(path).map_err(Into::into)
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
    static CURRENT_UID: OnceLock<u32> = OnceLock::new();
    Ok(*CURRENT_UID.get_or_init(|| rustix::process::getuid().as_raw()))
}

#[cfg(unix)]
fn descriptor_process_alive(value: &Value) -> bool {
    let Some(pid) = value.get("pid").and_then(Value::as_u64) else {
        return false;
    };
    if pid == 0 || pid > i32::MAX as u64 {
        return false;
    }
    crate::reaper::process_alive(pid as i32)
}

#[cfg(not(unix))]
fn descriptor_process_alive(_value: &Value) -> bool {
    true
}

#[cfg(unix)]
fn probe_runtime_descriptor(socket: &Path, token: &str, descriptor: &Value) -> Option<Value> {
    match probe_runtime_descriptor_inner(socket, token, descriptor) {
        Ok(result) => Some(result),
        Err(error) => {
            tracing::warn!(socket = %socket.display(), %error, "runtime backend descriptor probe failed");
            None
        }
    }
}

#[cfg(unix)]
fn probe_runtime_descriptor_inner(socket: &Path, token: &str, descriptor: &Value) -> Result<Value> {
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
    Ok(result.clone())
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
fn probe_runtime_descriptor(_socket: &Path, _token: &str, _descriptor: &Value) -> Option<Value> {
    Some(json!({}))
}

fn runtime_dir() -> PathBuf {
    resolve_runtime_dir()
}

fn sdk_candidate_roots(working_dir: &Path, module_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    push_unique(
        &mut candidates,
        working_dir
            .join("node_modules")
            .join("@open-browser-use")
            .join("sdk"),
    );
    for module_dir in module_dirs {
        if module_dir.file_name().and_then(|name| name.to_str()) == Some("node_modules") {
            push_unique(
                &mut candidates,
                module_dir.join("@open-browser-use").join("sdk"),
            );
        } else {
            push_unique(
                &mut candidates,
                module_dir
                    .join("node_modules")
                    .join("@open-browser-use")
                    .join("sdk"),
            );
            push_unique(&mut candidates, module_dir.clone());
        }
    }
    candidates
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

fn is_same_or_within_dir(candidate: &Path, directory: &Path) -> bool {
    let candidate = canonicalize_lossy(candidate);
    let directory = canonicalize_lossy(directory);
    candidate == directory || candidate.starts_with(directory)
}

fn canonicalize_lossy(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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
    use super::{
        AgentRuntimeKernelLifecycle, DiscoveredBackend, JsRuntimeManager, KernelState,
        ManagerOptions, constant_time_eq, current_uid, descriptor_process_alive, product_error,
    };
    use std::path::PathBuf;

    use serde_json::json;

    #[test]
    fn native_pipe_token_compare_requires_exact_match() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(!constant_time_eq(b"token", b"tokem"));
        assert!(!constant_time_eq(b"token", b"token-extra"));
        assert!(!constant_time_eq(b"token", b""));
    }

    #[test]
    fn browser_status_product_error_uses_repo_schema() {
        let error = product_error("browser_popup_boundary");
        assert_eq!(error["title"], "Browser popup action required");
        assert_eq!(error["next_action"]["kind"], "open_popup");
        assert_eq!(
            error["next_action"]["summary"],
            "Open the open-browser-use pairing page, click Resume if enabled, then rerun verify."
        );
    }

    #[tokio::test]
    async fn browser_status_does_not_expose_runtime_descriptor_tokens() {
        let socket_path = PathBuf::from("/tmp/obu-runtime-token-boundary.sock");
        let token = "fixture-sdk-auth-token";
        let mut options = ManagerOptions::for_tests();
        options.backends.push(DiscoveredBackend {
            kind: "webextension".to_string(),
            name: "chrome".to_string(),
            socket_path: socket_path.to_string_lossy().to_string(),
            metadata: Some(json!({ "source": "runtime-descriptor-fixture" })),
        });
        options
            .backend_auth_tokens
            .insert(socket_path.clone(), token.to_string());

        let manager = JsRuntimeManager::new(options).await.unwrap();
        let status = manager.browser_status().await.unwrap();
        let serialized = status.to_string();

        assert_eq!(status["backends"][0]["type"], "webextension");
        assert_eq!(
            status["backends"][0]["socketPath"],
            socket_path.to_string_lossy().as_ref()
        );
        assert!(
            !serialized.contains(token),
            "browser_status must not expose descriptor auth tokens"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_helpers_use_process_syscalls_without_shelling_out() {
        assert_eq!(current_uid().unwrap(), rustix::process::getuid().as_raw(),);
        assert!(descriptor_process_alive(
            &json!({ "pid": std::process::id() })
        ));
        assert!(!descriptor_process_alive(&json!({ "pid": 0 })));
        assert!(!descriptor_process_alive(
            &json!({ "pid": (i32::MAX as u64) + 1 })
        ));
    }

    #[allow(unsafe_code)]
    #[tokio::test]
    #[serial_test::serial]
    async fn boot_failure_resets_coarse_state() {
        // RAII guard restores OBU_NODE_BINARY on drop.
        // SAFETY: this is a test-only env-var mutation; std::env::set_var is
        // unsafe in Rust 1.80+ because it is not thread-safe; the
        // #[serial_test::serial] attribute serialises this test against any
        // other serial-tagged test so concurrent threads cannot observe the
        // mutated OBU_NODE_BINARY value.  The guard ensures restoration on
        // both success and panic paths.
        struct EnvGuard(&'static str, Option<std::ffi::OsString>);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.1 {
                    Some(v) => unsafe { std::env::set_var(self.0, v) },
                    None => unsafe { std::env::remove_var(self.0) },
                }
            }
        }
        let prev = std::env::var_os("OBU_NODE_BINARY");
        unsafe { std::env::set_var("OBU_NODE_BINARY", "/definitely/does/not/exist/node") };
        let _guard = EnvGuard("OBU_NODE_BINARY", prev);

        let options = ManagerOptions::for_tests();
        let manager = JsRuntimeManager::new(options).await.unwrap();
        let err = manager.boot().await;
        assert!(err.is_err(), "boot should fail with unspawnable kernel");
        assert_eq!(manager.coarse_state_for_tests().await, KernelState::Failed);
    }

    #[allow(unsafe_code)]
    #[tokio::test]
    #[serial_test::serial]
    async fn exec_refreshes_live_backend_inventory_after_disconnect() {
        // RAII guard restores each mutated env var on drop (set_var is unsafe in
        // Rust 1.80+; #[serial_test::serial] serialises against other env tests).
        struct EnvGuard(&'static str, Option<std::ffi::OsString>);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.1 {
                    Some(v) => unsafe { std::env::set_var(self.0, v) },
                    None => unsafe { std::env::remove_var(self.0) },
                }
            }
        }
        fn set_env(key: &'static str, value: &str) -> EnvGuard {
            let prev = std::env::var_os(key);
            unsafe { std::env::set_var(key, value) };
            EnvGuard(key, prev)
        }

        let runtime_dir = tempfile::tempdir().unwrap();
        // Force boot to fail so the test needs no real Node runtime. The
        // disconnect-triggered refresh runs *before* the (re)boot attempt, so its
        // effect on the live inventory is still observable when boot then fails.
        let _node = set_env("OBU_NODE_BINARY", "/definitely/does/not/exist/node");
        let _runtime = set_env("OBU_RUNTIME_DIR", runtime_dir.path().to_str().unwrap());
        // The host restarted on a new socket; live discovery should pick this up.
        let _backends = set_env(
            "OBU_BACKENDS",
            "webextension:chrome:/tmp/obu-fresh-after-restart.sock",
        );

        let mut options = ManagerOptions::for_tests();
        options.dynamic_backend_discovery = true;
        options.backends = vec![DiscoveredBackend {
            kind: "webextension".to_string(),
            name: "chrome".to_string(),
            socket_path: "/tmp/obu-stale-before-restart.sock".to_string(),
            metadata: None,
        }];

        let manager = JsRuntimeManager::new(options).await.unwrap();

        // The manager starts from the stale spawn-time inventory.
        assert_eq!(
            manager.backend_inventory().backends[0].socket_path,
            "/tmp/obu-stale-before-restart.sock"
        );

        // The broker observed a native-pipe disconnect (host restart).
        manager.mark_backend_inventory_dirty_for_tests();

        // Boot fails, but the disconnect-triggered live refresh runs first.
        let _ = manager.exec("1", Some(1000)).await;

        let backends = manager.backend_inventory().backends;
        assert!(
            backends
                .iter()
                .any(|backend| backend.socket_path == "/tmp/obu-fresh-after-restart.sock"),
            "exec after a disconnect must refresh the live inventory; got {backends:?}"
        );
        assert!(
            !backends
                .iter()
                .any(|backend| backend.socket_path == "/tmp/obu-stale-before-restart.sock"),
            "the stale backend must be replaced after the refresh; got {backends:?}"
        );
        // The manager does NOT consume the flag — it stays set until a brokered
        // connection is successfully (re-)established, so every exec keeps
        // re-discovering until the restarted host is reachable again. Here boot
        // failed and nothing reconnected, so it must remain dirty.
        assert!(
            manager.backend_inventory_dirty_for_tests(),
            "the dirty flag must persist until a connection is re-established"
        );
    }

    #[tokio::test]
    async fn set_kernel_failed_helper_writes_both_state_sources() {
        let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
            .await
            .unwrap();
        manager
            .set_kernel_failed(2, "spawn", "boom".into(), false)
            .await;
        assert_eq!(manager.coarse_state_for_tests().await, KernelState::Failed);
        match &*manager.kernel_lifecycle.lock().await {
            AgentRuntimeKernelLifecycle::Failed {
                generation,
                stage,
                recovered,
                ..
            } => {
                assert_eq!(*generation, 2);
                assert_eq!(*stage, "spawn");
                assert!(!*recovered);
            }
            other => panic!("expected Failed, got {other:?}"),
        }

        // recovered=true => coarse returns to Idle (re-bootable)
        manager
            .set_kernel_failed(3, "exec", "thrown".into(), true)
            .await;
        assert_eq!(manager.coarse_state_for_tests().await, KernelState::Idle);
    }

    #[tokio::test]
    async fn browser_status_exposes_kernel_generation() {
        let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
            .await
            .unwrap();
        let status = manager.browser_status().await.unwrap();
        assert!(
            status["kernel_generation"].is_u64(),
            "browser_status must expose a stable top-level kernel_generation field, got: {status}",
        );
    }

    #[tokio::test]
    #[ignore = "requires a real Node runtime"]
    async fn exec_failure_returns_coarse_idle_and_detailed_failed() {
        let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
            .await
            .unwrap();
        manager.boot().await.expect("boot");
        let _ = manager.exec("throw new Error('boom')", Some(1000)).await;
        assert_eq!(manager.coarse_state_for_tests().await, KernelState::Idle);
        match &*manager.kernel_lifecycle.lock().await {
            AgentRuntimeKernelLifecycle::Failed {
                stage, recovered, ..
            } => {
                assert_eq!(*stage, "exec");
                assert!(*recovered);
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
