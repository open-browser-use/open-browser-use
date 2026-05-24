#![cfg(unix)]

//! Integration coverage for the dispatcher's task RPC routing (Task 8).
//!
//! These tests drive a real `Dispatcher` over a Unix socket using the same
//! `FrameCodec` framing the SDK uses, so they exercise the full
//! `route_request` -> `route_method_family` -> `route_task_request` path
//! (including the Finding F1 capability-gate exemption and the
//! `require_mutation_context` lock path) rather than calling the handler
//! directly.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::UnixStream;
use tokio_util::codec::Framed;

use obu_host::backends::webext::{ExtensionTransport, WebExtensionBackend};
use obu_host::dispatcher::Dispatcher;
use obu_host::error::Result as HostResult;
use obu_host::methods;
use obu_host::socket::{Listener, unix::UnixSockListener};
use obu_wire::FrameCodec;
use obu_wire::error::ERR_NOT_FOUND;

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

#[tokio::test]
async fn tasks_export_unknown_task_returns_not_found() {
    let dispatcher = Dispatcher::new_for_test_with_temp_task_store();
    let response = dispatch_for_test(
        &dispatcher,
        methods::TASKS_EXPORT,
        json!({ "taskId": "missing-task" }),
    )
    .await;
    // §13: export of an unknown id is an explicit existence failure
    // (ERR_NOT_FOUND), not an empty `{ task_id, turns: [], events: [] }`.
    assert!(response.get("result").is_none(), "unexpected ok: {response:#}");
    assert_eq!(response["error"]["code"], ERR_NOT_FOUND);
    assert_eq!(response["error"]["data"]["code"], "unknown_task");
    assert_eq!(response["error"]["data"]["task_id"], "missing-task");
}

#[tokio::test]
async fn tasks_resume_unknown_task_returns_not_found() {
    let dispatcher = Dispatcher::new_for_test_with_temp_task_store();
    // Carry a trusted kernel generation in the frame-level runtime envelope so
    // the request clears the missing-generation guard and reaches the §13
    // existence check (rather than failing earlier on the generation).
    let response = dispatch_frame_for_test(
        &dispatcher,
        json!({
            "jsonrpc": "2.0",
            "method": methods::TASKS_RESUME,
            "params": { "taskId": "missing-task", "session_id": "s", "turn_id": "t" },
            "runtime": { "kernel_generation": 7 },
            "id": 1,
        }),
    )
    .await;
    assert!(response.get("result").is_none(), "unexpected ok: {response:#}");
    assert_eq!(response["error"]["code"], ERR_NOT_FOUND);
    assert_eq!(response["error"]["data"]["code"], "unknown_task");
    assert_eq!(response["error"]["data"]["task_id"], "missing-task");
}

/// Tab id the stub transport reports as closed by `finalizeTabs`, so tests can
/// assert the durable `tabs_finalized` evidence carries the REAL disposition
/// (not a constant). Numeric so it survives `normalize_finalize_response`'s
/// integer-or-decimal-string id validation; the host normalizes it to the
/// string `"42"`.
const FINALIZE_CLOSED_TAB_ID: i64 = 42;

/// Stub extension transport for a successful `finalizeTabs`.
///
/// `finalizeTabs` on the WebExtension backend requires a transport (the bare
/// `WebExtensionBackend::default()` has none and errors before any evidence could
/// be written). For `finalizeTabs` this returns a non-empty disposition (one
/// closed tab id) so the recorded evidence's `outcome` reflects actual finalize
/// results; every other method resolves to an empty object (the minimal shape
/// `normalize_finalize_response`/`turnEnded` accept). The closed tab is not
/// registered, which is fine: `remove_with_reason` is a tolerant no-op for an
/// unknown tab id.
struct OkTransport;

#[async_trait]
impl ExtensionTransport for OkTransport {
    async fn request(&self, method: &str, _params: Value) -> HostResult<Value> {
        Ok(match method {
            "finalizeTabs" => json!({ "closedTabIds": [FINALIZE_CLOSED_TAB_ID] }),
            _ => json!({}),
        })
    }
}

/// Build a dispatcher whose WebExtension backend can SUCCESSFULLY finalize a
/// session (a stub transport plus the session pre-registered as agent-owned), so
/// the finalize evidence side effect (Task 10) actually runs.
///
/// Reconciliation (reported to the planner): the plan's draft asserted
/// `result.status == "ok"`, but NO real `finalizeTabs` success shape in obu-host
/// carries a top-level `status` — the WebExtension backend returns the normalized
/// `{closed/released/kept/deliverable}` object, and the default backend trait
/// impl returns `null`. So these tests assert the load-bearing invariants the
/// plan actually cares about: finalize succeeds (no error) and writes exactly one
/// segment whose `turnId` is the current turn, and the recorded `tabs_finalized`
/// evidence's `outcome` reflects the backend's real disposition.
fn finalize_dispatcher(session_id: &str, turn_id: &str) -> Dispatcher {
    let backend = Arc::new(
        WebExtensionBackend::dev_chrome(json!({})).with_transport(Arc::new(OkTransport)),
    );
    // `finalizeTabs` calls `assert_agent_owns_session`, which only requires the
    // session to exist (and not be under human takeover). Pre-touch it.
    backend
        .registry()
        .touch_session(session_id, Some(turn_id))
        .expect("register agent-owned session");
    Dispatcher::new_for_test_with_backend_and_temp_task_store(backend)
}

