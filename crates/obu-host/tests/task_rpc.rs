#![cfg(unix)]

//! Integration coverage for the dispatcher's task RPC routing (Task 8).
//!
//! These tests drive a real `Dispatcher` over a Unix socket using the same
//! `FrameCodec` framing the SDK uses, so they exercise the full
//! `route_request` -> `route_method_family` -> `route_task_request` path
//! (including the Finding F1 capability-gate exemption and the
//! `require_mutation_context` lock path) rather than calling the handler
//! directly.

use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio_util::codec::Framed;

use obu_host::dispatcher::Dispatcher;
use obu_host::methods;
use obu_host::socket::{Listener, unix::UnixSockListener};
use obu_wire::FrameCodec;

#[tokio::test]
async fn tasks_list_returns_empty_store() {
    let dispatcher = Dispatcher::new_for_test_with_temp_task_store();
    let response = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    assert_eq!(response["result"], json!([]));
}

#[tokio::test]
async fn tasks_resume_rejects_missing_generation() {
    let dispatcher = Dispatcher::new_for_test_with_temp_task_store();
    let response = dispatch_for_test(
        &dispatcher,
        methods::TASKS_RESUME,
        json!({ "taskId": "task-1", "session_id": "session-1", "turn_id": "turn-1" }),
    )
    .await;
    assert_eq!(
        response["error"]["data"]["code"],
        "task_runtime_metadata_missing"
    );
}

async fn dispatch_for_test(dispatcher: &Dispatcher, method: &str, params: Value) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("task-rpc.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let server_dispatcher = dispatcher.clone();

    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        server_dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);
    framed
        .send(Bytes::from(
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
