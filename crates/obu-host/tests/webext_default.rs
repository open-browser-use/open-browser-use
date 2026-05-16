#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio_util::codec::Framed;

use obu_host::{
    backends::{BrowserBackend, webext::WebExtensionBackend},
    dispatcher::Dispatcher,
    methods,
    socket::{Listener, unix::UnixSockListener},
};
use obu_wire::FrameCodec;

#[tokio::test]
async fn webext_default_ping_and_get_info_smoke() {
    let ping = dispatch_default(methods::PING, json!({})).await;
    assert_eq!(ping["id"], 1);
    assert_eq!(ping["result"], "pong");

    let info = dispatch_default(methods::GET_INFO, json!({})).await;
    assert_eq!(info["id"], 1);
    assert_eq!(info["result"]["type"], "webextension");
    assert_eq!(info["result"]["name"], "chrome");
    assert_eq!(info["result"]["metadata"]["backend"], json!({}));
    assert_eq!(
        info["result"]["metadata"]["diagnostics"]["lifecycle"]["sessions"],
        0
    );
    assert_eq!(
        info["result"]["metadata"]["diagnostics"]["lifecycle"]["stale_sessions"],
        0
    );
    assert_eq!(
        info["result"]["metadata"]["diagnostics"]["lifecycle"]["stale_session_reasons"],
        json!([])
    );
    assert_eq!(
        info["result"]["metadata"]["diagnostics"]["lifecycle"]["tabs"],
        0
    );
    assert_eq!(
        info["result"]["metadata"]["diagnostics"]["lifecycle"]["deliverable_tabs"],
        0
    );
    assert_eq!(
        info["result"]["metadata"]["diagnostics"]["lifecycle"]["deliverable_tab_summaries"],
        json!([])
    );
}

#[tokio::test]
async fn webext_default_returns_not_implemented_without_transport_on_attach() {
    let value = dispatch_default(
        methods::ATTACH,
        json!({
            "tab_id": "fake-id",
            "session_id": "session",
            "turn_id": "turn"
        }),
    )
    .await;

    assert_eq!(value["id"], 1);
    assert_eq!(value["error"]["code"], -1003);
    assert!(
        value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("attach")
    );
}

#[tokio::test]
async fn webext_requires_session_context_before_browser_side_effects() {
    let value = dispatch_default(methods::ATTACH, json!({ "tab_id": "fake-id" })).await;

    assert_eq!(value["id"], 1);
    assert_eq!(value["error"]["code"], -1004);
    assert!(
        value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("session_id")
    );
}

async fn dispatch_default(method: &str, params: Value) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("webext-default.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();

    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let backend: Arc<dyn BrowserBackend> = Arc::new(WebExtensionBackend::default());
        let dispatcher = Dispatcher::new("0.1.0".into(), backend);
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);
    framed
        .send(bytes::Bytes::from(
            serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": 1,
            }))
            .unwrap(),
        ))
        .await
        .unwrap();

    let resp = framed.next().await.unwrap().unwrap();
    let value: Value = serde_json::from_slice(&resp).unwrap();

    drop(framed);
    server.await.unwrap();
    value
}