#[tokio::test]
async fn finalize_only_first_write_creates_one_segment_and_event() {
    let dispatcher = finalize_dispatcher("session-1", "turn-1");
    let response = dispatch_for_test(
        &dispatcher,
        methods::FINALIZE_TABS,
        json!({ "session_id": "session-1", "turn_id": "turn-1", "keep": [] }),
    )
    .await;
    // Finalize must SUCCEED for evidence to be written (evidence is written only
    // after backend success). The real success shape has no top-level `status`.
    assert!(response.get("error").is_none(), "finalize failed: {response:#}");

    let tasks = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    assert_eq!(tasks["result"][0]["segmentCount"], 1);
    assert_eq!(tasks["result"][0]["lastSegment"]["turnId"], "turn-1");
}

/// The recorded `tabs_finalized` event carries the REAL finalize disposition, not
/// a constant: the stub backend reports tab `42` as closed, so the durable event's
/// `outcome.closedTabIds` must round-trip that exact id (host-normalized to a
/// string). Read back via `tasksExport`, whose events expose the serialized
/// payload string.
#[tokio::test]
async fn finalize_records_real_outcome_dispositions() {
    let dispatcher = finalize_dispatcher("session-1", "turn-1");
    let response = dispatch_for_test(
        &dispatcher,
        methods::FINALIZE_TABS,
        json!({ "session_id": "session-1", "turn_id": "turn-1", "keep": [] }),
    )
    .await;
    assert!(response.get("error").is_none(), "finalize failed: {response:#}");

    // Resolve the auto-created task id, then export its episode (events included).
    let tasks = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    let task_id = tasks["result"][0]["taskId"]
        .as_str()
        .expect("task id")
        .to_string();
    let export = dispatch_for_test(
        &dispatcher,
        methods::TASKS_EXPORT,
        json!({ "taskId": task_id }),
    )
    .await;

    // Find the tabs_finalized event and parse its serialized payload string.
    let events = export["result"]["events"]
        .as_array()
        .expect("events array");
    let finalized = events
        .iter()
        .find(|event| event["kind"] == "tabs_finalized")
        .expect("a tabs_finalized event");
    let payload: Value = serde_json::from_str(
        finalized["payload"].as_str().expect("payload is a string"),
    )
    .expect("payload parses as json");

    // The disposition is REAL data from the backend result, not a hardcoded value.
    assert_eq!(
        payload["outcome"]["closedTabIds"],
        json!([FINALIZE_CLOSED_TAB_ID.to_string()]),
        "tabs_finalized outcome must reflect the backend's closed tab; payload: {payload:#}"
    );
    // The honest constant-shape fields are present and empty (nothing else closed).
    assert_eq!(payload["outcome"]["keptTabs"], json!([]));
    assert_eq!(payload["outcome"]["releasedTabIds"], json!([]));
    // The fabricated always-"ok" status / always-[] failures keys are gone.
    assert!(payload.get("status").is_none(), "status should be removed: {payload:#}");
    assert!(payload.get("failures").is_none(), "failures should be removed: {payload:#}");
}

/// `turnEnded` also records evidence for the current turn's segment, auto-creating
/// and binding a task for a fresh session (Task 10).
#[tokio::test]
async fn turn_ended_first_write_creates_one_segment_and_event() {
    let dispatcher = finalize_dispatcher("session-2", "turn-9");
    let response = dispatch_for_test(
        &dispatcher,
        methods::TURN_ENDED,
        json!({ "session_id": "session-2", "turn_id": "turn-9" }),
    )
    .await;
    assert!(response.get("error").is_none(), "turnEnded failed: {response:#}");

    let tasks = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    assert_eq!(tasks["result"][0]["segmentCount"], 1);
    assert_eq!(tasks["result"][0]["lastSegment"]["turnId"], "turn-9");
}

/// A second finalize for the SAME turn must NOT create a second segment
/// (`ensure_turn_segment` is idempotent), though it appends a second event.
#[tokio::test]
async fn finalize_twice_same_turn_keeps_one_segment() {
    let dispatcher = finalize_dispatcher("session-1", "turn-1");
    let params = json!({ "session_id": "session-1", "turn_id": "turn-1", "keep": [] });
    for _ in 0..2 {
        let response = dispatch_for_test(&dispatcher, methods::FINALIZE_TABS, params.clone()).await;
        assert!(response.get("error").is_none(), "finalize failed: {response:#}");
    }

    let tasks = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    // Idempotent segment: still exactly one. Events accumulate (one per finalize).
    assert_eq!(tasks["result"][0]["segmentCount"], 1);
    assert_eq!(tasks["result"][0]["eventCursor"], 2);
    assert_eq!(tasks["result"][0]["lastSegment"]["turnId"], "turn-1");
}

async fn dispatch_for_test(dispatcher: &Dispatcher, method: &str, params: Value) -> Value {
    dispatch_frame_for_test(
        dispatcher,
        json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 1,
        }),
    )
    .await
}

/// Drive the dispatcher with an arbitrary request frame.
///
/// Used by tests that need a frame-level `runtime` envelope (the trusted
/// kernel-generation sibling of `params`), which `dispatch_for_test` omits.
async fn dispatch_frame_for_test(dispatcher: &Dispatcher, frame: Value) -> Value {
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
        .send(Bytes::from(serde_json::to_vec(&frame).unwrap()))
        .await
        .unwrap();

    let resp = framed.next().await.unwrap().unwrap();
    let value: Value = serde_json::from_slice(&resp).unwrap();
    drop(framed);
    server.await.unwrap();
    value
}
