#![cfg(unix)]

use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::UnixStream;
use tokio::sync::Notify;
use tokio_util::codec::Framed;

use obu_host::{
    backends::{BackendKind, BackendRequestContext, BrowserBackend},
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

struct OrderedMutatingBackend {
    release_tab1: Arc<Notify>,
    tab1_started: Arc<Notify>,
    calls: Arc<StdMutex<Vec<String>>>,
}

struct BlockingSessionLifecycleBackend {
    release_attach: Arc<Notify>,
    attach_started: Arc<Notify>,
    calls: Arc<StdMutex<Vec<String>>>,
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

#[async_trait]
impl BrowserBackend for OrderedMutatingBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::WebExtension
    }

    fn id(&self) -> &str {
        "ordered-mutating-test"
    }

    async fn attach(&self, tab_id: &str) -> Result<()> {
        self.calls
            .lock()
            .expect("ordered calls lock")
            .push(format!("attach:{tab_id}"));
        if tab_id == "tab-1" {
            self.tab1_started.notify_one();
            self.release_tab1.notified().await;
        }
        Ok(())
    }

    async fn detach(&self, tab_id: &str) -> Result<()> {
        self.calls
            .lock()
            .expect("ordered calls lock")
            .push(format!("detach:{tab_id}"));
        Ok(())
    }
}

#[async_trait]
impl BrowserBackend for BlockingSessionLifecycleBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::WebExtension
    }

    fn id(&self) -> &str {
        "blocking-session-lifecycle-test"
    }

    async fn attach(&self, tab_id: &str) -> Result<()> {
        self.calls
            .lock()
            .expect("session lifecycle calls lock")
            .push(format!("attach:{tab_id}"));
        self.attach_started.notify_one();
        self.release_attach.notified().await;
        Ok(())
    }

    async fn finalize_tabs_with_context(
        &self,
        ctx: &BackendRequestContext,
        _params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        self.calls
            .lock()
            .expect("session lifecycle calls lock")
            .push(format!(
                "finalize:{}",
                ctx.session_id.as_deref().unwrap_or_default()
            ));
        Ok(json!({ "closed_tab_ids": [], "released_tab_ids": [] }))
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
            "params": session_tab_params("session-1", "turn-1", "tab-1"),
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
async fn same_tab_mutations_are_serialized_while_other_tabs_progress() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tab-ordering.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let release_tab1 = Arc::new(Notify::new());
    let tab1_started = Arc::new(Notify::new());
    let calls = Arc::new(StdMutex::new(Vec::new()));

    let backend: Arc<dyn BrowserBackend> = Arc::new(OrderedMutatingBackend {
        release_tab1: release_tab1.clone(),
        tab1_started: tab1_started.clone(),
        calls: calls.clone(),
    });
    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
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
            "params": session_tab_params("session-1", "turn-1", "tab-1"),
            "id": 1,
        })))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), tab1_started.notified())
        .await
        .unwrap();
    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::DETACH,
            "params": session_tab_params("session-1", "turn-2", "tab-1"),
            "id": 2,
        })))
        .await
        .unwrap();
    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::ATTACH,
            "params": session_tab_params("session-2", "turn-1", "tab-2"),
            "id": 3,
        })))
        .await
        .unwrap();

    let cross_tab = read_json(&mut framed).await;
    assert_eq!(cross_tab["id"], 3);
    assert_eq!(cross_tab["result"], serde_json::Value::Null);
    assert_eq!(
        calls.lock().expect("ordered calls lock").as_slice(),
        ["attach:tab-1", "attach:tab-2"],
        "same-tab detach must not enter the backend until tab-1 attach completes"
    );

    release_tab1.notify_one();
    let first = read_json(&mut framed).await;
    let second = read_json(&mut framed).await;
    let mut ids = vec![
        first["id"].as_i64().unwrap(),
        second["id"].as_i64().unwrap(),
    ];
    ids.sort_unstable();
    assert_eq!(ids, [1, 2]);
    assert_eq!(
        calls.lock().expect("ordered calls lock").as_slice(),
        ["attach:tab-1", "attach:tab-2", "detach:tab-1"],
    );

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn session_lifecycle_waits_for_in_flight_same_session_tab_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session-lifecycle-ordering.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let release_attach = Arc::new(Notify::new());
    let attach_started = Arc::new(Notify::new());
    let calls = Arc::new(StdMutex::new(Vec::new()));

    let backend: Arc<dyn BrowserBackend> = Arc::new(BlockingSessionLifecycleBackend {
        release_attach: release_attach.clone(),
        attach_started: attach_started.clone(),
        calls: calls.clone(),
    });
    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
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
            "params": session_tab_params("session", "turn-1", "tab-1"),
            "id": 1,
        })))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), attach_started.notified())
        .await
        .unwrap();
    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::FINALIZE_TABS,
            "params": { "session_id": "session", "turn_id": "turn-2", "keep": [] },
            "id": 2,
        })))
        .await
        .unwrap();
    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::PING,
            "params": {},
            "id": 3,
        })))
        .await
        .unwrap();

    let ping = read_json(&mut framed).await;
    assert_eq!(ping["id"], 3);
    assert_eq!(ping["result"], "pong");
    assert_eq!(
        calls
            .lock()
            .expect("session lifecycle calls lock")
            .as_slice(),
        ["attach:tab-1"],
        "finalizeTabs must not enter the backend while a same-session tab mutation is running"
    );

    release_attach.notify_one();
    let first = read_json(&mut framed).await;
    let second = read_json(&mut framed).await;
    let mut ids = vec![
        first["id"].as_i64().unwrap(),
        second["id"].as_i64().unwrap(),
    ];
    ids.sort_unstable();
    assert_eq!(ids, [1, 2]);
    assert_eq!(
        calls
            .lock()
            .expect("session lifecycle calls lock")
            .as_slice(),
        ["attach:tab-1", "finalize:session"],
    );

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
            "params": {
                "session_id": "session-1",
                "turn_id": "turn-1",
                "tab_id": "tab-1",
                "client_timeout_ms": 10
            },
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
            "params": session_tab_params("session-1", "turn-1", "tab-1"),
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
            "params": session_tab_params("session-1", "turn-1", "tab-1"),
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

fn session_tab_params(session_id: &str, turn_id: &str, tab_id: &str) -> serde_json::Value {
    json!({
        "session_id": session_id,
        "turn_id": turn_id,
        "tab_id": tab_id,
    })
}

async fn read_json(framed: &mut Framed<UnixStream, FrameCodec>) -> serde_json::Value {
    let bytes = framed.next().await.unwrap().unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
