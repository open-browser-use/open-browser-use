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
use obu_host::backends::{BackendKind, BackendRequestContext, BrowserBackend};
use obu_host::dispatcher::Dispatcher;
use obu_host::error::{HostError, Result as HostResult};
use obu_host::methods;
use obu_host::socket::{Listener, unix::UnixSockListener};
use obu_wire::FrameCodec;
use obu_wire::error::{ERR_CONFLICT, ERR_NOT_FOUND};

#[tokio::test]
async fn tasks_list_returns_empty_store() {
    let dispatcher = Dispatcher::new_for_test_with_temp_task_store();
    let response =
        dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
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
    assert!(
        response.get("result").is_none(),
        "unexpected ok: {response:#}"
    );
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
    assert!(
        response.get("result").is_none(),
        "unexpected ok: {response:#}"
    );
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

struct CommandEventBackend;

#[async_trait]
impl BrowserBackend for CommandEventBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::WebExtension
    }

    fn id(&self) -> &str {
        "command-event-test"
    }

    async fn current_url_for_policy(
        &self,
        _ctx: &BackendRequestContext,
        _tab_id: &str,
    ) -> HostResult<String> {
        Ok("https://example.test/current".into())
    }

    async fn tab_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        _params: Value,
    ) -> HostResult<Value> {
        Ok(json!({ "method": method }))
    }

    async fn playwright_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        _params: Value,
    ) -> HostResult<Value> {
        Ok(json!({ "method": method }))
    }
}

struct FailingCommandBackend;

#[async_trait]
impl BrowserBackend for FailingCommandBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::WebExtension
    }

    fn id(&self) -> &str {
        "failing-command-test"
    }

    async fn current_url_for_policy(
        &self,
        _ctx: &BackendRequestContext,
        _tab_id: &str,
    ) -> HostResult<String> {
        Ok("https://example.test/current".into())
    }

    async fn tab_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _method: &str,
        _params: Value,
    ) -> HostResult<Value> {
        Err(HostError::NotImplemented("synthetic tab failure".into()))
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
    let backend =
        Arc::new(WebExtensionBackend::dev_chrome(json!({})).with_transport(Arc::new(OkTransport)));
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
    assert!(
        response.get("error").is_none(),
        "finalize failed: {response:#}"
    );

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
    assert!(
        response.get("error").is_none(),
        "finalize failed: {response:#}"
    );

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
    let events = export["result"]["events"].as_array().expect("events array");
    let finalized = events
        .iter()
        .find(|event| event["kind"] == "tabs_finalized")
        .expect("a tabs_finalized event");
    let payload: Value =
        serde_json::from_str(finalized["payload"].as_str().expect("payload is a string"))
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
    assert!(
        payload.get("status").is_none(),
        "status should be removed: {payload:#}"
    );
    assert!(
        payload.get("failures").is_none(),
        "failures should be removed: {payload:#}"
    );
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
    assert!(
        response.get("error").is_none(),
        "turnEnded failed: {response:#}"
    );

    let tasks = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    assert_eq!(tasks["result"][0]["segmentCount"], 1);
    assert_eq!(tasks["result"][0]["lastSegment"]["turnId"], "turn-9");
}

#[tokio::test]
async fn tab_command_records_durable_browser_command_event() {
    let dispatcher =
        Dispatcher::new_for_test_with_backend_and_temp_task_store(Arc::new(CommandEventBackend));
    let response = dispatch_for_test(
        &dispatcher,
        methods::TAB_URL,
        json!({ "session_id": "session-cmd", "turn_id": "turn-cmd", "tab_id": "42" }),
    )
    .await;
    assert!(
        response.get("error").is_none(),
        "tab_url failed: {response:#}"
    );

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
    let events = export["result"]["events"].as_array().expect("events array");
    let command = events
        .iter()
        .find(|event| event["kind"] == "browser_command")
        .expect("browser_command event");
    let payload: Value =
        serde_json::from_str(command["payload"].as_str().expect("payload is a string"))
            .expect("payload parses as json");

    assert_eq!(payload["method"], methods::TAB_URL);
    assert_eq!(payload["status"], "ok");
    assert_eq!(payload["tabId"], "42");
    assert!(payload["durationMs"].as_u64().is_some());
    assert_eq!(payload["params"]["tab_id"], "42");
}

