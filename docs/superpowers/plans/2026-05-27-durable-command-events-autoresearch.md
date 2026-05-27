# Durable Command Events Autoresearch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-browser-command database events so autoresearch runs can be analyzed from `tasks.db`, not only from external ad hoc logs.

**Architecture:** The dispatcher already has the authoritative request boundary: method, params, session/turn context, policy/backend errors, and response status. Add a best-effort task-store actor command that resolves the current `(session_id, turn_id)` segment, appends a typed `browser_command` event, and keeps sensitive inputs summarized rather than stored verbatim.

**Tech Stack:** Rust `obu-host`, SQLite task store, JSON-RPC dispatcher tests, `cargo test -p obu-host`.

---

### Evidence

- The collected run in `artifacts/obu-db-log-run-20260527-130142` has 97 external action rows but the native task store contains only `turn_ended` rows.
- `crates/obu-host/src/dispatcher.rs` writes durable evidence only from `record_finalize_evidence` and `record_turn_ended_evidence`.
- `crates/obu-host/src/task_store_actor.rs` can already ensure a current segment and append typed events, but has no generic command-event actor message.

### Files

- Modify: `crates/obu-host/src/task_store_actor.rs`
- Modify: `crates/obu-host/src/dispatcher.rs`
- Test: `crates/obu-host/tests/task_rpc.rs`

### Task 1: Failing Integration Test

- [ ] **Step 1: Add a test proving normal tab commands write command events**

Add a test in `crates/obu-host/tests/task_rpc.rs` that:

```rust
#[tokio::test]
async fn tab_command_records_durable_browser_command_event() {
    let dispatcher = finalize_dispatcher("session-cmd", "turn-cmd");
    let response = dispatch_for_test(
        &dispatcher,
        methods::TAB_URL,
        json!({ "session_id": "session-cmd", "turn_id": "turn-cmd", "tab_id": "42" }),
    )
    .await;
    assert!(response.get("error").is_none(), "tab_url failed: {response:#}");

    let tasks = dispatch_for_test(&dispatcher, methods::TASKS_LIST, json!({ "limit": 10 })).await;
    let task_id = tasks["result"][0]["taskId"].as_str().expect("task id").to_string();
    let export = dispatch_for_test(&dispatcher, methods::TASKS_EXPORT, json!({ "taskId": task_id })).await;
    let events = export["result"]["events"].as_array().expect("events array");
    let command = events.iter().find(|event| event["kind"] == "browser_command").expect("browser_command event");
    let payload: Value = serde_json::from_str(command["payload"].as_str().expect("payload string")).expect("payload json");

    assert_eq!(payload["method"], methods::TAB_URL);
    assert_eq!(payload["status"], "ok");
    assert_eq!(payload["tabId"], "42");
    assert!(payload["durationMs"].as_u64().is_some());
    assert_eq!(payload["params"]["tab_id"], "42");
}
```

- [ ] **Step 2: Add a test proving typed/fill text is redacted**

Add a test that dispatches `playwrightLocatorFill` with `"value": "secret-password"` and asserts the `browser_command` payload contains `params.value.redacted == true`, `params.value.length == 15`, and does not contain the secret string.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
cargo test -p obu-host --test task_rpc tab_command_records_durable_browser_command_event playwright_fill_command_redacts_typed_value -- --nocapture
```

Expected: both tests fail because no `browser_command` event exists.

### Task 2: Task Store Actor Command Event API

- [ ] **Step 1: Add the actor message**

Add a `RecordCommandEvent` variant to `TaskStoreCommand`:

```rust
RecordCommandEvent {
    session_id: String,
    turn_id: String,
    generation: Option<i64>,
    event: Value,
    reply: oneshot::Sender<Result<(), String>>,
},
```

- [ ] **Step 2: Add `TaskStoreHandle::record_command_event`**

Mirror the existing `record_turn_ended_evidence` async shape and return `Result<()>`.

- [ ] **Step 3: Add the actor-thread helper**

Implement:

```rust
fn record_command_event(
    store: &TaskStore,
    session_id: &str,
    turn_id: &str,
    generation: Option<i64>,
    event: Value,
) -> Result<(), String>
```

It must call `ensure_current_turn_segment`, merge `kind`, `taskId`, `segmentId`, `sessionId`, `turnId`, and `at`, then call `append_typed_event(&task_id, "browser_command", payload)`.

### Task 3: Dispatcher Event Capture

- [ ] **Step 1: Wrap `route_request`**

Move the current body into `route_request_inner` and keep `route_request` as the command-observability wrapper. Capture `Instant::now()`, `method`, `ctx`, and a redacted params summary before routing.

- [ ] **Step 2: Append command events after response**

After `route_request_inner` returns, call `record_command_event` only when a task store exists and both `session_id` and `turn_id` are non-empty. The event must contain:

```json
{
  "kind": "browser_command",
  "method": "tab_url",
  "status": "ok",
  "durationMs": 4,
  "tabId": "42",
  "params": { "tab_id": "42" }
}
```

For errors, use `"status": "error"` and include `{ "code": <wire code>, "message": <message>, "data": <data> }`.

- [ ] **Step 3: Redact sensitive params**

Summarize `text`, `value`, `password`, `token`, `authorization`, `cookie`, `html`, `content`, `script`, and `expression` as `{ "redacted": true, "length": N }`. Keep selectors, URLs, tab ids, coordinates, method names, timeouts, load states, and small structural objects because they are required for replay/debugging.

### Task 4: Verify, Install, and Re-run Autoresearch

- [ ] **Step 1: Run focused tests**

```bash
cargo test -p obu-host --test task_rpc tab_command_records_durable_browser_command_event playwright_fill_command_redacts_typed_value -- --nocapture
```

Expected: PASS.

- [ ] **Step 2: Run host tests**

```bash
cargo test -p obu-host
```

Expected: PASS.

- [ ] **Step 3: Build release artifacts needed for local install**

Inspect repo scripts before copying binaries, then update `/Users/labrinyang/.obu` with the built native host/CLI/SDK pieces and rebuild extension into `packages/extension/dist`.

- [ ] **Step 4: Refresh extension**

```bash
/Users/labrinyang/.obu/bin/obu update-extension --path /Users/labrinyang/projects/open-browser-use-public/packages/extension/dist --channel=unpacked-dev
/Users/labrinyang/.obu/bin/obu verify --agent=codex-cli --browser=chrome --channel=unpacked-dev --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj --repair
```

- [ ] **Step 5: Re-run the 14-task prompt suite**

Use open-browser-use, starting with `browser_status`, then execute the tasks in `prompts/test-prompt.md`. Back up `/tmp/obu-501/tasks/tasks.db` and verify `select kind,count(*) from task_events group by kind` includes substantial `browser_command` rows.

### Self-Review

- Spec coverage: The plan addresses the native database logging gap discovered by autoresearch and includes post-install re-run evidence. It does not claim to resolve all future lifecycle/state-machine issues; those require the next loop after richer logs exist.
- Placeholder scan: No task contains TBD or unspecified implementation.
- Type consistency: The event kind is consistently `browser_command`; task-store APIs use existing `Value`, `Result`, and `append_typed_event` patterns.
