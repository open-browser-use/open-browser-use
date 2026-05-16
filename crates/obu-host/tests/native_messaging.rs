#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio_util::codec::Framed;

use obu_wire::FrameCodec;
use obu_wire::error::ERR_NO_BACKEND;

#[tokio::test]
async fn native_messaging_hello_exposes_sdk_socket_descriptor_and_getinfo() {
    let runtime_path = Path::new("/tmp").join(format!("obu-nm-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&runtime_path).unwrap();
    std::fs::set_permissions(&runtime_path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--native-messaging")
        .arg("--log")
        .arg("warn")
        .env("OBU_RUNTIME_DIR", &runtime_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    write_frame(
        &mut stdin,
        &json!({
            "type": "hello",
            "extension_version": "0.1.0",
            "manifest_version": 3,
            "min_host_version": "0.1.0",
            "native_host_name": "dev.obu.host",
            "browser_kind": "chrome",
            "extension_id": "test-extension",
            "extension_instance_id": "test-instance"
        }),
    )
    .await;

    let ack = read_frame(&mut stdout).await;
    assert_eq!(ack["type"], "hello_ack");
    assert_eq!(ack["host_version"], env!("CARGO_PKG_VERSION"));

    let descriptor_path = wait_for_descriptor(&runtime_path).await;
    let descriptor: Value =
        serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
    assert_eq!(descriptor["type"], "webextension");
    assert_eq!(descriptor["metadata"]["extension_id"], "test-extension");

    let socket_path = descriptor["socketPath"].as_str().unwrap();
    let token = descriptor["sdk_auth_token"].as_str().unwrap();
    let stream = UnixStream::connect(socket_path).await.unwrap();
    let mut framed = Framed::new(stream, FrameCodec);

    framed
        .send(bytes::Bytes::from(
            serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "method": "auth",
                "params": { "capability_token": token },
                "id": 0
            }))
            .unwrap(),
        ))
        .await
        .unwrap();
    let auth = read_json_frame(&mut framed).await;
    assert_eq!(auth["result"], Value::Null);

    framed
        .send(bytes::Bytes::from(
            serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "method": "getInfo",
                "params": {},
                "id": 1
            }))
            .unwrap(),
        ))
        .await
        .unwrap();
    let info = read_json_frame(&mut framed).await;
    assert_eq!(info["result"]["type"], "webextension");
    assert_eq!(info["result"]["name"], "chrome");
    assert_eq!(
        info["result"]["metadata"]["backend"]["extension_id"],
        "test-extension"
    );

    drop(framed);
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    let _ = std::fs::remove_dir_all(&runtime_path);
}

#[tokio::test]
async fn stop_browser_control_invalidates_descriptor_socket_and_existing_peer() {
    let runtime_path = Path::new("/tmp").join(format!("obu-nm-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&runtime_path).unwrap();
    std::fs::set_permissions(&runtime_path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--native-messaging")
        .arg("--log")
        .arg("warn")
        .env("OBU_RUNTIME_DIR", &runtime_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    write_frame(
        &mut stdin,
        &json!({
            "type": "hello",
            "extension_version": "0.1.0",
            "manifest_version": 3,
            "min_host_version": "0.1.0",
            "native_host_name": "dev.obu.host",
            "browser_kind": "chrome",
            "extension_id": "test-extension",
            "extension_instance_id": "test-instance"
        }),
    )
    .await;

    let ack = read_frame(&mut stdout).await;
    assert_eq!(ack["type"], "hello_ack");

    let descriptor_path = wait_for_descriptor(&runtime_path).await;
    let descriptor: Value =
        serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
    let socket_path = std::path::PathBuf::from(descriptor["socketPath"].as_str().unwrap());
    let token = descriptor["sdk_auth_token"].as_str().unwrap();
    let stream = UnixStream::connect(&socket_path).await.unwrap();
    let mut framed = Framed::new(stream, FrameCodec);

    framed
        .send(bytes::Bytes::from(
            serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "method": "auth",
                "params": { "capability_token": token },
                "id": 0
            }))
            .unwrap(),
        ))
        .await
        .unwrap();
    let auth = read_json_frame(&mut framed).await;
    assert_eq!(auth["result"], Value::Null);

    write_frame(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "stopBrowserControl",
            "params": {
                "reason": "popup_stop",
                "extension_instance_id": "test-instance"
            },
            "id": 7
        }),
    )
    .await;
    let stop = read_frame(&mut stdout).await;
    assert_eq!(stop["result"], Value::Null);

    wait_for_removed(&descriptor_path).await;
    wait_for_removed(&socket_path).await;
    assert!(
        UnixStream::connect(&socket_path).await.is_err(),
        "stopped native host should not accept new SDK peers"
    );

    framed
        .send(bytes::Bytes::from(
            serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "method": "ping",
                "params": {},
                "id": 8
            }))
            .unwrap(),
        ))
        .await
        .unwrap();
    let ping = read_json_frame(&mut framed).await;
    assert_eq!(ping["error"]["code"], json!(ERR_NO_BACKEND));
    assert!(
        ping["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("inactive")
    );

    drop(framed);
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    let _ = std::fs::remove_dir_all(&runtime_path);
}

async fn wait_for_descriptor(runtime: &Path) -> std::path::PathBuf {
    let dir = runtime.join("webextension");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                    return path;
                }
            }
        }
        assert!(Instant::now() < deadline, "descriptor was not written");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_removed(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if !path.exists() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{} was not removed",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn write_frame(stdin: &mut tokio::process::ChildStdin, value: &Value) {
    let body = serde_json::to_vec(value).unwrap();
    stdin
        .write_all(&(body.len() as u32).to_le_bytes())
        .await
        .unwrap();
    stdin.write_all(&body).await.unwrap();
    stdin.flush().await.unwrap();
}

async fn read_frame(stdout: &mut tokio::process::ChildStdout) -> Value {
    let mut len = [0u8; 4];
    stdout.read_exact(&mut len).await.unwrap();
    let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
    stdout.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn read_json_frame(framed: &mut Framed<UnixStream, FrameCodec>) -> Value {
    let bytes = framed.next().await.unwrap().unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