#[tokio::test]
async fn playwright_fill_command_redacts_typed_value() {
    let dispatcher =
        Dispatcher::new_for_test_with_backend_and_temp_task_store(Arc::new(CommandEventBackend));
    let response = dispatch_for_test(
        &dispatcher,
        methods::PLAYWRIGHT_LOCATOR_FILL,
        json!({
            "session_id": "session-fill",
            "turn_id": "turn-fill",
            "tab_id": "42",
            "selector": "#password",
            "value": "secret-password"
        }),
    )
    .await;
    assert!(
        response.get("error").is_none(),
        "locator fill failed: {response:#}"
    );

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
    let events = export["result"]["events"].as_array().expect("events array");
    let command = events
        .iter()
        .find(|event| event["kind"] == "browser_command")
        .expect("browser_command event");
    let payload_text = command["payload"].as_str().expect("payload is a string");
    assert!(
        !payload_text.contains("secret-password"),
        "typed value leaked into durable payload: {payload_text}"
    );
    let payload: Value = serde_json::from_str(payload_text).expect("payload parses as json");

    assert_eq!(payload["method"], methods::PLAYWRIGHT_LOCATOR_FILL);
    assert_eq!(payload["params"]["value"]["redacted"], true);
    assert_eq!(payload["params"]["value"]["length"], 15);
    assert_eq!(payload["params"]["selector"], "#password");
}

#[tokio::test]
async fn failed_command_records_durable_error_event() {
    let dispatcher =
        Dispatcher::new_for_test_with_backend_and_temp_task_store(Arc::new(FailingCommandBackend));
    let response = dispatch_for_test(
        &dispatcher,
        methods::TAB_TITLE,
        json!({ "session_id": "session-error", "turn_id": "turn-error", "tab_id": "42" }),
    )
    .await;
    assert!(
        response.get("error").is_some(),
        "tab_title unexpectedly succeeded: {response:#}"
    );

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
    let events = export["result"]["events"].as_array().expect("events array");
    let command = events
        .iter()
        .find(|event| event["kind"] == "browser_command")
        .expect("browser_command event");
    let payload: Value =
        serde_json::from_str(command["payload"].as_str().expect("payload is a string"))
            .expect("payload parses as json");

    assert_eq!(payload["method"], methods::TAB_TITLE);
    assert_eq!(payload["status"], "error");
    assert_eq!(payload["tabId"], "42");
    assert!(
        payload["error"]["message"]
            .as_str()
            .expect("error message")
            .contains("synthetic tab failure")
    );
}

/// A second finalize for the SAME turn must NOT create a second segment
/// (`ensure_turn_segment` is idempotent), though it appends a second event.
#[tokio::test]
async fn finalize_twice_same_turn_keeps_one_segment() {
    let dispatcher = finalize_dispatcher("session-1", "turn-1");
    let params = json!({ "session_id": "session-1", "turn_id": "turn-1", "keep": [] });
    for _ in 0..2 {
        let response = dispatch_for_test(&dispatcher, methods::FINALIZE_TABS, params.clone()).await;
        assert!(
            response.get("error").is_none(),
            "finalize failed: {response:#}"
        );
    }

    let tasks = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    // Idempotent segment: still exactly one. Events accumulate (one per finalize).
    assert_eq!(tasks["result"][0]["segmentCount"], 1);
    assert_eq!(tasks["result"][0]["eventCursor"], 4);
    assert_eq!(tasks["result"][0]["lastSegment"]["turnId"], "turn-1");

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
    let events = export["result"]["events"].as_array().expect("events array");
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "tabs_finalized")
            .count(),
        2
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "browser_command")
            .count(),
        2
    );
}

/// Two distinct sessions racing to resume the SAME task: the first wins the
/// at-most-one pending-attempt slot (`begin_resume_attempt` inserts a fresh
/// pending row), the second collides because a pending attempt for a *different*
/// `(session_id, turn_id)` already exists and `begin_resume_attempt` bails with
/// `task_resume_conflict` (host-mapped to `ERR_CONFLICT`).
///
/// The task must EXIST first, so we drive it through a SUCCESSFUL finalize on a
/// dispatcher whose finalize session (`session-a`) is registered as agent-owned
/// (`finalize_dispatcher`) — finalize auto-creates+binds the task (Task 10).
/// `resume` is a task method exempt from the capability gate and from
/// `assert_agent_owns_session`, so the resuming sessions (`session-b`/`session-c`)
/// need NOT be registered.
///
/// Both resumes carry their trusted kernel generation in the frame-level
/// `runtime` envelope (a sibling of `params`, NOT inside it). Without that
/// envelope the FIRST resume would never reach the conflict path — it would fail
/// earlier with `task_runtime_metadata_missing` (Finding F2), exactly as the
/// `tasks_resume_rejects_missing_generation` test asserts.
#[tokio::test]
async fn concurrent_resume_same_task_returns_conflict() {
    let dispatcher = finalize_dispatcher("session-a", "turn-a");
    let task_id = create_task_via_finalize(&dispatcher, "session-a", "turn-a").await;

    let first = dispatch_resume(&dispatcher, &task_id, "session-b", "turn-b", 7).await;
    assert!(
        first.get("result").is_some(),
        "first resume should win the pending slot: {first:#}"
    );

    let second = dispatch_resume(&dispatcher, &task_id, "session-c", "turn-c", 7).await;
    assert!(
        second.get("result").is_none(),
        "second resume should not succeed: {second:#}"
    );
    assert_eq!(second["error"]["code"], ERR_CONFLICT);
    assert_eq!(second["error"]["data"]["code"], "task_resume_conflict");
}

