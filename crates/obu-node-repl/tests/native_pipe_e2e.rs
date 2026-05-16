#![cfg(unix)]

use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;
use std::ffi::OsString;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn trusted_module_can_echo_through_native_pipe() {
    let _env_guard = ENV_LOCK.lock().await;
    let _timeout = EnvVarGuard::remove("OBU_NATIVE_PIPE_CONNECT_TIMEOUT_MS");
    let _allowlist = EnvVarGuard::remove("OBU_SANDBOX_ALLOWED_UNIX_SOCKETS");
    let _token = EnvVarGuard::remove("OBU_CAPABILITY_TOKEN");

    let socket_dir = tempfile::tempdir().unwrap();
    let socket_path = socket_dir.path().join("echo.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();

    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 5];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
        stream.write_all(b"world").await.unwrap();
        stream.shutdown().await.unwrap();
    });

    let trusted = tempfile::tempdir().unwrap();
    let trusted_module = trusted.path().join("pipe-client.mjs");
    std::fs::write(
        &trusted_module,
        r#"
export const hasPipe = typeof import.meta.__obuNativePipe?.createConnection === "function";

export async function roundTrip(socketPath) {
  const conn = await import.meta.__obuNativePipe.createConnection(socketPath);
  return await new Promise((resolve, reject) => {
    conn.on("data", (chunk) => {
      conn.end();
      resolve(Buffer.from(chunk).toString("utf8"));
    });
    conn.on("error", reject);
    conn.write(Buffer.from("hello"));
  });
}
"#,
    )
    .unwrap();

    let mut options = ManagerOptions::for_tests();
    options
        .trusted_code_paths
        .push(trusted.path().to_path_buf());
    let manager = JsRuntimeManager::new(options).await.unwrap();

    let result = manager
        .exec(
            &format!(
                r#"
const client = await import("{module_url}");
({{
  trustedHasPipe: client.hasPipe,
  mainHasPipe: typeof import.meta.__obuNativePipe,
  globalHasPipe: typeof globalThis.__obuNativePipe,
  echoed: await client.roundTrip({socket_path_json})
}})
"#,
                module_url = file_url(&trusted_module),
                socket_path_json = serde_json::to_string(&socket_path.to_string_lossy()).unwrap(),
            ),
            Some(5_000),
        )
        .await
        .unwrap();

    assert_eq!(result.result["trustedHasPipe"], json!(true));
    assert_eq!(result.result["mainHasPipe"], json!("undefined"));
    assert_eq!(result.result["globalHasPipe"], json!("undefined"));
    assert_eq!(result.result["echoed"], json!("world"));
    server.await.unwrap();
}

fn file_url(path: &std::path::Path) -> String {
    format!("file://{}", path.to_string_lossy())
}

#[tokio::test]
async fn native_pipe_policy_env_is_parent_only_and_enforced() {
    let _env_guard = ENV_LOCK.lock().await;

    let allowed_dir = tempfile::tempdir().unwrap();
    let allowed_path = allowed_dir.path().join("allowed.sock");
    let _allowed_listener = UnixListener::bind(&allowed_path).unwrap();

    let blocked_dir = tempfile::tempdir().unwrap();
    let blocked_path = blocked_dir.path().join("blocked.sock");
    let _blocked_listener = UnixListener::bind(&blocked_path).unwrap();

    let _timeout = EnvVarGuard::set("OBU_NATIVE_PIPE_CONNECT_TIMEOUT_MS", "1234");
    let _allowlist = EnvVarGuard::set(
        "OBU_SANDBOX_ALLOWED_UNIX_SOCKETS",
        &allowed_path.to_string_lossy(),
    );
    let _token = EnvVarGuard::set("OBU_CAPABILITY_TOKEN", "secret-parent-token");

    let trusted = tempfile::tempdir().unwrap();
    let trusted_module = trusted.path().join("policy-client.mjs");
    std::fs::write(
        &trusted_module,
        r#"
export async function tryConnect(socketPath) {
  try {
    await import.meta.__obuNativePipe.createConnection(socketPath);
    return "ok";
  } catch (error) {
    return error.message;
  }
}
"#,
    )
    .unwrap();

    let mut options = ManagerOptions::for_tests();
    options
        .trusted_code_paths
        .push(trusted.path().to_path_buf());
    let manager = JsRuntimeManager::new(options).await.unwrap();
    let result = manager
        .exec(
            &format!(
                r#"
const client = await import("{module_url}");
({{
  processType: typeof process,
  capabilityGlobal: typeof globalThis.__obuCapabilityToken,
  capabilityMeta: typeof import.meta.__obuCapabilityToken,
  blockedMessage: await client.tryConnect({blocked_path_json})
}})
"#,
                module_url = file_url(&trusted_module),
                blocked_path_json = serde_json::to_string(&blocked_path.to_string_lossy()).unwrap(),
            ),
            Some(5_000),
        )
        .await
        .unwrap();

    assert_eq!(result.result["processType"], json!("undefined"));
    assert_eq!(result.result["capabilityGlobal"], json!("undefined"));
    assert_eq!(result.result["capabilityMeta"], json!("undefined"));
    assert!(
        result.result["blockedMessage"]
            .as_str()
            .unwrap()
            .contains("native pipe path not allowed")
    );
}

struct EnvVarGuard {
    key: &'static str,
    old: Option<OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let old = std::env::var_os(key);
        // SAFETY: tests in this file serialize environment mutation with
        // ENV_LOCK and restore values before releasing the lock.
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, old }
    }

    fn remove(key: &'static str) -> Self {
        let old = std::env::var_os(key);
        // SAFETY: tests in this file serialize environment mutation with
        // ENV_LOCK and restore values before releasing the lock.
        unsafe {
            std::env::remove_var(key);
        }
        Self { key, old }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        // SAFETY: see EnvVarGuard::set; the same lock is held while restoring.
        unsafe {
            if let Some(old) = &self.old {
                std::env::set_var(self.key, old);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}
