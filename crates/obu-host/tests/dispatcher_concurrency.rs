#![cfg(unix)]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::UnixStream;
use tokio::sync::Notify;
use tokio_util::codec::Framed;

use obu_host::{
    backends::{BackendKind, BrowserBackend},
    dispatcher::Dispatcher,
    error::Result,
    methods,
    socket::{Listener, unix::UnixSockListener},
};
use obu_wire::FrameCodec;
use obu_wire::error::ERR_OVERLOADED;

struct BlockingAttachBackend {
    release_attach: Arc<Notify>,
    attach_started: Arc<Notify>,
}

#[async_trait]
impl BrowserBackend for BlockingAttachBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::WebExtension
    }

    fn id(&self) -> &str {
        "blocking-test"
    }

    async fn attach(&self, _tab_id: &str) -> Result<()> {
        self.attach_started.notify_one();
        self.release_attach.notified().await;
        Ok(())
    }
}

#[tokio::test]
async fn later_request_can_complete_while_first_request_is_pending() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("concurrency.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let release_attach = Arc::new(Notify::new());
    let attach_started = Arc::new(Notify::new());

    let server_release = release_attach.clone();
    let server_attach_started = attach_started.clone();
    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let backend: Arc<dyn BrowserBackend> = Arc::new(BlockingAttachBackend {
            release_attach: server_release,
            attach_started: server_attach_started,
        });
        let dispatcher = Dispatcher::new("0.1.0".into(), backend);
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::ATTACH,
            "params": { "tab_id": "tab-1" },
            "id": 1,
        })))
        .await
        .unwrap();
    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::PING,
            "params": {},
            "id": 2,
        })))
        .await
        .unwrap();

    let ping = read_json(&mut framed).await;
    assert_eq!(ping["id"], 2);
    assert_eq!(ping["result"], "pong");

    release_attach.notify_one();
    let attach = read_json(&mut framed).await;
    assert_eq!(attach["id"], 1);
    assert_eq!(attach["result"], serde_json::Value::Null);

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn client_timeout_ms_bounds_server_request() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("timeout.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let release_attach = Arc::new(Notify::new());
    let attach_started = Arc::new(Notify::new());

    let server_release = release_attach.clone();
    let server_attach_started = attach_started.clone();
    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let backend: Arc<dyn BrowserBackend> = Arc::new(BlockingAttachBackend {
            release_attach: server_release,
            attach_started: server_attach_started,
        });
        let dispatcher = Dispatcher::new("0.1.0".into(), backend);
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::ATTACH,
            "params": { "tab_id": "tab-1", "client_timeout_ms": 10 },
            "id": 1,
        })))
        .await
        .unwrap();

    let response = read_json(&mut framed).await;
    assert_eq!(response["id"], 1);
    assert_eq!(response["error"]["code"], -1000);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("request timed out")
    );

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn peer_in_flight_limit_rejects_excess_request_without_blocking_active_request() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("overload.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let release_attach = Arc::new(Notify::new());
    let attach_started = Arc::new(Notify::new());

    let server_release = release_attach.clone();
    let server_attach_started = attach_started.clone();
    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let backend: Arc<dyn BrowserBackend> = Arc::new(BlockingAttachBackend {
            release_attach: server_release,
            attach_started: server_attach_started,
        });
        let dispatcher = Dispatcher::new("0.1.0".into(), backend);
        dispatcher
            .serve_peer_with_max_in_flight_for_tests(peer.stream, None, 1)
            .await
            .unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::ATTACH,
            "params": { "tab_id": "tab-1" },
            "id": 1,
        })))
        .await
        .unwrap();
    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::PING,
            "params": {},
            "id": 2,
        })))
        .await
        .unwrap();

    let overload = read_json(&mut framed).await;
    assert_eq!(overload["id"], 2);
    assert_eq!(overload["error"]["code"], ERR_OVERLOADED);
    assert!(
        overload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("too many in-flight requests")
    );

    release_attach.notify_one();
    let attach = read_json(&mut framed).await;
    assert_eq!(attach["id"], 1);
    assert_eq!(attach["result"], serde_json::Value::Null);

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn peer_close_cancels_pending_request_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("peer-close.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let release_attach = Arc::new(Notify::new());
    let attach_started = Arc::new(Notify::new());

    let server_release = release_attach.clone();
    let server_attach_started = attach_started.clone();
    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let backend: Arc<dyn BrowserBackend> = Arc::new(BlockingAttachBackend {
            release_attach: server_release,
            attach_started: server_attach_started,
        });
        let dispatcher = Dispatcher::new("0.1.0".into(), backend);
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::ATTACH,
            "params": { "tab_id": "tab-1" },
            "id": 1,
        })))
        .await
        .unwrap();

    tokio::time::timeout(Duration::from_secs(1), attach_started.notified())
        .await
        .unwrap();
    drop(framed);

    tokio::time::timeout(Duration::from_secs(1), server)
        .await
        .expect("dispatcher should stop after peer close")
        .unwrap();
}

fn frame(value: serde_json::Value) -> bytes::Bytes {
    bytes::Bytes::from(serde_json::to_vec(&value).unwrap())
}

async fn read_json(framed: &mut Framed<UnixStream, FrameCodec>) -> serde_json::Value {
    let bytes = framed.next().await.unwrap().unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