/// A blocked resume completion must persist the SDK's REAL failure detail into
/// durable evidence, not a dropped `reason: null`.
///
/// The SDK (packages/sdk/src/browser-tasks.ts) commits a terminal
/// `tasksResumeComplete` with `{ status:"blocked", repair: <repairPlan> }` (and
/// `error: <wireError>` for attach_failed/observation_failed) — it never sends
/// `reason`. We begin a resume (extracting the `resumeToken` the begin result
/// returns), complete it as `blocked` with a concrete `repair` object, then read
/// the durable `resume_attempt_blocked` event back via `tasksExport` and assert
/// the recorded payload round-tripped that exact `repair` — proving the detail
/// reached storage rather than being silently discarded.
#[tokio::test]
async fn resume_complete_blocked_persists_real_repair_detail() {
    let dispatcher = finalize_dispatcher("session-a", "turn-a");
    let task_id = create_task_via_finalize(&dispatcher, "session-a", "turn-a").await;

    let begin = dispatch_resume(&dispatcher, &task_id, "session-b", "turn-b", 7).await;
    let resume_token = begin["result"]["resumeToken"]
        .as_str()
        .expect("begin returns a resumeToken")
        .to_string();

    let repair = json!({ "action": "reauthenticate", "url": "https://login.example.test/" });
    let complete = dispatch_resume_complete(
        &dispatcher,
        json!({
            "taskId": task_id,
            "session_id": "session-b",
            "turn_id": "turn-b",
            "resumeToken": resume_token,
            "status": "blocked",
            "repair": repair,
        }),
        7,
    )
    .await;
    assert!(
        complete.get("error").is_none(),
        "complete failed: {complete:#}"
    );
    assert_eq!(complete["result"]["status"], "blocked");

    // Read the durable evidence back: the resume_attempt_blocked event's payload
    // string must carry the real `repair`, NOT `reason: null`.
    let export = dispatch_for_test(
        &dispatcher,
        methods::TASKS_EXPORT,
        json!({ "taskId": task_id }),
    )
    .await;
    let events = export["result"]["events"].as_array().expect("events array");
    let blocked = events
        .iter()
        .find(|event| event["kind"] == "resume_attempt_blocked")
        .expect("a resume_attempt_blocked event");
    let payload: Value =
        serde_json::from_str(blocked["payload"].as_str().expect("payload is a string"))
            .expect("payload parses as json");

    assert_eq!(payload["status"], "blocked");
    assert_eq!(
        payload["repair"], repair,
        "blocked evidence must carry the SDK's real repair plan; payload: {payload:#}"
    );
    // The dropped-detail bug persisted `reason: null` instead of `repair`.
    assert!(
        payload.get("reason").is_none(),
        "stale `reason` key must be gone; payload: {payload:#}"
    );
}

/// Send a `tasksResumeComplete` with a trusted generation envelope (sibling of
/// `params`), mirroring how the SDK commits the terminal completion.
async fn dispatch_resume_complete(
    dispatcher: &Dispatcher,
    params: Value,
    generation: i64,
) -> Value {
    dispatch_frame_for_test(
        dispatcher,
        json!({
            "jsonrpc": "2.0",
            "method": methods::TASKS_RESUME_COMPLETE,
            "params": params,
            "runtime": { "kernel_generation": generation },
            "id": 1,
        }),
    )
    .await
}

/// Resume with a trusted generation envelope at the frame top level (a sibling of
/// `params`). Reuses `dispatch_frame_for_test` (the existing raw-frame helper) so
/// the `runtime` envelope rides the wire exactly as the SDK sends it.
async fn dispatch_resume(
    dispatcher: &Dispatcher,
    task_id: &str,
    session_id: &str,
    turn_id: &str,
    generation: i64,
) -> Value {
    dispatch_frame_for_test(
        dispatcher,
        json!({
            "jsonrpc": "2.0",
            "method": methods::TASKS_RESUME,
            "params": { "taskId": task_id, "session_id": session_id, "turn_id": turn_id },
            "runtime": { "kernel_generation": generation },
            "id": 1,
        }),
    )
    .await
}

/// Drive a successful finalize (which auto-creates+binds a task on a
/// `finalize_dispatcher`) and return the resulting task id via `tasksList`.
async fn create_task_via_finalize(
    dispatcher: &Dispatcher,
    session_id: &str,
    turn_id: &str,
) -> String {
    let _ = dispatch_for_test(
        dispatcher,
        methods::FINALIZE_TABS,
        json!({ "session_id": session_id, "turn_id": turn_id, "keep": [] }),
    )
    .await;
    let tasks = dispatch_for_test(dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    tasks["result"][0]["taskId"]
        .as_str()
        .expect("auto-created task id")
        .to_string()
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
        server_dispatcher
            .serve_peer(peer.stream, None)
            .await
            .unwrap();
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
