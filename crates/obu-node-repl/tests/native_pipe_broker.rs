#![cfg(unix)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::{SinkExt, StreamExt};
use obu_node_repl::native_pipe::broker::NativePipeBroker;
use obu_node_repl::native_pipe::protocol::{KernelIn, NativePipeOp, NativePipeRequest};
use obu_wire::FrameCodec;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tokio_util::codec::Framed;

#[tokio::test]
async fn broker_connects_writes_and_emits_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backend.sock");
    let listener = UnixListener::bind(&path).unwrap();

    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 5];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
        stream.write_all(b"world").await.unwrap();
    });

    let (tx, mut rx) = mpsc::channel(8);
    let broker = Arc::new(NativePipeBroker::new(
        tx,
        Duration::from_secs(2),
        Some(vec![std::fs::canonicalize(&path).unwrap()]),
    ));

    let response = broker
        .dispatch(NativePipeRequest {
            id: "native-pipe-0".into(),
            token: "tok".into(),
            op: NativePipeOp::Connect {
                path: path.display().to_string(),
            },
        })
        .await;
    assert!(response.ok, "connect response: {response:?}");
    let connection_id = response
        .result
        .as_ref()
        .and_then(|value| value.get("connection_id"))
        .and_then(serde_json::Value::as_str)
        .unwrap()
        .to_string();

    let response = broker
        .dispatch(NativePipeRequest {
            id: "native-pipe-1".into(),
            token: "tok".into(),
            op: NativePipeOp::Write {
                connection_id: connection_id.clone(),
                data_base64: B64.encode(b"hello"),
            },
        })
        .await;
    assert!(response.ok, "write response: {response:?}");

    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    match event {
        KernelIn::NativePipeData(data) => {
            assert_eq!(data.connection_id, connection_id);
            assert_eq!(B64.decode(data.data_base64).unwrap(), b"world");
        }
        other => panic!("expected data event, got {other:?}"),
    }

    server.await.unwrap();
}

#[tokio::test]
async fn broker_rejects_relative_paths() {
    let (tx, _rx) = mpsc::channel(8);
    let broker = Arc::new(NativePipeBroker::new(tx, Duration::from_secs(2), None));
    let response = broker
        .dispatch(NativePipeRequest {
            id: "native-pipe-0".into(),
            token: "tok".into(),
            op: NativePipeOp::Connect {
                path: "relative.sock".into(),
            },
        })
        .await;
    assert!(!response.ok);
    assert!(
        response
            .error
            .as_deref()
            .unwrap_or("")
            .contains("native pipe path must be absolute")
    );
}

#[tokio::test]
async fn broker_uses_path_specific_capability_token_after_canonicalization() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tokened.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut framed = Framed::new(stream, FrameCodec);
        let bytes = framed.next().await.unwrap().unwrap();
        let auth: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(auth["method"], "auth");
        assert_eq!(auth["params"]["capability_token"], "per-socket-token");
        framed
            .send(bytes::Bytes::from(
                serde_json::to_vec(&serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": auth["id"].clone(),
                    "result": null
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
    });

    let (tx, _rx) = mpsc::channel(8);
    let broker = Arc::new(NativePipeBroker::with_token_map(
        tx,
        Duration::from_secs(2),
        Some(vec![canonical.clone()]),
        Some("fallback-token".to_string()),
        [(canonical, "per-socket-token".to_string())]
            .into_iter()
            .collect(),
        Arc::new(AtomicBool::new(false)),
    ));

    let response = broker
        .dispatch(NativePipeRequest {
            id: "native-pipe-0".into(),
            token: "tok".into(),
            op: NativePipeOp::Connect {
                path: path.display().to_string(),
            },
        })
        .await;
    assert!(response.ok, "connect response: {response:?}");

    server.await.unwrap();
}

#[tokio::test]
async fn broker_marks_inventory_dirty_when_connection_closes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backend.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();

    // The host accepts the connection then immediately drops it (process death /
    // MV3 service-worker recycle): the broker's read loop observes EOF.
    let server = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
    });

    let dirty = Arc::new(AtomicBool::new(false));
    let (tx, mut rx) = mpsc::channel(8);
    let broker = Arc::new(NativePipeBroker::with_token_map(
        tx,
        Duration::from_secs(2),
        Some(vec![canonical]),
        None,
        HashMap::new(),
        dirty.clone(),
    ));

    let response = broker
        .dispatch(NativePipeRequest {
            id: "native-pipe-0".into(),
            token: "tok".into(),
            op: NativePipeOp::Connect {
                path: path.display().to_string(),
            },
        })
        .await;
    assert!(response.ok, "connect response: {response:?}");

    // The read loop emits a close event AND flags the inventory dirty so the next
    // exec re-discovers the live backend descriptor (new socket after restart).
    let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(event, KernelIn::NativePipeClosed(_)),
        "expected a close event, got {event:?}"
    );
    assert!(
        dirty.load(Ordering::Acquire),
        "broker must flag the backend inventory dirty when a native-pipe connection closes"
    );

    server.await.unwrap();
}

#[tokio::test]
async fn broker_clears_inventory_dirty_on_successful_connect() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backend.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();

    // Hold the accepted connection open so the broker's read loop does not observe
    // a close before we assert (which would re-flag the inventory dirty).
    let server = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
    });

    // A prior disconnect left the inventory flagged dirty.
    let dirty = Arc::new(AtomicBool::new(true));
    let (tx, _rx) = mpsc::channel(8);
    let broker = Arc::new(NativePipeBroker::with_token_map(
        tx,
        Duration::from_secs(2),
        Some(vec![canonical]),
        None,
        HashMap::new(),
        dirty.clone(),
    ));

    let response = broker
        .dispatch(NativePipeRequest {
            id: "native-pipe-0".into(),
            token: "tok".into(),
            op: NativePipeOp::Connect {
                path: path.display().to_string(),
            },
        })
        .await;
    assert!(response.ok, "connect response: {response:?}");
    assert!(
        !dirty.load(Ordering::Acquire),
        "a successful connect means the host is reachable again, so dirty must clear"
    );

    server.await.unwrap();
}

#[tokio::test]
async fn broker_uses_refreshed_path_specific_capability_token() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tokened.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let canonical = std::fs::canonicalize(&path).unwrap();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut framed = Framed::new(stream, FrameCodec);
        let bytes = framed.next().await.unwrap().unwrap();
        let auth: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(auth["method"], "auth");
        assert_eq!(auth["params"]["capability_token"], "refreshed-token");
        framed
            .send(bytes::Bytes::from(
                serde_json::to_vec(&serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": auth["id"].clone(),
                    "result": null
                }))
                .unwrap(),
            ))
            .await
            .unwrap();
    });

    let (tx, _rx) = mpsc::channel(8);
    let broker = Arc::new(NativePipeBroker::with_token_map(
        tx,
        Duration::from_secs(2),
        Some(vec![canonical.clone()]),
        None,
        HashMap::new(),
        Arc::new(AtomicBool::new(false)),
    ));
    broker.set_capability_tokens_by_path(
        [(canonical, "refreshed-token".to_string())]
            .into_iter()
            .collect(),
    );

    let response = broker
        .dispatch(NativePipeRequest {
            id: "native-pipe-0".into(),
            token: "tok".into(),
            op: NativePipeOp::Connect {
                path: path.display().to_string(),
            },
        })
        .await;
    assert!(response.ok, "connect response: {response:?}");

    server.await.unwrap();
}
