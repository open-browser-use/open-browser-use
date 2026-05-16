//! Spawn the Node child with the embedded `kernel.js` assets.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, anyhow};
use tempfile::TempDir;
use tokio::process::Command;

use super::node_version::{NodeVersion, resolve_compatible_node};
use super::stdio_codec::{StdioReader, StdioWriter};
use super::{BackendDiscoveryDiagnostic, DiscoveredBackend, KERNEL_JS, MERIYAH_JS};

/// Options used to spawn a kernel child.
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    /// Stable session identifier passed to the JavaScript bootstrap.
    pub session_id: String,
    /// Working directory for user code and module resolution.
    pub working_dir: PathBuf,
    /// Initial module search roots.
    pub module_dirs: Vec<PathBuf>,
    /// Trusted directories that receive privileged import metadata.
    pub trusted_code_paths: Vec<PathBuf>,
    /// Trusted module source hashes.
    pub trusted_module_sha256s: Vec<String>,
    /// Trust all imported code.
    pub trust_all: bool,
    /// Backend inventory exposed through `globalThis.obuRepl`.
    pub backends: Vec<DiscoveredBackend>,
    /// Backend discovery diagnostics exposed through `globalThis.obuRepl`.
    pub backend_discovery_diagnostics: Vec<BackendDiscoveryDiagnostic>,
}

/// A live Node kernel process.
pub struct SpawnedKernel {
    /// Child process handle.
    pub child: tokio::process::Child,
    /// JSONL stdout reader.
    pub reader: Option<StdioReader>,
    /// JSONL stdin writer.
    pub writer: Option<StdioWriter>,
    /// Resolved Node version.
    pub node_version: NodeVersion,
    /// Resolved Node executable.
    pub node_path: PathBuf,
    asset_dir: TempDir,
}

impl SpawnedKernel {
    /// Spawn a fresh kernel process.
    pub async fn spawn(opts: SpawnOptions) -> Result<Self> {
        let (node_path, node_version) = resolve_compatible_node()?;
        let asset_dir = write_embedded_assets()?;
        let kernel_path = asset_dir.path().join("kernel.js");

        let mut cmd = Command::new(&node_path);
        cmd.arg("--experimental-vm-modules").arg("--no-warnings");
        configure_node_permissions(&mut cmd, &node_path);
        cmd.arg(&kernel_path)
            .arg("--session-id")
            .arg(&opts.session_id)
            .arg("--working-dir")
            .arg(&opts.working_dir)
            .arg("--backends-json")
            .arg(serde_json::to_string(&opts.backends).context("serialize backend inventory")?)
            .arg("--backend-diagnostics-json")
            .arg(
                serde_json::to_string(&opts.backend_discovery_diagnostics)
                    .context("serialize backend discovery diagnostics")?,
            );
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(&opts.working_dir);
        cmd.kill_on_drop(true);

        set_minimal_env(&mut cmd, &opts)?;

        let mut child = cmd.spawn().context("spawn Node kernel")?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("child stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("child stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("child stderr unavailable"))?;

        let pid = child.id().unwrap_or(0);
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(pid, "node stderr: {line}");
            }
        });

        Ok(Self {
            child,
            reader: Some(StdioReader::new(stdout)),
            writer: Some(StdioWriter::new(stdin)),
            node_version,
            node_path,
            asset_dir,
        })
    }

    /// Filesystem directory holding `kernel.js` and `meriyah.umd.min.js`.
    pub fn asset_dir(&self) -> &Path {
        self.asset_dir.path()
    }
}

fn write_embedded_assets() -> Result<TempDir> {
    let dir = tempfile::Builder::new()
        .prefix("obu-node-repl-")
        .tempdir()
        .context("create kernel asset tempdir")?;
    std::fs::write(dir.path().join("kernel.js"), KERNEL_JS).context("write kernel.js")?;
    std::fs::write(dir.path().join("meriyah.umd.min.js"), MERIYAH_JS)
        .context("write meriyah.umd.min.js")?;
    Ok(dir)
}

fn set_minimal_env(cmd: &mut Command, opts: &SpawnOptions) -> Result<()> {
    cmd.env_clear();
    for key in [
        "HOME", "PATH", "USER", "LANG", "TZ", "TMPDIR", "TMP", "TEMP",
    ] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }

    if let Some(value) = join_paths(&opts.module_dirs)? {
        cmd.env("OBU_NODE_REPL_MODULE_DIRS", value);
    }
    if let Some(value) = join_paths(&opts.trusted_code_paths)? {
        cmd.env("OBU_TRUSTED_CODE_PATHS", value);
    }
    if !opts.trusted_module_sha256s.is_empty() {
        cmd.env(
            "OBU_TRUSTED_MODULE_SHA256S",
            opts.trusted_module_sha256s.join(":"),
        );
    }
    if opts.trust_all {
        cmd.env("OBU_TRUST_ALL_CODE", "1");
    }
    Ok(())
}

fn configure_node_permissions(cmd: &mut Command, node_path: &Path) {
    if !node_supports_permission_flag(node_path) {
        tracing::warn!(
            node = %node_path.display(),
            "Node permission model is unavailable; spawning kernel without OS-level permission flags"
        );
        return;
    }

    // Node does not currently expose the design's socket-directory-only flag.
    // Enable the permission model without --allow-net/child/worker/addons, while
    // leaving filesystem import policy to the kernel trust gate.
    cmd.arg("--permission");
    for path in default_fs_read_roots() {
        cmd.arg(format!("--allow-fs-read={}", path.display()));
    }
}

fn node_supports_permission_flag(node_path: &Path) -> bool {
    std::process::Command::new(node_path)
        .arg("--permission")
        .arg("-e")
        .arg("")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn default_fs_read_roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/")]
}

#[cfg(windows)]
fn default_fs_read_roots() -> Vec<PathBuf> {
    vec![PathBuf::from(r"C:\")]
}

fn join_paths(paths: &[PathBuf]) -> Result<Option<OsString>> {
    if paths.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        std::env::join_paths(paths).context("join environment paths")?,
    ))
}
