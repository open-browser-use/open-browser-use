use obu_node_repl::repl_manager::{DiscoveredBackend, JsRuntimeManager, ManagerOptions};
use obu_node_repl::{Cli, cli};
use serde_json::json;
use std::ffi::OsString;
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::thread;

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn obu_repl_discovers_parent_seeded_backends() {
    let mut options = ManagerOptions::for_tests();
    options.backends.push(DiscoveredBackend {
        kind: "cdp".to_string(),
        name: "cdp".to_string(),
        socket_path: "/tmp/obu/test.sock".to_string(),
        metadata: None,
    });
    let manager = JsRuntimeManager::new(options).await.unwrap();

    let result = manager
        .exec(
            r#"
({
  backends: globalThis.obuRepl.discoverBackends(),
  diagnostics: globalThis.obuRepl.discoverBackendDiagnostics(),
  requestMetaType: typeof globalThis.obuRepl.requestMeta,
  envBackendType: typeof process,
})
"#,
            None,
        )
        .await
        .unwrap();

    assert_eq!(
        result.result["backends"],
        json!([{ "type": "cdp", "name": "cdp", "socketPath": "/tmp/obu/test.sock" }])
    );
    assert_eq!(result.result["diagnostics"], json!([]));
    assert_eq!(result.result["requestMetaType"], json!("object"));
    assert_eq!(result.result["envBackendType"], json!("undefined"));
}

#[tokio::test]
async fn browser_status_reports_missing_sdk_and_no_backend() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();

    let status = manager.browser_status().await.unwrap();

    assert_eq!(status["sdk_bootstrap"], json!("missing"));
    assert_eq!(status["backends"], json!([]));
    assert_eq!(status["doctor_hint"], json!("obu doctor browser --repair"));
}

#[tokio::test]
async fn browser_status_reports_untrusted_sdk_without_backend_secrets() {
    let mut options = ManagerOptions::for_tests();
    options.module_dirs.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("sdk-good"),
    );
    options.backends.push(DiscoveredBackend {
        kind: "webextension".to_string(),
        name: "chrome".to_string(),
        socket_path: "/tmp/obu/test.sock".to_string(),
        metadata: Some(json!({ "safe": true })),
    });
    options.backend_auth_tokens.insert(
        std::path::PathBuf::from("/tmp/obu/test.sock"),
        "secret".to_string(),
    );
    let manager = JsRuntimeManager::new(options).await.unwrap();

    let status = manager.browser_status().await.unwrap();

    assert_eq!(status["sdk_bootstrap"], json!("untrusted"));
    assert_eq!(status["backends"][0]["type"], json!("webextension"));
    assert!(status.to_string().contains("secret") == false);
}

#[tokio::test]
async fn exec_frames_include_obu_turn_metadata() {
    let mut options = ManagerOptions::for_tests();
    options.session_id = "obu-session-for-metadata-test".into();
    let manager = JsRuntimeManager::new(options).await.unwrap();

    let result = manager
        .exec(
            r#"
globalThis.obuRepl.requestMeta["x-obu-turn-metadata"]
"#,
            None,
        )
        .await
        .unwrap();

    assert_eq!(
        result.result["session_id"],
        json!("obu-session-for-metadata-test")
    );
    assert!(
        result.result["turn_id"]
            .as_str()
            .unwrap()
            .starts_with("exec-")
    );
}

