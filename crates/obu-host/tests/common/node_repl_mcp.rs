use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct NodeReplOpts {
    pub envs: Vec<(String, String)>,
}

pub struct BuiltSdkModuleRoot {
    _temp_dir: TempDir,
    pub root: PathBuf,
    pub hash: String,
}

#[derive(Clone)]
pub struct NodeReplHandle {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: Arc<Mutex<Lines<BufReader<ChildStdout>>>>,
    next_id: Arc<AtomicU64>,
}

pub fn prepare_built_sdk_module_root() -> BuiltSdkModuleRoot {
    let repo_sdk = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/sdk");
    let dist = repo_sdk.join("dist");
    let index = dist.join("index.mjs");
    if !index.exists() {
        panic!(
            "built SDK missing at {}; run `pnpm -C packages/sdk build` first",
            index.display()
        );
    }

    let temp_dir = tempfile::tempdir().expect("create sdk module tempdir");
    let root = temp_dir.path().to_path_buf();
    let sdk_dir = root
        .join("node_modules")
        .join("@open-browser-use")
        .join("sdk");
    let sdk_dist = sdk_dir.join("dist");
    std::fs::create_dir_all(&sdk_dist).expect("create copied sdk dist");
    std::fs::copy(repo_sdk.join("package.json"), sdk_dir.join("package.json"))
        .expect("copy sdk package.json");
    std::fs::copy(&index, sdk_dist.join("index.mjs")).expect("copy sdk index.mjs");
    std::fs::copy(dist.join("version.json"), sdk_dist.join("version.json"))
        .expect("copy sdk version.json");

    let bytes = std::fs::read(sdk_dist.join("index.mjs")).expect("read copied sdk index.mjs");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = format!("{:x}", hasher.finalize());

    BuiltSdkModuleRoot {
        _temp_dir: temp_dir,
        root,
        hash,
    }
}

pub async fn spawn_node_repl(opts: &NodeReplOpts) -> NodeReplHandle {
    let bin = std::env::var("OBU_NODE_REPL_BIN")
        .ok()
        .or_else(|| option_env!("CARGO_BIN_EXE_obu-node-repl").map(str::to_owned))
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/obu-node-repl")
                .display()
                .to_string()
        });
    let mut cmd = Command::new(bin);
    cmd.arg("mcp")
        .arg("stdio")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in &opts.envs {
        cmd.env(key, value);
    }
    let mut child = cmd.spawn().expect("spawn obu-node-repl");
    let stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("obu-node-repl stderr: {line}");
        }
    });

    let handle = NodeReplHandle {
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(stdin)),
        stdout: Arc::new(Mutex::new(BufReader::new(stdout).lines())),
        next_id: Arc::new(AtomicU64::new(1)),
    };

    handle
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "obu-host-e2e", "version": "0.0.0" }
            }
        }))
        .await;
    let init = handle.read_until_id(1).await;
    assert_eq!(init["id"], 1);
    handle
        .send(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }))
        .await;
    handle.next_id.store(2, Ordering::SeqCst);
    handle
}

impl NodeReplHandle {
    pub async fn call_tool(&self, name: &str, arguments: Value) -> anyhow::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }))
        .await;
        let msg = self.read_until_id(id).await;
        if let Some(error) = msg.get("error") {
            anyhow::bail!("MCP tools/call error: {error}");
        }
        Ok(msg["result"]["structuredContent"].clone())
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        Ok(())
    }

    async fn send(&self, value: Value) {
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(value.to_string().as_bytes()).await.unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();
    }

    async fn read_until_id(&self, id: u64) -> Value {
        let mut stdout = self.stdout.lock().await;
        loop {
            let line = tokio::time::timeout(Duration::from_secs(20), stdout.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let msg: Value = serde_json::from_str(&line).unwrap();
            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                return msg;
            }
        }
    }
}

pub async fn wait_for_socket(path: &Path, timeout: Duration) -> std::io::Result<()> {
    use std::os::unix::fs::FileTypeExt;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::fs::metadata(path).await {
            Ok(meta) if meta.file_type().is_socket() => return Ok(()),
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("{} exists but is not a socket", path.display()),
                ));
            }
            Err(error) if tokio::time::Instant::now() < deadline => {
                let _ = error;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => return Err(error),
        }
    }
}