#[tokio::test]
async fn runtime_descriptor_discovery_hides_sdk_auth_token() {
    let _env_guard = ENV_LOCK.lock().await;
    let runtime_dir = tempfile::tempdir().unwrap();
    make_runtime_root_owner_only(runtime_dir.path());
    let _runtime = EnvVarGuard::set("OBU_RUNTIME_DIR", &runtime_dir.path().to_string_lossy());
    let _backends = EnvVarGuard::remove("OBU_BACKENDS");
    let _extra = EnvVarGuard::remove("OBU_EXTRA_BACKENDS");

    let socket_path = runtime_dir.path().join("backend.sock");
    let server = start_descriptor_server(
        &socket_path,
        "secret-token",
        json!({
            "type": "webextension",
            "name": "chrome",
            "metadata": {
                "host_version": "0.1.0",
                "backend": {
                    "browser_kind": "chrome",
                    "extension_id": "ext-id",
                    "extension_version": "0.1.0",
                    "extension_instance_id": "instance-id"
                }
            },
            "capabilities": {}
        }),
    );

    let descriptor_dir = runtime_dir.path().join("webextension");
    std::fs::create_dir_all(&descriptor_dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let descriptor_path = descriptor_dir.join("chrome.json");
    std::fs::write(
        &descriptor_path,
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "type": "webextension",
            "name": "chrome",
            "socketPath": socket_path.to_string_lossy(),
            "sdk_auth_token": "secret-token",
            "pid": std::process::id(),
            "startedAt": "1",
            "metadata": {
                "browser_kind": "chrome",
                "extension_id": "ext-id",
                "extension_version": "0.1.0",
                "extension_instance_id": "instance-id"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let options = ManagerOptions::from_cli(&Cli {
        verbosity: 0,
        session_id: Some("descriptor-session".into()),
        working_dir: None,
        command: cli::Command::Mcp {
            transport: cli::McpTransport::Stdio,
        },
    })
    .unwrap();

    assert_eq!(options.backends.len(), 1);
    assert_eq!(options.backends[0].kind, "webextension");
    assert_eq!(options.backends[0].name, "chrome");
    assert_eq!(
        options.backends[0].metadata.as_ref().unwrap()["extension_id"],
        json!("ext-id")
    );
    assert_eq!(options.backend_auth_tokens.len(), 1);

    let manager = JsRuntimeManager::new(options).await.unwrap();
    let result = manager
        .exec("globalThis.obuRepl.discoverBackends()", None)
        .await
        .unwrap();

    assert_eq!(result.result[0]["type"], json!("webextension"));
    assert!(result.result[0].get("sdk_auth_token").is_none());
    assert!(result.result[0].get("metadata").is_some());
    server.join().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn js_reset_refreshes_runtime_descriptor_inventory() {
    let _env_guard = ENV_LOCK.lock().await;
    let runtime_dir = tempfile::tempdir().unwrap();
    make_runtime_root_owner_only(runtime_dir.path());
    let _runtime = EnvVarGuard::set("OBU_RUNTIME_DIR", &runtime_dir.path().to_string_lossy());
    let _backends = EnvVarGuard::remove("OBU_BACKENDS");
    let _extra = EnvVarGuard::remove("OBU_EXTRA_BACKENDS");

    let descriptor_dir = runtime_dir.path().join("webextension");
    std::fs::create_dir_all(&descriptor_dir).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let descriptor_path = descriptor_dir.join("chrome.json");

    let first_socket = runtime_dir.path().join("first.sock");
    let first_server = start_descriptor_server(
        &first_socket,
        "first-token",
        json!({
            "type": "webextension",
            "name": "chrome",
            "metadata": {
                "backend": {
                    "browser_kind": "chrome",
                    "extension_id": "ext-id",
                    "extension_version": "0.1.0",
                    "extension_instance_id": "instance-id"
                }
            },
            "capabilities": {}
        }),
    );
    write_descriptor(&descriptor_path, &first_socket, "first-token");

    let options = ManagerOptions::from_cli(&Cli {
        verbosity: 0,
        session_id: Some("descriptor-session".into()),
        working_dir: None,
        command: cli::Command::Mcp {
            transport: cli::McpTransport::Stdio,
        },
    })
    .unwrap();
    assert_eq!(options.backends.len(), 1);
    first_server.join().unwrap();

    let manager = JsRuntimeManager::new(options).await.unwrap();
    let first = manager
        .exec("globalThis.obuRepl.discoverBackends()[0].socketPath", None)
        .await
        .unwrap();
    assert_eq!(
        first.result,
        json!(
            std::fs::canonicalize(&first_socket)
                .unwrap()
                .to_string_lossy()
                .to_string()
        )
    );

    let second_socket = runtime_dir.path().join("second.sock");
    let second_server = start_descriptor_server(
        &second_socket,
        "second-token",
        json!({
            "type": "webextension",
            "name": "chrome",
            "metadata": {
                "backend": {
                    "browser_kind": "chrome",
                    "extension_id": "ext-id",
                    "extension_version": "0.1.0",
                    "extension_instance_id": "instance-id"
                }
            },
            "capabilities": {}
        }),
    );
    write_descriptor(&descriptor_path, &second_socket, "second-token");

    manager.reset().await.unwrap();
    second_server.join().unwrap();

    let second = manager
        .exec("globalThis.obuRepl.discoverBackends()[0].socketPath", None)
        .await
        .unwrap();
    assert_eq!(
        second.result,
        json!(
            std::fs::canonicalize(&second_socket)
                .unwrap()
                .to_string_lossy()
                .to_string()
        )
    );
}

#[cfg(unix)]
#[tokio::test]
async fn browser_status_refreshes_live_kernel_descriptor_inventory() {
    let _env_guard = ENV_LOCK.lock().await;
    let runtime_dir = tempfile::tempdir().unwrap();
    make_runtime_root_owner_only(runtime_dir.path());
    let _runtime = EnvVarGuard::set("OBU_RUNTIME_DIR", &runtime_dir.path().to_string_lossy());
    let _backends = EnvVarGuard::remove("OBU_BACKENDS");
    let _extra = EnvVarGuard::remove("OBU_EXTRA_BACKENDS");

    let options = ManagerOptions::from_cli(&Cli {
        verbosity: 0,
        session_id: Some("descriptor-session".into()),
        working_dir: None,
        command: cli::Command::Mcp {
            transport: cli::McpTransport::Stdio,
        },
    })
    .unwrap();
    assert!(options.backends.is_empty());

    let manager = JsRuntimeManager::new(options).await.unwrap();
    manager.boot().await.unwrap();
    let before = manager
        .exec("globalThis.obuRepl.discoverBackends()", None)
        .await
        .unwrap();
    assert_eq!(before.result, json!([]));

    let descriptor_dir = runtime_dir.path().join("webextension");
    std::fs::create_dir_all(&descriptor_dir).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let descriptor_path = descriptor_dir.join("chrome.json");
    let socket_path = runtime_dir.path().join("live.sock");
    let server = start_descriptor_server(
        &socket_path,
        "live-token",
        json!({
            "type": "webextension",
            "name": "chrome",
            "metadata": {
                "backend": {
                    "browser_kind": "chrome",
                    "extension_id": "ext-id",
                    "extension_version": "0.1.0",
                    "extension_instance_id": "instance-id"
                }
            },
            "capabilities": {}
        }),
    );
    write_descriptor(&descriptor_path, &socket_path, "live-token");

    let status = manager.browser_status().await.unwrap();
    assert_eq!(status["backends"][0]["type"], json!("webextension"));
    server.join().unwrap();

    let after = manager
        .exec("globalThis.obuRepl.discoverBackends()[0].socketPath", None)
        .await
        .unwrap();
    assert_eq!(
        after.result,
        json!(
            std::fs::canonicalize(&socket_path)
                .unwrap()
                .to_string_lossy()
                .to_string()
        )
    );
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_descriptor_discovery_removes_stale_descriptor() {
    let _env_guard = ENV_LOCK.lock().await;
    let runtime_dir = tempfile::tempdir().unwrap();
    make_runtime_root_owner_only(runtime_dir.path());
    let _runtime = EnvVarGuard::set("OBU_RUNTIME_DIR", &runtime_dir.path().to_string_lossy());
    let _backends = EnvVarGuard::remove("OBU_BACKENDS");
    let _extra = EnvVarGuard::remove("OBU_EXTRA_BACKENDS");

    let socket_path = runtime_dir.path().join("stale.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    drop(listener);
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let descriptor_dir = runtime_dir.path().join("webextension");
    std::fs::create_dir_all(&descriptor_dir).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let descriptor_path = descriptor_dir.join("stale.json");
    write_descriptor(&descriptor_path, &socket_path, "secret-token");

    let options = ManagerOptions::from_cli(&Cli {
        verbosity: 0,
        session_id: Some("descriptor-session".into()),
        working_dir: None,
        command: cli::Command::Mcp {
            transport: cli::McpTransport::Stdio,
        },
    })
    .unwrap();

    assert!(options.backends.is_empty());
    assert_eq!(options.backend_discovery_diagnostics.len(), 1);
    assert!(
        options.backend_discovery_diagnostics[0]
            .reason
            .contains("descriptor probe failed")
    );
    assert!(!descriptor_path.exists());
}

#[tokio::test]
async fn runtime_descriptor_discovery_exposes_ignored_descriptor_diagnostics() {
    let _env_guard = ENV_LOCK.lock().await;
    let runtime_dir = tempfile::tempdir().unwrap();
    make_runtime_root_owner_only(runtime_dir.path());
    let _runtime = EnvVarGuard::set("OBU_RUNTIME_DIR", &runtime_dir.path().to_string_lossy());
    let _backends = EnvVarGuard::remove("OBU_BACKENDS");
    let _extra = EnvVarGuard::remove("OBU_EXTRA_BACKENDS");

    let descriptor_dir = runtime_dir.path().join("webextension");
    std::fs::create_dir_all(&descriptor_dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let descriptor_path = descriptor_dir.join("future.json");
    std::fs::write(
        &descriptor_path,
        serde_json::to_vec(&json!({
            "schema_version": 999,
            "type": "webextension",
            "name": "chrome"
        }))
        .unwrap(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&descriptor_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let options = ManagerOptions::from_cli(&Cli {
        verbosity: 0,
        session_id: Some("descriptor-session".into()),
        working_dir: None,
        command: cli::Command::Mcp {
            transport: cli::McpTransport::Stdio,
        },
    })
    .unwrap();

    assert!(options.backends.is_empty());
    assert_eq!(options.backend_discovery_diagnostics.len(), 1);
    assert!(
        options.backend_discovery_diagnostics[0]
            .source
            .ends_with("future.json")
    );
    assert_eq!(
        options.backend_discovery_diagnostics[0].reason,
        "unsupported schema_version 999"
    );

    let manager = JsRuntimeManager::new(options).await.unwrap();
    let result = manager
        .exec("globalThis.obuRepl.discoverBackendDiagnostics()", None)
        .await
        .unwrap();

    assert_eq!(
        result.result[0]["reason"],
        json!("unsupported schema_version 999")
    );
    assert!(
        result.result[0]["source"]
            .as_str()
            .unwrap()
            .ends_with("future.json")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_descriptor_discovery_rejects_unsafe_runtime_root() {
    let _env_guard = ENV_LOCK.lock().await;
    let runtime_dir = tempfile::tempdir().unwrap();
    let _runtime = EnvVarGuard::set("OBU_RUNTIME_DIR", &runtime_dir.path().to_string_lossy());
    let _backends = EnvVarGuard::remove("OBU_BACKENDS");
    let _extra = EnvVarGuard::remove("OBU_EXTRA_BACKENDS");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(runtime_dir.path(), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }

    let options = ManagerOptions::from_cli(&Cli {
        verbosity: 0,
        session_id: Some("descriptor-session".into()),
        working_dir: None,
        command: cli::Command::Mcp {
            transport: cli::McpTransport::Stdio,
        },
    })
    .unwrap();

    assert!(options.backends.is_empty());
    assert_eq!(options.backend_discovery_diagnostics.len(), 1);
    assert_eq!(
        options.backend_discovery_diagnostics[0].source,
        runtime_dir.path().display().to_string()
    );
    assert!(
        options.backend_discovery_diagnostics[0]
            .reason
            .contains("owner-only")
    );
}

struct EnvVarGuard {
    key: &'static str,
    old: Option<OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let old = std::env::var_os(key);
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, old }
    }

    fn remove(key: &'static str) -> Self {
        let old = std::env::var_os(key);
        unsafe {
            std::env::remove_var(key);
        }
        Self { key, old }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some(old) = &self.old {
                std::env::set_var(self.key, old);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

#[cfg(unix)]
fn make_runtime_root_owner_only(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(not(unix))]
fn make_runtime_root_owner_only(_path: &std::path::Path) {}

#[cfg(unix)]
fn write_descriptor(path: &std::path::Path, socket_path: &std::path::Path, token: &str) {
    std::fs::write(
        path,
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "type": "webextension",
            "name": "chrome",
            "socketPath": socket_path.to_string_lossy(),
            "sdk_auth_token": token,
            "pid": std::process::id(),
            "startedAt": "1",
            "metadata": {
                "browser_kind": "chrome",
                "extension_id": "ext-id",
                "extension_version": "0.1.0",
                "extension_instance_id": "instance-id"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[cfg(unix)]
fn start_descriptor_server(
    socket_path: &std::path::Path,
    expected_token: &'static str,
    get_info: serde_json::Value,
) -> thread::JoinHandle<()> {
    let listener = UnixListener::bind(socket_path).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let auth = read_frame(&mut stream);
        assert_eq!(auth["method"], "auth");
        assert_eq!(auth["params"]["capability_token"], expected_token);
        write_frame(
            &mut stream,
            &json!({ "jsonrpc": "2.0", "id": auth["id"].clone(), "result": null }),
        );
        let get_info_request = read_frame(&mut stream);
        assert_eq!(get_info_request["method"], "getInfo");
        write_frame(
            &mut stream,
            &json!({
                "jsonrpc": "2.0",
                "id": get_info_request["id"].clone(),
                "result": get_info,
            }),
        );
    })
}

#[cfg(unix)]
fn read_frame(stream: &mut UnixStream) -> serde_json::Value {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).unwrap();
    let mut bytes = vec![0u8; u32::from_le_bytes(len) as usize];
    stream.read_exact(&mut bytes).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[cfg(unix)]
fn write_frame(stream: &mut UnixStream, value: &serde_json::Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    stream
        .write_all(&(u32::try_from(bytes.len()).unwrap()).to_le_bytes())
        .unwrap();
    stream.write_all(&bytes).unwrap();
}
