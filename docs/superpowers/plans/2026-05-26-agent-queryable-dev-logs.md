# Agent-Queryable Dev Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a disabled-by-default local dev-log mode that records OBU runs to append-only NDJSON, rebuildable SQLite/FTS, and MCP query tools across MCP, node-repl, SDK, host, and extension boundaries.

**Architecture:** The Rust `obu-node-repl` process owns the canonical run writer, sequence allocation, NDJSON files, SQLite index, and MCP query tools. The Node kernel and SDK emit event drafts through a `dev_log_event` JSONL frame; host and extension lifecycle facts enter through existing diagnostics surfaces and are normalized by node-repl/SDK before persistence.

**Tech Stack:** Rust 2024, `rmcp`, `rusqlite` with FTS5, NDJSON, Tokio, TypeScript ESM, Vitest, Chromium extension diagnostics, existing OBU native-pipe wire protocol.

---

## Scope Check

The spec spans multiple subsystems: Rust storage/query, MCP wrapping, Node kernel protocol, SDK instrumentation, host diagnostics, extension diagnostics, pruning, and docs. Keep this as one vertical-slice plan because no subsystem is useful without the Rust writer/query foundation, but commit after each task and keep every task independently testable.

## File Structure

- `crates/obu-node-repl/src/dev_log/mod.rs`: public module exports, `DevLogConfig`, `DevLogAggregator`, and test helpers.
- `crates/obu-node-repl/src/dev_log/event.rs`: `DevLogEvent`, event draft structs, operation/source/redaction/pruning/artifact types.
- `crates/obu-node-repl/src/dev_log/source_anchor.rs`: registry of stable source anchors and CodeGraph-friendly queries.
- `crates/obu-node-repl/src/dev_log/redaction.rs`: redaction and payload budgeting used before persistence.
- `crates/obu-node-repl/src/dev_log/writer.rs`: run manifest creation, sequence allocation, NDJSON append, run start/finish events.
- `crates/obu-node-repl/src/dev_log/index.rs`: SQLite schema, insert, FTS maintenance, rebuild from NDJSON.
- `crates/obu-node-repl/src/dev_log/query.rs`: `logs_list_runs`, `logs_timeline`, `logs_search`, `logs_sql`, `logs_failure_context`, `logs_source_context`, `logs_rebuild_index`.
- `docs/superpowers/schemas/dev-log-event.schema.json`: shared Rust/TypeScript event and kernel-frame contract.
- `docs/superpowers/schemas/fixtures/dev-log/*.ndjson`: cross-language contract fixtures.
- `crates/obu-node-repl/src/cli.rs`: `--dev-logs`, log dir, and run id flags/env parsing.
- `crates/obu-node-repl/src/mcp_server.rs`: create aggregator, wrap non-log MCP tools, add log query tools.
- `crates/obu-node-repl/src/repl_manager/mod.rs`: emit kernel lifecycle events and demux `dev_log_event` frames.
- `crates/obu-node-repl/src/repl_manager/spawn.rs`: pass `OBU_DEV_LOG*` through minimal Node kernel environment.
- `crates/obu-node-repl/src/native_pipe/protocol.rs`: add typed `dev_log_event` kernel frame.
- `crates/obu-node-repl/src/native_pipe/broker.rs`: emit native-pipe lifecycle drafts.
- `crates/obu-node-repl/embedded/kernel.js`: install the kernel-side dev-log sink.
- `packages/sdk/src/dev-log.ts`: SDK log sink, source anchors, redaction helpers, method wrappers.
- `packages/sdk/src/browsers.ts`: backend discovery, selection, no-backend, and connect events.
- `packages/sdk/src/browser.ts`, `packages/sdk/src/browser-tasks.ts`, `packages/sdk/src/browser_tabs.ts`, `packages/sdk/src/browser_user.ts`: Browser-level `sdk.method.*` and task lifecycle events.
- `packages/sdk/src/tab.ts`, `packages/sdk/src/tab-*.ts`, `packages/sdk/src/high-level-action.ts`, `packages/sdk/src/wire/transport.ts`: observe/action/high-level/RPC/source-anchor event emission.
- `crates/obu-host/src/dispatcher.rs`, `crates/obu-host/src/task_lifecycle.rs`: expose host peer/task diagnostics in existing host-visible diagnostics.
- `packages/extension/src/lifecycle/`, `packages/extension/src/native_transport_controller.ts`, `packages/extension/src/background.ts`: preserve structured extension lifecycle snapshots for `extension.lifecycle`.
- `docs/troubleshooting.md`: agent-facing query examples and privacy notes.

## Task 1: Rust Dev-Log Event Model, Source Anchors, And Redaction

**Files:**
- Modify: `crates/obu-node-repl/Cargo.toml`
- Modify: `crates/obu-node-repl/src/lib.rs`
- Create: `docs/superpowers/schemas/dev-log-event.schema.json`
- Create: `docs/superpowers/schemas/fixtures/dev-log/valid-basic.ndjson`
- Create: `docs/superpowers/schemas/fixtures/dev-log/invalid-missing-required-family-fields.ndjson`
- Create: `crates/obu-node-repl/src/dev_log/mod.rs`
- Create: `crates/obu-node-repl/src/dev_log/event.rs`
- Create: `crates/obu-node-repl/src/dev_log/source_anchor.rs`
- Create: `crates/obu-node-repl/src/dev_log/redaction.rs`

- [ ] **Step 1: Write the failing event/redaction/source-anchor unit tests**

Add these tests to `crates/obu-node-repl/src/dev_log/redaction.rs` and `crates/obu-node-repl/src/dev_log/source_anchor.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_sensitive_payload_keys_without_touching_join_ids() {
        let input = json!({
            "ids": { "sessionId": "session-1", "turnId": "turn-1" },
            "input": {
                "password": "secret",
                "nested": { "api_key": "abc", "safe": "ok" },
                "sessionStorage": { "token": "raw" }
            }
        });

        let redacted = redact_value(&input, RedactionLimits::default());

        assert_eq!(redacted.value["ids"]["sessionId"], "session-1");
        assert_eq!(redacted.value["input"]["password"], "[REDACTED]");
        assert_eq!(redacted.value["input"]["nested"]["api_key"], "[REDACTED]");
        assert_eq!(redacted.value["input"]["sessionStorage"], "[REDACTED]");
        assert!(redacted.redacted_paths.contains(&"input.password".to_string()));
        assert!(redacted.redacted_paths.contains(&"input.nested.api_key".to_string()));
    }

    #[test]
    fn caps_string_array_and_object_depth_for_summaries() {
        let input = json!({
            "long": "abcdefghijklmnopqrstuvwxyz",
            "items": [1, 2, 3, 4],
            "deep": { "a": { "b": { "c": "hidden" } } }
        });
        let limits = RedactionLimits {
            max_string_len: 8,
            max_array_len: 2,
            max_depth: 2,
        };

        let redacted = redact_value(&input, limits);

        assert_eq!(redacted.value["long"], "abcdefgh...[truncated]");
        assert_eq!(redacted.value["items"].as_array().unwrap().len(), 2);
        assert_eq!(redacted.value["deep"]["a"], "[DEPTH_LIMIT]");
    }
}
```

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_required_p0_source_anchors() {
        let keys = registry().iter().map(|anchor| anchor.key).collect::<Vec<_>>();
        for required in [
            "mcp.call_tool",
            "mcp.call_js",
            "node.JsRuntimeManager.lifecycle",
            "node.NativePipeBroker.dispatch",
            "sdk.Browsers.get",
            "sdk.selectBackend",
            "sdk.Browser.method",
            "sdk.BrowserTasks.resume",
            "sdk.Tab.observe",
            "sdk.Tab.step",
            "sdk.Tab.subdomain",
            "sdk.Transport.sendRequest",
            "sdk.HighLevelActionResult.transition",
            "host.Dispatcher.dispatch_frame",
            "host.Dispatcher.serve_peer",
            "host.TaskLifecycle.transition",
            "host.native_messaging.run",
            "extension.NativeTransportController.connect",
            "extension.BrowserSessionController",
            "extension.NativeHostBridge.resolveResponse",
            "extension.appendDebugLog",
        ] {
            assert!(keys.contains(&required), "missing source anchor {required}");
        }
    }

    #[test]
    fn every_source_anchor_has_codegraph_friendly_query() {
        for anchor in registry() {
            assert!(!anchor.key.is_empty());
            assert!(!anchor.symbol.is_empty());
            assert!(anchor.query.contains(anchor.symbol.split('.').next_back().unwrap()));
            assert!(
                anchor.query.contains(".rs") || anchor.query.contains(".ts"),
                "query must name a source file: {}",
                anchor.query
            );
        }
    }
}
```

Also add cross-language contract fixtures before implementing the Rust types:

- `valid-basic.ndjson` contains `run.started`, `mcp.tool.started`,
  `mcp.tool.finished`, `extension.lifecycle`, and `run.finished` events with
  `ingestedAt`, optional `occurredAt`, source anchors, and pairing ids.
- `invalid-missing-required-family-fields.ndjson` contains request-shaped
  events missing required `ids.correlationId`, `operation.status`, or
  `source.entrypoint.key`.

Rust tests must load the fixtures, validate them against
`dev-log-event.schema.json`, and assert that event-family validation rejects the
invalid fixture. Task 6 adds the matching TypeScript fixture tests; do not let
the Rust and TypeScript event shapes drift independently.

- [ ] **Step 2: Run the tests and confirm they fail**

Run:

```bash
cargo test -p obu-node-repl dev_log
```

Expected: FAIL with unresolved module `dev_log`, missing schema/fixture validation helpers, or missing functions `redact_value` and `registry`.

- [ ] **Step 3: Add module exports and event/source/redaction types**

In `crates/obu-node-repl/src/lib.rs`, add:

```rust
pub mod dev_log;
```

In `crates/obu-node-repl/Cargo.toml`, add `rusqlite` to runtime dependencies for SQLite indexing in Task 2:

```toml
rusqlite = { workspace = true }
```

Create `crates/obu-node-repl/src/dev_log/mod.rs`:

```rust
pub mod event;
pub mod redaction;
pub mod source_anchor;

pub use event::{
    DevLogArtifactRef, DevLogDropped, DevLogEvent, DevLogEventDraft, DevLogIds, DevLogOperation,
    DevLogPruning, DevLogRedaction, DevLogSource, DevLogState, validate_event_family,
};
pub use redaction::{RedactedValue, RedactionLimits, redact_value};
pub use source_anchor::{SourceAnchor, source_anchor, registry};
```

Create `crates/obu-node-repl/src/dev_log/event.rs` with these public shapes:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogEvent {
    pub schema_version: u8,
    pub seq: u64,
    pub ingested_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurred_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monotonic_ms: Option<u64>,
    pub run_id: String,
    pub component: String,
    pub event: String,
    pub level: String,
    #[serde(default)]
    pub ids: DevLogIds,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<DevLogState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<DevLogSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<DevLogOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redaction: Option<DevLogRedaction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<DevLogArtifactRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped: Option<DevLogDropped>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pruning: Option<DevLogPruning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogIds {
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub task_id: Option<String>,
    pub tab_id: Option<Value>,
    pub request_id: Option<Value>,
    pub action_id: Option<String>,
    pub observation_id: Option<String>,
    pub correlation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogState {
    pub machine: String,
    pub from: Option<String>,
    pub to: Option<String>,
    #[serde(default)]
    pub trace: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogSource {
    pub entrypoint: Option<Value>,
    pub emitter: Option<Value>,
    pub codegraph: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogOperation {
    pub kind: String,
    pub name: String,
    pub status: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogRedaction {
    pub applied: bool,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub redacted_paths: Vec<String>,
    #[serde(default)]
    pub omitted_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogArtifactRef {
    pub id: String,
    pub kind: String,
    pub uri: Option<String>,
    pub path: Option<String>,
    pub mime_type: Option<String>,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub summary: Option<String>,
    pub retained: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogDropped {
    pub count: u64,
    pub source_component: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogPruning {
    pub payload_bytes: Option<u64>,
    pub stored_bytes: Option<u64>,
    pub strategy: Option<String>,
    pub target: Option<Value>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevLogEventDraft {
    pub component: String,
    pub event: String,
    pub level: String,
    pub occurred_at: Option<String>,
    #[serde(default)]
    pub ids: DevLogIds,
    pub state: Option<DevLogState>,
    pub source: Option<DevLogSource>,
    pub operation: Option<DevLogOperation>,
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub error: Option<Value>,
    pub next_action: Option<String>,
    pub summary: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<DevLogArtifactRef>,
    pub dropped: Option<DevLogDropped>,
    pub pruning: Option<DevLogPruning>,
    pub text: Option<String>,
}

impl Default for DevLogEventDraft {
    fn default() -> Self {
        Self {
            component: String::new(),
            event: String::new(),
            level: "info".to_string(),
            occurred_at: None,
            ids: DevLogIds::default(),
            state: None,
            source: None,
            operation: None,
            input: None,
            output: None,
            error: None,
            next_action: None,
            summary: None,
            artifacts: Vec::new(),
            dropped: None,
            pruning: None,
            text: None,
        }
    }
}

impl DevLogEventDraft {
    pub fn default_for_test() -> Self {
        Self {
            component: "test".into(),
            event: "test.event".into(),
            ..Self::default()
        }
    }
}

```

Add `validate_event_family(draft: &DevLogEventDraft) -> Result<(), String>` in
`event.rs`. It enforces the per-event-family required fields from the design spec
before persistence. Request-shaped families must have a pairing id, operation
status, and `source.entrypoint.key`; envelope events such as `run.started`,
`run.finished`, `log.dropped`, and `log.pruned` are allowed to omit operation.

Create `crates/obu-node-repl/src/dev_log/source_anchor.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceAnchor {
    pub key: &'static str,
    pub symbol: &'static str,
    pub package: Option<&'static str>,
    pub file: &'static str,
    pub language: &'static str,
    pub query: &'static str,
}

pub const SOURCE_ANCHORS: &[SourceAnchor] = &[
    SourceAnchor { key: "mcp.call_tool", symbol: "ObuServer.call_tool", package: Some("obu-node-repl"), file: "crates/obu-node-repl/src/mcp_server.rs", language: "rust", query: "ObuServer call_tool crates/obu-node-repl/src/mcp_server.rs" },
    SourceAnchor { key: "mcp.call_js", symbol: "ObuServer.call_js", package: Some("obu-node-repl"), file: "crates/obu-node-repl/src/mcp_server.rs", language: "rust", query: "ObuServer call_js crates/obu-node-repl/src/mcp_server.rs" },
    SourceAnchor { key: "node.JsRuntimeManager.lifecycle", symbol: "JsRuntimeManager.boot_locked", package: Some("obu-node-repl"), file: "crates/obu-node-repl/src/repl_manager/mod.rs", language: "rust", query: "JsRuntimeManager boot_locked crates/obu-node-repl/src/repl_manager/mod.rs" },
    SourceAnchor { key: "node.NativePipeBroker.dispatch", symbol: "NativePipeBroker.dispatch", package: Some("obu-node-repl"), file: "crates/obu-node-repl/src/native_pipe/broker.rs", language: "rust", query: "NativePipeBroker dispatch crates/obu-node-repl/src/native_pipe/broker.rs" },
    SourceAnchor { key: "sdk.Browsers.get", symbol: "Browsers.get", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/browsers.ts", language: "typescript", query: "Browsers get packages/sdk/src/browsers.ts" },
    SourceAnchor { key: "sdk.selectBackend", symbol: "selectBackend", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/browsers.ts", language: "typescript", query: "selectBackend packages/sdk/src/browsers.ts" },
    SourceAnchor { key: "sdk.Browser.method", symbol: "Browser", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/browser.ts", language: "typescript", query: "Browser packages/sdk/src/browser.ts" },
    SourceAnchor { key: "sdk.BrowserTasks.resume", symbol: "BrowserTasks.resume", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/browser-tasks.ts", language: "typescript", query: "BrowserTasks resume packages/sdk/src/browser-tasks.ts" },
    SourceAnchor { key: "sdk.Tab.observe", symbol: "Tab.observe", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/tab.ts", language: "typescript", query: "Tab.observe packages/sdk/src/tab.ts" },
    SourceAnchor { key: "sdk.Tab.step", symbol: "Tab.step", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/tab.ts", language: "typescript", query: "Tab.step packages/sdk/src/tab.ts" },
    SourceAnchor { key: "sdk.Tab.subdomain", symbol: "Tab", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/tab.ts", language: "typescript", query: "Tab clipboard content cua dev dom_cua playwright packages/sdk/src/tab.ts" },
    SourceAnchor { key: "sdk.Transport.sendRequest", symbol: "Transport.sendRequest", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/wire/transport.ts", language: "typescript", query: "Transport.sendRequest packages/sdk/src/wire/transport.ts" },
    SourceAnchor { key: "sdk.HighLevelActionResult.transition", symbol: "HighLevelActionResult.transition", package: Some("@open-browser-use/sdk"), file: "packages/sdk/src/high-level-action.ts", language: "typescript", query: "HighLevelActionResult.transition packages/sdk/src/high-level-action.ts" },
    SourceAnchor { key: "host.Dispatcher.dispatch_frame", symbol: "Dispatcher.dispatch_frame", package: Some("obu-host"), file: "crates/obu-host/src/dispatcher.rs", language: "rust", query: "Dispatcher dispatch_frame crates/obu-host/src/dispatcher.rs" },
    SourceAnchor { key: "host.Dispatcher.serve_peer", symbol: "Dispatcher.serve_peer", package: Some("obu-host"), file: "crates/obu-host/src/dispatcher.rs", language: "rust", query: "Dispatcher serve_peer crates/obu-host/src/dispatcher.rs" },
    SourceAnchor { key: "host.TaskLifecycle.transition", symbol: "TaskLifecycle.transition", package: Some("obu-host"), file: "crates/obu-host/src/task_lifecycle.rs", language: "rust", query: "TaskLifecycle transition crates/obu-host/src/task_lifecycle.rs" },
    SourceAnchor { key: "host.native_messaging.run", symbol: "run", package: Some("obu-host"), file: "crates/obu-host/src/native_messaging.rs", language: "rust", query: "native_messaging run crates/obu-host/src/native_messaging.rs" },
    SourceAnchor { key: "extension.NativeTransportController.connect", symbol: "NativeTransportController.connect", package: Some("@open-browser-use/extension"), file: "packages/extension/src/native_transport_controller.ts", language: "typescript", query: "NativeTransportController connect packages/extension/src/native_transport_controller.ts" },
    SourceAnchor { key: "extension.BrowserSessionController", symbol: "BrowserSessionController", package: Some("@open-browser-use/extension"), file: "packages/extension/src/browser_session_controller.ts", language: "typescript", query: "BrowserSessionController packages/extension/src/browser_session_controller.ts" },
    SourceAnchor { key: "extension.NativeHostBridge.resolveResponse", symbol: "NativeHostBridge.resolveResponse", package: Some("@open-browser-use/extension"), file: "packages/extension/src/native_host_bridge.ts", language: "typescript", query: "NativeHostBridge resolveResponse packages/extension/src/native_host_bridge.ts" },
    SourceAnchor { key: "extension.appendDebugLog", symbol: "appendDebugLog", package: Some("@open-browser-use/extension"), file: "packages/extension/src/background.ts", language: "typescript", query: "appendDebugLog packages/extension/src/background.ts" },
];

pub fn registry() -> &'static [SourceAnchor] {
    SOURCE_ANCHORS
}

pub fn source_anchor(key: &str) -> Option<&'static SourceAnchor> {
    SOURCE_ANCHORS.iter().find(|anchor| anchor.key == key)
}
```

Create `crates/obu-node-repl/src/dev_log/redaction.rs` with an explicit recursive
walker rather than ad hoc string replacement:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct RedactedValue {
    pub value: serde_json::Value,
    pub redacted_paths: Vec<String>,
    pub omitted_paths: Vec<String>,
}
```

`redact_value` tracks dotted JSON paths while walking objects and arrays. It
must preserve control-plane join keys under `ids`, redact matching payload keys
for `token`, `password`, `secret`, `auth`, `cookie`, `credential`, `api_key`,
`sessionStorage`, `localStorage`, and `cookies`, cap strings and arrays, replace
objects beyond `max_depth` with `[DEPTH_LIMIT]`, and record the paths that were
redacted or omitted. Task 2 wires `redacted_paths`/`omitted_paths` into
`event.redaction` and the SQLite `redaction_json` column.

- [ ] **Step 4: Run the focused unit tests**

Run:

```bash
cargo test -p obu-node-repl dev_log::redaction dev_log::source_anchor
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/obu-node-repl/Cargo.toml crates/obu-node-repl/src/lib.rs crates/obu-node-repl/src/dev_log docs/superpowers/schemas
git commit -m "feat: add dev log event model"
```

## Task 2: NDJSON Writer, SQLite Index, And Query Core

**Files:**
- Create: `crates/obu-node-repl/src/dev_log/writer.rs`
- Create: `crates/obu-node-repl/src/dev_log/index.rs`
- Create: `crates/obu-node-repl/src/dev_log/query.rs`
- Modify: `crates/obu-node-repl/src/dev_log/mod.rs`

- [ ] **Step 1: Write failing writer/index/query tests**

Add this test module to `crates/obu-node-repl/src/dev_log/mod.rs`:

```rust
#[cfg(test)]
mod integration_tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn writer_appends_ndjson_and_indexes_events() {
        let temp = tempdir().unwrap();
        let config = DevLogConfig::enabled(temp.path().to_path_buf(), "run-test-1".to_string());
        let aggregator = DevLogAggregator::start(config).unwrap();

        aggregator.record(DevLogEventDraft {
            component: "sdk".into(),
            event: "backend.select".into(),
            level: "info".into(),
            operation: Some(DevLogOperation {
                kind: "backend".into(),
                name: "selectBackend".into(),
                status: Some("succeeded".into()),
                duration_ms: Some(3),
            }),
            summary: Some("selected webextension chrome".into()),
            output: Some(json!({ "backend": "webextension", "name": "chrome" })),
            ..DevLogEventDraft::default_for_test()
        }).unwrap();
        aggregator.finish("succeeded").unwrap();

        let run_dir = temp.path().join("run-test-1");
        let ndjson = std::fs::read_to_string(run_dir.join("events.ndjson")).unwrap();
        assert!(ndjson.contains(r#""event":"run.started""#));
        assert!(ndjson.contains(r#""event":"backend.select""#));
        assert!(ndjson.contains(r#""seq":1"#));

        let rows = query::timeline(temp.path(), "run-test-1", query::TimelineFilter::default()).unwrap();
        assert_eq!(rows.iter().filter(|row| row.event == "backend.select").count(), 1);

        let search = query::search(temp.path(), "webextension", 10).unwrap();
        assert_eq!(search[0].event, "backend.select");
    }

    #[test]
    fn rebuild_index_restores_events_from_ndjson() {
        let temp = tempdir().unwrap();
        let config = DevLogConfig::enabled(temp.path().to_path_buf(), "run-rebuild-1".to_string());
        let aggregator = DevLogAggregator::start(config).unwrap();
        aggregator.record(DevLogEventDraft {
            component: "mcp".into(),
            event: "mcp.tool.finished".into(),
            level: "info".into(),
            summary: Some("browser_status succeeded".into()),
            ..DevLogEventDraft::default_for_test()
        }).unwrap();
        aggregator.finish("succeeded").unwrap();

        std::fs::remove_file(temp.path().join("index.sqlite")).unwrap();
        query::rebuild_index(temp.path(), None).unwrap();

        let rows = query::search(temp.path(), "browser_status", 10).unwrap();
        assert_eq!(rows[0].event, "mcp.tool.finished");
    }
}
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
cargo test -p obu-node-repl writer_appends_ndjson_and_indexes_events
cargo test -p obu-node-repl rebuild_index_restores_events_from_ndjson
```

Expected: FAIL with missing `DevLogConfig`, `DevLogAggregator`, or query functions.

- [ ] **Step 3: Implement writer/index/query public API**

Update `crates/obu-node-repl/src/dev_log/mod.rs`:

```rust
pub mod index;
pub mod query;
pub mod writer;

pub use writer::{DevLogAggregator, DevLogConfig};
```

`DevLogConfig::enabled(root, run_id)` stores logs directly under `root` in tests and under `$OBU_RUNTIME_DIR/logs/dev` from CLI in integration code. Also expose `DevLogConfig::enabled_with_optional_run_id(root, explicit_run_id)` or an equivalent constructor that generates `YYYYMMDDTHHMMSSmmmZ-<short-random>` when `explicit_run_id` is `None`. Validate every explicit `run_id` before any `root.join(&run_id)`: it must be one safe path segment matching `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and must reject path separators, `.`/`..`, drive prefixes, control characters, and percent-encoded separators. Invalid explicit run ids fail before creating files. `DevLogAggregator::start` must:

```rust
std::fs::create_dir_all(root.join(&run_id))?;
std::fs::write(root.join("manifest.json"), serde_json::to_vec_pretty(&parent_manifest)?)?;
std::fs::write(root.join(&run_id).join("manifest.json"), serde_json::to_vec_pretty(&run_manifest)?)?;
```

`DevLogAggregator` must expose a cloneable producer handle backed by a bounded channel and a single writer task. MCP wrappers, the stdout demux, and diagnostic importers may call `record()` concurrently, but the writer task is the only code path that assigns `seq`, assigns `ingestedAt`, appends to `events.ndjson`, and attempts index insertion. Internally, the writer task owns the `seq`, NDJSON file handle, and SQLite connection behind one serialized loop; do not share a `rusqlite::Connection` across producer tasks. `record()` must enqueue without waiting on file or SQLite work; if the queue is full, coalesce a later `log.dropped` event rather than blocking browser automation.

The writer validates event-family required fields, redacts the draft payload, preserves caller-provided `occurredAt` when present, and wires the redaction result into `event.redaction` and SQLite `redaction_json`. It then applies the payload budget before persistence: after redaction, inline payload JSON is capped at 32 KB, larger payloads become summaries, artifact refs, or explicit dropped markers, and screenshots/binary displays are never stored as inline base64 in the SQLite summary path. `payload_json` must contain this budgeted representation, not the raw unbounded payload, and `pruning.strategy` must be set to `inline`, `summary`, `artifact_ref`, or `dropped` for non-trivial storage decisions. The writer appends one JSON object plus `\n` to `events.ndjson`, and then inserts the same budgeted event into SQLite in one short transaction. `finish(status)` must enqueue and flush `run.finished`, wait for all earlier queued events, and update `runs.finished_at/status`.

`events.ndjson` is authoritative. `index.sqlite` is a rebuildable global index shared by all retained runs, so index writes must be best-effort under cross-process contention. Configure SQLite with WAL, a bounded `busy_timeout`, and short transactions. If the index is locked past the allowed budget, keep the NDJSON event, increment an index-miss counter in the run manifest, and rely on `logs_rebuild_index` to restore query coverage.

In `index.rs`, create schema matching the spec:

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  schema_version INTEGER NOT NULL,
  obu_version TEXT,
  runtime_dir TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ingested_at TEXT NOT NULL,
  occurred_at TEXT,
  component TEXT NOT NULL,
  event TEXT NOT NULL,
  level TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  task_id TEXT,
  tab_id TEXT,
  request_id TEXT,
  action_id TEXT,
  observation_id TEXT,
  correlation_id TEXT,
  machine TEXT,
  state_from TEXT,
  state_to TEXT,
  source_entry_key TEXT,
  source_symbol TEXT,
  source_file TEXT,
  source_package TEXT,
  emitter_key TEXT,
  emitter_symbol TEXT,
  codegraph_query TEXT,
  operation_kind TEXT,
  operation_name TEXT,
  operation_status TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  product_error_code TEXT,
  next_action TEXT,
  summary TEXT,
  redaction_json TEXT,
  artifact_refs_json TEXT,
  prune_target_run_id TEXT,
  prune_target_seq INTEGER,
  prune_target_artifact_id TEXT,
  prune_target_payload_path TEXT,
  prune_reason TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  run_id UNINDEXED,
  seq UNINDEXED,
  event,
  component,
  operation_name,
  source_entry_key,
  source_symbol,
  source_file,
  summary,
  error_code,
  product_error_code,
  next_action,
  prune_reason
);
```

Initialize each writer connection with:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 250;
```

Use a separate read-only SQLite connection for query tools.

`index::insert_event` must insert one row into `events` and one matching row into
`events_fts` in the same transaction. `query::rebuild_index` must clear and
repopulate both `events` and `events_fts` from retained NDJSON records; otherwise
`logs_search` will be empty after live writes or rebuilds.

In `query.rs`, expose typed rows:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    pub run_id: String,
    pub seq: u64,
    pub ingested_at: String,
    pub occurred_at: Option<String>,
    pub event: String,
    pub component: String,
    pub operation_name: Option<String>,
    pub operation_status: Option<String>,
    pub error_code: Option<String>,
    pub product_error_code: Option<String>,
    pub source_entry_key: Option<String>,
    pub codegraph_query: Option<String>,
    pub summary: Option<String>,
    pub payload_json: serde_json::Value,
}

#[derive(Debug, Clone, Default)]
pub struct TimelineFilter {
    pub component: Option<String>,
    pub turn_id: Option<String>,
    pub machine: Option<String>,
    pub only_errors: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunRow {
    pub run_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub event_count: u64,
    pub first_error_summary: Option<String>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceContextRow {
    pub source_entry_key: String,
    pub source_symbol: Option<String>,
    pub source_file: Option<String>,
    pub codegraph_query: Option<String>,
    pub event_count: u64,
    pub failed_count: u64,
    pub latest_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RebuildIndexResult {
    pub run_count: u64,
    pub event_count: u64,
}
```

Add focused tests that prove the write contract:

- explicit run ids reject path traversal and unsafe path components before
  creating files;
- concurrent producers produce strictly increasing, gap-free `seq` values in `events.ndjson`;
- imported events preserve caller-provided `occurredAt` while assigning
  aggregator-owned `ingestedAt` and `seq`;
- a locked or unavailable `index.sqlite` does not lose the NDJSON event and can be repaired by `query::rebuild_index`;
- read query connections do not share the writer connection;
- live writes populate FTS so `query::search` works before any rebuild;
- `query::rebuild_index` repopulates FTS after deleting `index.sqlite`;
- payloads above the 32 KB post-redaction inline cap are summarized or moved to
  artifacts before SQLite insertion, with `pruning.strategy` and redaction
  metadata preserved.

- [ ] **Step 4: Run focused tests**

Run:

```bash
cargo test -p obu-node-repl writer_appends_ndjson_and_indexes_events
cargo test -p obu-node-repl rebuild_index_restores_events_from_ndjson
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/obu-node-repl/src/dev_log
git commit -m "feat: persist and query dev logs"
```

## Task 3: CLI Flags, Dev-Log Config, And Environment Propagation

**Files:**
- Modify: `crates/obu-node-repl/src/cli.rs`
- Modify: `crates/obu-node-repl/src/repl_manager/mod.rs`
- Modify: `crates/obu-node-repl/src/repl_manager/spawn.rs`
- Modify: `packages/cli/src/index.ts`
- Test: `crates/obu-node-repl/tests/mcp_stdio.rs`
- Test: `packages/cli/src/index.test.ts`

- [ ] **Step 1: Write failing Rust env propagation test**

Add this test to `crates/obu-node-repl/tests/mcp_stdio.rs`:

```rust
#[tokio::test]
async fn dev_logs_flag_is_visible_inside_node_kernel() {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let log_dir = runtime_dir.path().join("logs").join("dev");
    let mut child = Command::new(bin)
        .arg("--dev-logs")
        .arg("--dev-log-dir")
        .arg(&log_dir)
        .arg("--dev-log-run-id")
        .arg("run-env-test")
        .arg("mcp")
        .arg("stdio")
        .env("OBU_RUNTIME_DIR", runtime_dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
        while let Ok(Some(_line)) = lines.next_line().await {}
    });

    send_initialize(&mut stdin).await;
    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "({ enabled: process.env.OBU_DEV_LOG, dir: process.env.OBU_DEV_LOG_DIR, runId: process.env.OBU_DEV_LOG_RUN_ID })"
                }
            }
        }),
    ).await;

    let mut reader = BufReader::new(stdout).lines();
    let _init = read_json(&mut reader).await;
    let exec = read_json(&mut reader).await;
    assert_eq!(exec["result"]["structuredContent"]["result"]["enabled"], "1");
    assert_eq!(exec["result"]["structuredContent"]["result"]["runId"], "run-env-test");
    assert!(exec["result"]["structuredContent"]["result"]["dir"].as_str().unwrap().ends_with("logs/dev"));
}
```

Add two adjacent tests in the same file:

- `dev_logs_env_one_enables_without_cli_flag`: starts `obu-node-repl mcp stdio`
  with `OBU_DEV_LOG=1` and no `--dev-logs`, then asserts SDK code sees
  `process.env.OBU_DEV_LOG === "1"` and an `events.ndjson` file is created.
- `dev_logs_generate_default_run_id_when_absent`: starts
  `obu-node-repl mcp stdio --dev-logs` without `--dev-log-run-id`, then asserts
  the run directory name matches `YYYYMMDDTHHMMSSmmmZ-<short-random>` and that
  the same generated id is visible inside the Node kernel as
  `process.env.OBU_DEV_LOG_RUN_ID`.

If `send_initialize` does not exist, extract the existing initialize calls in this test file into a helper:

```rust
async fn send_initialize(stdin: &mut tokio::process::ChildStdin) {
    send(stdin, json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "obu-node-repl-test", "version": "0.0.0" }
        }
    })).await;
    send(stdin, json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    })).await;
}
```

- [ ] **Step 2: Run the Rust test and confirm failure**

Run:

```bash
cargo test -p obu-node-repl --test mcp_stdio dev_logs_flag_is_visible_inside_node_kernel
cargo test -p obu-node-repl --test mcp_stdio dev_logs_env_one_enables_without_cli_flag
cargo test -p obu-node-repl --test mcp_stdio dev_logs_generate_default_run_id_when_absent
```

Expected: FAIL with unknown argument `--dev-logs`, env-only enablement not wired,
or missing generated run id.

- [ ] **Step 3: Implement Rust CLI flags and spawn env pass-through**

In `crates/obu-node-repl/src/cli.rs`, add to `Cli`:

```rust
#[arg(long, action = clap::ArgAction::SetTrue)]
pub dev_logs: bool,

#[arg(long, env = "OBU_DEV_LOG_DIR")]
pub dev_log_dir: Option<PathBuf>,

#[arg(long, env = "OBU_DEV_LOG_RUN_ID")]
pub dev_log_run_id: Option<String>,
```

Do not rely on clap's bool env parsing for `OBU_DEV_LOG`: the documented value
`OBU_DEV_LOG=1` must work. Add a helper such as:

```rust
fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}
```

Treat dev logs as enabled when `cli.dev_logs || env_flag_enabled("OBU_DEV_LOG")`.
Reject unsupported env values only if the implementation wants strict diagnostics;
do not silently treat the documented value `1` as false.

Validate `dev_log_run_id` using the same single-segment rule as
`DevLogConfig::enabled`. CLI/env values that fail validation must return a clear
argument error before `ManagerOptions` is constructed or any log path is joined.

In `ManagerOptions`, add the resolved config, not just raw CLI strings:

```rust
pub dev_log_config: Option<DevLogConfig>,
```

`ManagerOptions::from_cli` must resolve:

- disabled mode: `dev_log_config = None`;
- root: `cli.dev_log_dir` or `$OBU_RUNTIME_DIR/logs/dev`;
- run id: explicit `cli.dev_log_run_id` / `OBU_DEV_LOG_RUN_ID`, otherwise a
  generated `YYYYMMDDTHHMMSSmmmZ-<short-random>` id from Rust;
- validation: explicit run ids use the same safe single-segment rule as Task 2.

`ManagerOptions::for_tests()` sets `dev_log_config = None` unless a test opts in.
This is the construction point that prevents `obu mcp stdio --dev-logs` without
`--dev-log-run-id` from reaching the server with no run id.

In `SpawnOptions`, add the resolved dev-log env values, and in `set_minimal_env`:

```rust
if let Some(dev_log) = &opts.dev_log_config {
    cmd.env("OBU_DEV_LOG", "1");
    cmd.env("OBU_DEV_LOG_DIR", &dev_log.root);
    cmd.env("OBU_DEV_LOG_RUN_ID", &dev_log.run_id);
}
```

- [ ] **Step 4: Add CLI wrapper flag propagation**

In `packages/cli/src/index.ts`, extend `ParsedArgs`:

```ts
devLogs: boolean;
devLogDir?: string;
devLogRunId?: string;
```

Initialize defaults:

```ts
devLogs: false,
```

Parse flags:

```ts
case "--dev-logs":
  args.devLogs = true;
  break;
case "--dev-log-dir":
  args.devLogDir = readValue();
  break;
case "--dev-log-run-id":
  args.devLogRunId = readValue();
  break;
```

Change `runMcpStdio` to pass args and append node-repl args:

```ts
if (args.command === "mcp" && args.subject === "stdio") {
  return runMcpStdio(args);
}

async function runMcpStdio(args: ParsedArgs): Promise<number> {
  // existing validation stays
  const nodeReplArgs = [
    ...(args.devLogs ? ["--dev-logs"] : []),
    ...(args.devLogDir ? ["--dev-log-dir", args.devLogDir] : []),
    ...(args.devLogRunId ? ["--dev-log-run-id", args.devLogRunId] : []),
    "mcp",
    "stdio",
  ];
  const child = spawn(layout.nodeReplBin, nodeReplArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      OBU_NODE_BINARY: layout.nodeBin,
      OBU_NODE_REPL_MODULE_DIRS: layout.nodeModulesRoot,
      OBU_RUNTIME_DIR: layout.runtimeDir,
      ...(args.devLogs ? { OBU_DEV_LOG: "1" } : {}),
      ...(args.devLogDir ? { OBU_DEV_LOG_DIR: args.devLogDir } : {}),
      ...(args.devLogRunId ? { OBU_DEV_LOG_RUN_ID: args.devLogRunId } : {}),
    },
  });
  // existing promise code stays
}
```

Update `resolveMcpInvocation` to accept `args` and include `--dev-logs` in generated configs:

```ts
async function resolveMcpInvocation(
  openBrowserUseCommand: string,
  cliEntry: string,
  opts: { devLogs?: boolean } = {},
): Promise<{ command: string; args: string[] }> {
  const devArgs = opts.devLogs ? ["--dev-logs"] : [];
  const command = path.isAbsolute(openBrowserUseCommand)
    ? openBrowserUseCommand
    : path.resolve(process.cwd(), openBrowserUseCommand);
  if (await executableExists(command)) {
    return { command, args: ["mcp", "stdio", ...devArgs] };
  }
  return {
    command: process.execPath,
    args: [cliEntry, "mcp", "stdio", ...devArgs],
  };
}
```

- [ ] **Step 5: Run focused CLI tests**

Run:

```bash
cargo test -p obu-node-repl --test mcp_stdio dev_logs_flag_is_visible_inside_node_kernel
cargo test -p obu-node-repl --test mcp_stdio dev_logs_env_one_enables_without_cli_flag
cargo test -p obu-node-repl --test mcp_stdio dev_logs_generate_default_run_id_when_absent
pnpm --filter @open-browser-use/cli typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/obu-node-repl/src/cli.rs crates/obu-node-repl/src/repl_manager crates/obu-node-repl/tests/mcp_stdio.rs packages/cli/src/index.ts
git commit -m "feat: enable dev log mode from CLI"
```

## Task 4: MCP Tool Wrapping And Log Query Tools

**Files:**
- Modify: `crates/obu-node-repl/src/mcp_server.rs`
- Modify: `crates/obu-node-repl/src/dev_log/query.rs`
- Test: `crates/obu-node-repl/tests/mcp_stdio.rs`

- [ ] **Step 1: Write failing MCP logging/query integration test**

Add this test to `crates/obu-node-repl/tests/mcp_stdio.rs`:

```rust
#[tokio::test]
async fn dev_logs_record_non_log_tools_and_query_tools_do_not_contaminate_run() {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let log_dir = runtime_dir.path().join("logs").join("dev");
    let mut child = Command::new(bin)
        .arg("--dev-logs")
        .arg("--dev-log-dir")
        .arg(&log_dir)
        .arg("--dev-log-run-id")
        .arg("run-mcp-test")
        .arg("mcp")
        .arg("stdio")
        .env("OBU_RUNTIME_DIR", runtime_dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
        while let Ok(Some(_line)) = lines.next_line().await {}
    });

    send_initialize(&mut stdin).await;
    send(&mut stdin, json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "browser_status", "arguments": {} }
    })).await;
    send(&mut stdin, json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "logs_timeline",
            "arguments": { "run_id": "run-mcp-test" }
        }
    })).await;

    let mut reader = BufReader::new(stdout).lines();
    let _init = read_json(&mut reader).await;
    let status = read_json(&mut reader).await;
    assert_eq!(status["id"], 2);
    let timeline = read_json(&mut reader).await;
    assert_eq!(timeline["id"], 3);

    let events = timeline["result"]["structuredContent"]["events"].as_array().unwrap();
    assert!(events.iter().any(|event| event["event"] == "mcp.tool.started" && event["operation_name"] == "browser_status"));
    assert!(events.iter().any(|event| event["event"] == "mcp.tool.finished" && event["operation_name"] == "browser_status"));
    assert!(!events.iter().any(|event| event["operation_name"] == "logs_timeline"));
}
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
cargo test -p obu-node-repl --test mcp_stdio dev_logs_record_non_log_tools_and_query_tools_do_not_contaminate_run
cargo test -p obu-node-repl --test mcp_stdio logs_failure_context_includes_real_failure_neighbors
```

Expected: FAIL with tool `logs_timeline`/`logs_failure_context` not found or
missing log events.

- [ ] **Step 3: Add query tool schemas and tool names**

In `ObuServer::tools()`, add tools:

```rust
Tool::new("logs_list_runs", "Return recent dev-log runs.", LOGS_LIST_RUNS_SCHEMA.clone()),
Tool::new("logs_timeline", "Return ordered events for one dev-log run.", LOGS_TIMELINE_SCHEMA.clone()),
Tool::new("logs_search", "Search dev-log events with SQLite FTS.", LOGS_SEARCH_SCHEMA.clone()),
Tool::new("logs_sql", "Run guarded read-only SQL against the dev-log index.", LOGS_SQL_SCHEMA.clone()),
Tool::new("logs_failure_context", "Return context around one failure event.", LOGS_FAILURE_CONTEXT_SCHEMA.clone()),
Tool::new("logs_source_context", "Group dev-log events by source anchor.", LOGS_SOURCE_CONTEXT_SCHEMA.clone()),
Tool::new("logs_rebuild_index", "Rebuild the dev-log SQLite index from NDJSON.", LOGS_REBUILD_INDEX_SCHEMA.clone()),
```

Update existing exact tool-list assertions in `crates/obu-node-repl/src/mcp_server.rs`
and `crates/obu-node-repl/tests/mcp_stdio.rs` in the same task. They currently
assert the old five-tool list, so adding `logs_*` without updating those tests
will fail unrelated verification.

Each query tool returns `structuredContent` with explicit keys:

```rust
json!({
    "schemaVersion": 1,
    "run_id": args.run_id,
    "events": rows,
})
```

In `crates/obu-node-repl/src/dev_log/query.rs`, expose one function per MCP query tool so routing does not call undefined helpers:

```rust
pub fn list_runs(root: &Path, limit: usize) -> Result<Vec<RunRow>>;
pub fn timeline(root: &Path, run_id: &str, filter: TimelineFilter) -> Result<Vec<EventRow>>;
pub fn search(root: &Path, query: &str, limit: usize) -> Result<Vec<EventRow>>;
pub fn sql(root: &Path, sql: &str, limit: usize) -> Result<Vec<serde_json::Value>>;
pub fn failure_context(root: &Path, run_id: &str, seq: u64, before: usize, after: usize) -> Result<Vec<EventRow>>;
pub fn source_context(root: &Path, run_id: &str) -> Result<Vec<SourceContextRow>>;
pub fn rebuild_index(root: &Path, run_id: Option<&str>) -> Result<RebuildIndexResult>;
```

- [ ] **Step 4: Route query tool calls**

In `ObuServer::call_tool`, add explicit routing for each query tool before the fallback:

```rust
match name.as_ref() {
    "js" => self.call_js(arguments, meta, _context).await,
    "browser_status" => self.call_browser_status(arguments).await,
    "agent_runtime_status" => self.call_agent_runtime_status(arguments).await,
    "js_reset" => self.call_js_reset(arguments).await,
    "js_add_module_dir" => self.call_js_add_module_dir(arguments).await,
    "logs_list_runs" => self.call_logs_list_runs(arguments).await,
    "logs_timeline" => self.call_logs_timeline(arguments).await,
    "logs_search" => self.call_logs_search(arguments).await,
    "logs_sql" => self.call_logs_sql(arguments).await,
    "logs_failure_context" => self.call_logs_failure_context(arguments).await,
    "logs_source_context" => self.call_logs_source_context(arguments).await,
    "logs_rebuild_index" => self.call_logs_rebuild_index(arguments).await,
    _ => Err(ErrorData::method_not_found::<CallToolRequestMethod>()),
}
```

Each `call_logs_*` helper decodes its own args, calls the matching function in `dev_log::query`, and returns `structuredContent`. `call_logs_sql` must enforce the read-only SQL guardrails from the spec before executing. Do not rely on a string prefix allowlist. The implementation must:

- open a dedicated read-only connection for the call;
- prepare exactly one statement and reject trailing SQL;
- require SQLite to classify the prepared statement as read-only;
- install an authorizer that denies write opcodes, `ATTACH`, `DETACH`, unsafe PRAGMAs, temp object creation, virtual table creation, extension loading, and non-log tables;
- allow only `runs`, `events`, and `events_fts`;
- reject recursive CTEs and SQL functions outside the safe allowlist;
- enforce an output row limit even when no `LIMIT` is supplied;
- install a progress handler or equivalent timeout so expensive reads are interrupted.

Add `logs_sql` tests for mutating CTEs such as `WITH deleted AS (DELETE FROM events RETURNING *) SELECT * FROM deleted`, multiple statements, forbidden table names, recursive CTEs, and a query interrupted by the progress handler.

Add a real `logs_failure_context` integration test, not only a unit-level helper
test: trigger a failing `js` call or browser operation, call
`logs_failure_context` for the failure `seq`, and assert the result includes the
failure event, preceding `mcp.tool.started`/`node.exec.started` context, source
anchor/codegraph query, and structured error fields.

- [ ] **Step 5: Wrap non-log tool calls**

Before wrapping calls, construct and pass the aggregator explicitly. In
`run_stdio_server_with_options`, if `ManagerOptions.dev_log_config` is `Some`,
call `DevLogAggregator::start(config)` exactly once, store the cloneable producer
handle in `ObuServer`, and pass a clone into `JsRuntimeManager` so kernel
lifecycle events and `dev_log_event` demux use the same per-run sequence stream.
If dev logs are disabled, no aggregator is constructed and no dev-log files are
created. Add integration coverage for both `obu mcp stdio --dev-logs` without
`--dev-log-run-id` and default non-dev mode.

Add a helper in `mcp_server.rs`:

```rust
fn is_log_tool(name: &str) -> bool {
    name.starts_with("logs_")
}
```

Before dispatch, if dev logs are enabled and `!is_log_tool(name.as_ref())`, record `mcp.tool.started`. After dispatch, record `mcp.tool.finished` with `status` equal to `succeeded` or `failed`.

When `call_browser_status` succeeds, also record a `browser_status.returned` event with `operation.kind = "mcp_tool"`, `operation.name = "browser_status"`, `source = source_for_anchor("mcp.call_tool")`, and the redacted status payload in `output`.

In `run_stdio_server_with_options`, finalize the aggregator on normal MCP server
exit, stdin EOF, and startup/serve failures. `run.finished` must be flushed after
all earlier queued events and before process exit. Add an integration test that
starts a dev-log server, closes stdin, waits for exit, and asserts
`events.ndjson` contains exactly one `run.finished` with the expected status.

Also add a negative integration test that starts `obu-node-repl mcp stdio`
without `--dev-logs` and without `OBU_DEV_LOG`, performs a simple `browser_status`
or initialize/shutdown path, and asserts no `$OBU_RUNTIME_DIR/logs/dev` directory
or dev-log files are created.

The finished event must include:

```rust
DevLogEventDraft {
    component: "mcp".into(),
    event: "mcp.tool.finished".into(),
    level: if ok { "info".into() } else { "error".into() },
    operation: Some(DevLogOperation {
        kind: "mcp_tool".into(),
        name: name.to_string(),
        status: Some(if ok { "succeeded" } else { "failed" }.into()),
        duration_ms: Some(duration_ms),
    }),
    source: Some(source_for_anchor("mcp.call_tool")),
    summary: Some(format!("MCP tool {name} {}", if ok { "succeeded" } else { "failed" })),
    ..DevLogEventDraft::default()
}
```

- [ ] **Step 6: Run focused MCP tests**

Run:

```bash
cargo test -p obu-node-repl --test mcp_stdio dev_logs_record_non_log_tools_and_query_tools_do_not_contaminate_run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/obu-node-repl/src/mcp_server.rs crates/obu-node-repl/src/dev_log/query.rs crates/obu-node-repl/tests/mcp_stdio.rs
git commit -m "feat: expose dev log MCP tools"
```

## Task 5: Kernel Lifecycle And `dev_log_event` Frame Demux

**Files:**
- Modify: `crates/obu-node-repl/src/native_pipe/protocol.rs`
- Modify: `crates/obu-node-repl/src/repl_manager/mod.rs`
- Modify: `crates/obu-node-repl/embedded/kernel.js`
- Test: `crates/obu-node-repl/tests/native_pipe_protocol.rs`
- Test: `crates/obu-node-repl/tests/mcp_stdio.rs`

- [ ] **Step 1: Write failing protocol roundtrip test**

Add to `crates/obu-node-repl/tests/native_pipe_protocol.rs`:

```rust
#[test]
fn dev_log_event_frame_roundtrips() {
    use obu_node_repl::dev_log::event::DevLogEventDraft;

    let frame = KernelOut::DevLogEvent {
        draft: DevLogEventDraft {
            component: "sdk".into(),
            event: "backend.select".into(),
            level: "info".into(),
            summary: Some("selected chrome".into()),
            ..DevLogEventDraft::default_for_test()
        },
    };
    let json = serde_json::to_string(&frame).unwrap();
    assert!(json.contains(r#""type":"dev_log_event""#));
    assert!(json.contains(r#""event":"backend.select""#));

    let decoded: KernelOut = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, frame);
}
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
cargo test -p obu-node-repl --test native_pipe_protocol dev_log_event_frame_roundtrips
```

Expected: FAIL because `KernelOut::DevLogEvent` does not exist.

- [ ] **Step 3: Add the frame and demux path**

In `crates/obu-node-repl/src/native_pipe/protocol.rs`, add:

```rust
use crate::dev_log::event::DevLogEventDraft;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KernelOut {
    NativePipeHandshake(NativePipeHandshake),
    NativePipeRequest(NativePipeRequest),
    DevLogEvent { draft: DevLogEventDraft },
}
```

In `spawn_stdout_demux`, handle `KernelOut::DevLogEvent` before native-pipe requests:

```rust
KernelOut::DevLogEvent { draft } => {
    if let Some(dev_log) = dev_log.as_ref() {
        let _ = dev_log.record(draft);
    }
}
```

Pass `Option<DevLogAggregator>` into the demux task from `JsRuntimeManager`.
This call must only enqueue into the bounded writer channel; the stdout demux
must never perform NDJSON fsync or SQLite insertion inline, because that would
serialize kernel frame routing behind dev-log I/O.

- [ ] **Step 4: Emit node-repl-owned lifecycle and exec events**

In `JsRuntimeManager`, record Rust-owned lifecycle events at the existing state-change sites:

```rust
fn record_kernel_lifecycle(&self, generation: u64, from: &str, to: &str, summary: &str) {
    if let Some(dev_log) = self.dev_log.as_ref() {
        let _ = dev_log.record(DevLogEventDraft {
            component: "node_repl".into(),
            event: "kernel.lifecycle".into(),
            level: "info".into(),
            source: Some(source_for_anchor("node.JsRuntimeManager.lifecycle")),
            operation: Some(DevLogOperation {
                kind: "kernel".into(),
                name: "JsRuntimeManager".into(),
                status: Some(to.into()),
                duration_ms: None,
            }),
            state: Some(DevLogState {
                machine: "node.kernel".into(),
                from: Some(from.into()),
                to: Some(to.into()),
                trace: vec![serde_json::json!({ "generation": generation })],
            }),
            summary: Some(summary.into()),
            ..DevLogEventDraft::default()
        });
    }
}
```

Call it when `boot_locked()` moves through `spawning` and `ready`, when `reset()` moves through `restarting`, when `set_kernel_failed()` records `failed`, and when a later successful boot records `recovered`. Add an integration test that forces or simulates spawn -> ready -> reset/restarting -> failed -> recovered and asserts the emitted `kernel.lifecycle` rows are ordered by `seq`. Around `exec_with_turn_id_and_progress_sink`, record `node.exec.started` before sending the exec frame and `node.exec.finished` after success or failure, carrying `ids.turnId`, `operation.kind = "js_exec"`, `operation.name = "js"`, duration, stdout/result truncation flags in `output`, and structured JavaScript error details in `error`.

- [ ] **Step 5: Install kernel-side sink**

In `crates/obu-node-repl/embedded/kernel.js`, add after `send(message)`:

```javascript
const devLogEnabled = process.env.OBU_DEV_LOG === "1";
const devLogRunId = process.env.OBU_DEV_LOG_RUN_ID || "";

function emitDevLogEvent(draft) {
  if (!devLogEnabled) return;
  try {
    send({
      type: "dev_log_event",
      draft,
    });
  } catch (error) {
    try {
      send({
        type: "dev_log_event",
        draft: {
          component: "node_repl",
          event: "log.dropped",
          level: "warn",
          dropped: { count: 1, sourceComponent: "sdk", reason: "serialization_failed" },
          summary: `dev log draft dropped: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    } catch {
      // Logging must never break kernel execution.
    }
  }
}
```

Add it to `nodeRepl`:

```javascript
devLog(draft) {
  if (!draft || typeof draft !== "object") {
    throw new Error("nodeRepl.devLog expected an object draft");
  }
  emitDevLogEvent(draft);
},
get devLogRunId() {
  return devLogRunId;
},
```

- [ ] **Step 6: Add integration test for SDK frame ordering**

Add to `crates/obu-node-repl/tests/mcp_stdio.rs`:

```rust
#[tokio::test]
async fn dev_log_event_frames_do_not_interfere_with_exec_result() {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let log_dir = runtime_dir.path().join("logs").join("dev");
    let mut child = spawn_dev_log_server(bin, runtime_dir.path(), &log_dir, "run-frame-test").await;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    drain_stderr(child.stderr.take().unwrap());

    send_initialize(&mut stdin).await;
    send(&mut stdin, json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "js",
            "arguments": {
                "source": "nodeRepl.devLog({ component: 'sdk', event: 'backend.select', level: 'info', summary: 'frame ok', ids: {} }); 42"
            }
        }
    })).await;

    let mut reader = BufReader::new(stdout).lines();
    let _init = read_json(&mut reader).await;
    let exec = read_json(&mut reader).await;
    assert_eq!(exec["result"]["structuredContent"]["result"], 42);

    let ndjson = std::fs::read_to_string(log_dir.join("run-frame-test").join("events.ndjson")).unwrap();
    assert!(ndjson.contains(r#""event":"backend.select""#));
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
cargo test -p obu-node-repl --test native_pipe_protocol dev_log_event_frame_roundtrips
cargo test -p obu-node-repl --test mcp_stdio dev_log_event_frames_do_not_interfere_with_exec_result
cargo test -p obu-node-repl --test mcp_stdio kernel_lifecycle_records_ordered_recovery_transitions
cargo test -p obu-node-repl --test mcp_stdio dev_logs_keep_mcp_stdout_protocol_clean
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/obu-node-repl/src/native_pipe/protocol.rs crates/obu-node-repl/src/repl_manager/mod.rs crates/obu-node-repl/embedded/kernel.js crates/obu-node-repl/tests
git commit -m "feat: bridge kernel dev log events"
```

## Task 6: SDK Dev-Log Sink, Source Anchors, Backend, And Method Events

**Files:**
- Create: `packages/sdk/src/dev-log.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/browsers.ts`
- Modify: `packages/sdk/src/browser.ts`
- Modify: `packages/sdk/src/browser_tabs.ts`
- Modify: `packages/sdk/src/browser_user.ts`
- Test: `packages/sdk/tests/dev-log.test.ts`
- Test: `packages/sdk/tests/browsers.test.ts`
- Test: `packages/sdk/tests/browser.test.ts`

- [ ] **Step 1: Write failing SDK dev-log tests**

Create `packages/sdk/tests/dev-log.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDevLogSinkForTests,
  createSource,
  emitDevLog,
  getCapturedDevLogEventsForTests,
  installDevLogCaptureForTests,
  withSdkMethodLog,
} from "../src/dev-log.js";

afterEach(() => clearDevLogSinkForTests());

describe("SDK dev log sink", () => {
  it("captures source anchors and method status", async () => {
    installDevLogCaptureForTests();
    const result = await withSdkMethodLog(
      "Browser.name",
      createSource("sdk.Browser.method"),
      { sessionId: "session-1" },
      async () => "ok",
    );

    expect(result).toBe("ok");
    expect(getCapturedDevLogEventsForTests()).toMatchObject([
      {
        component: "sdk",
        event: "sdk.method.started",
        operation: { kind: "sdk_method", name: "Browser.name", status: "started" },
      },
      {
        component: "sdk",
        event: "sdk.method.finished",
        operation: { kind: "sdk_method", name: "Browser.name", status: "succeeded" },
      },
    ]);
  });

  it("emits directly to nodeRepl.devLog when available", () => {
    const emitted: unknown[] = [];
    (globalThis as { nodeRepl?: unknown }).nodeRepl = {
      devLog(draft: unknown) {
        emitted.push(draft);
      },
    };
    emitDevLog({
      component: "sdk",
      event: "backend.discovery",
      level: "info",
      ids: {},
      summary: "found descriptors",
    });
    delete (globalThis as { nodeRepl?: unknown }).nodeRepl;

    expect(emitted).toMatchObject([{ event: "backend.discovery" }]);
  });
});
```

Add a TypeScript contract test that loads
`docs/superpowers/schemas/dev-log-event.schema.json` and the
`docs/superpowers/schemas/fixtures/dev-log/*.ndjson` fixtures. It must assert
that valid fixtures match the SDK `DevLogDraft`/kernel-frame shape and invalid
fixtures fail for the same reasons as the Rust tests from Task 1.

Add to `packages/sdk/tests/browsers.test.ts`:

```typescript
import { clearDevLogSinkForTests, getCapturedDevLogEventsForTests, installDevLogCaptureForTests } from "../src/dev-log.js";

it("logs no-backend selection failures before transport exists", () => {
  installDevLogCaptureForTests();
  expect(() => selectBackend([], "chrome", [{ source: "bad.json", reason: "invalid" }])).toThrow(/no backend available/);
  expect(getCapturedDevLogEventsForTests()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "backend.discovery" }),
      expect.objectContaining({ event: "backend.select", operation: expect.objectContaining({ status: "failed" }) }),
    ]),
  );
  clearDevLogSinkForTests();
});

it("logs backend connection lifecycle around connectBackend", async () => {
  installDevLogCaptureForTests();
  const backend = { type: "webextension", name: "chrome", socketPath: "/tmp/chrome.sock" };
  const browsers = new Browsers({
    listBackends: () => [backend],
    listBackendDiagnostics: () => [],
    connectBackend: async (selected) => ({
      transport: {} as never,
      info: { type: "webextension", name: "chrome", metadata: {}, capabilities: {} },
      backend: selected,
    }),
  });

  await browsers.get("chrome");

  expect(getCapturedDevLogEventsForTests()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "backend.connect.started", operation: expect.objectContaining({ status: "started" }) }),
      expect.objectContaining({ event: "backend.connect.finished", operation: expect.objectContaining({ status: "succeeded" }) }),
    ]),
  );
  clearDevLogSinkForTests();
});
```

Add or extend `packages/sdk/tests/browser.test.ts` so Browser-level wrappers are
not untested instrumentation. Cover at least `Browser.name`,
`Browser.finishTurn`, `Browser.resumeControl`, and one viewport or visibility
setter. Each assertion must prove the wrapper emits paired `sdk.method.started`
and `sdk.method.finished` events with the method-specific operation name and the
`sdk.Browser.method` source anchor. If local helper scaffolding such as
`FakeConnection`, `TaskTransport`, or `installMeta` does not already exist in
the test files, define minimal local helpers in the same test rather than
depending on undocumented globals.

- [ ] **Step 2: Run SDK tests and confirm failure**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- dev-log.test.ts browsers.test.ts browser.test.ts
```

Expected: FAIL with missing `../src/dev-log.js`.

- [ ] **Step 3: Implement SDK sink and source helpers**

Create `packages/sdk/src/dev-log.ts`:

```typescript
export type DevLogDraft = {
  component: "sdk" | "extension" | "host" | "node_repl";
  event: string;
  level: "debug" | "info" | "warn" | "error";
  occurredAt?: string;
  ids?: Record<string, unknown>;
  state?: { machine: string; from?: string; to?: string; trace?: unknown[] };
  source?: Record<string, unknown>;
  operation?: { kind: string; name: string; status?: string; durationMs?: number };
  input?: unknown;
  output?: unknown;
  error?: { code?: string | number; message: string; productErrorCode?: string; data?: unknown };
  nextAction?: string;
  summary?: string;
};

type DevLogSink = (draft: DevLogDraft) => void;

let capture: DevLogDraft[] | null = null;
let explicitSink: DevLogSink | undefined;

export function emitDevLog(draft: DevLogDraft): void {
  try {
    if (capture) capture.push(draft);
    if (explicitSink) explicitSink(draft);
    const nodeRepl = (globalThis as { nodeRepl?: { devLog?: (draft: DevLogDraft) => void } }).nodeRepl;
    nodeRepl?.devLog?.(draft);
  } catch {
    // Dev logging must not change SDK behavior.
  }
}

export function setDevLogSinkForTests(sink: DevLogSink): void {
  explicitSink = sink;
}

export function installDevLogCaptureForTests(): void {
  capture = [];
}

export function getCapturedDevLogEventsForTests(): DevLogDraft[] {
  return capture ?? [];
}

export function clearDevLogSinkForTests(): void {
  capture = null;
  explicitSink = undefined;
}

const SOURCE_ANCHORS: Record<string, {
  symbol: string;
  package?: string;
  file: string;
  language: "typescript" | "javascript" | "rust";
  query: string;
}> = {
  "sdk.Browsers.get": { symbol: "Browsers.get", package: "@open-browser-use/sdk", file: "packages/sdk/src/browsers.ts", language: "typescript", query: "Browsers get packages/sdk/src/browsers.ts" },
  "sdk.selectBackend": { symbol: "selectBackend", package: "@open-browser-use/sdk", file: "packages/sdk/src/browsers.ts", language: "typescript", query: "selectBackend packages/sdk/src/browsers.ts" },
  "sdk.Browser.method": { symbol: "Browser", package: "@open-browser-use/sdk", file: "packages/sdk/src/browser.ts", language: "typescript", query: "Browser packages/sdk/src/browser.ts" },
  "sdk.BrowserTasks.resume": { symbol: "BrowserTasks.resume", package: "@open-browser-use/sdk", file: "packages/sdk/src/browser-tasks.ts", language: "typescript", query: "BrowserTasks resume packages/sdk/src/browser-tasks.ts" },
  "sdk.Tab.observe": { symbol: "Tab.observe", package: "@open-browser-use/sdk", file: "packages/sdk/src/tab.ts", language: "typescript", query: "Tab.observe packages/sdk/src/tab.ts" },
  "sdk.Tab.step": { symbol: "Tab.step", package: "@open-browser-use/sdk", file: "packages/sdk/src/tab.ts", language: "typescript", query: "Tab.step packages/sdk/src/tab.ts" },
  "sdk.Tab.subdomain": { symbol: "Tab", package: "@open-browser-use/sdk", file: "packages/sdk/src/tab.ts", language: "typescript", query: "Tab clipboard content cua dev dom_cua playwright packages/sdk/src/tab.ts" },
  "sdk.Transport.sendRequest": { symbol: "Transport.sendRequest", package: "@open-browser-use/sdk", file: "packages/sdk/src/wire/transport.ts", language: "typescript", query: "Transport.sendRequest packages/sdk/src/wire/transport.ts" },
  "sdk.HighLevelActionResult.transition": { symbol: "HighLevelActionResult.transition", package: "@open-browser-use/sdk", file: "packages/sdk/src/high-level-action.ts", language: "typescript", query: "HighLevelActionResult.transition packages/sdk/src/high-level-action.ts" },
  "host.Dispatcher.dispatch_frame": { symbol: "Dispatcher.dispatch_frame", package: "obu-host", file: "crates/obu-host/src/dispatcher.rs", language: "rust", query: "Dispatcher dispatch_frame crates/obu-host/src/dispatcher.rs" },
  "host.Dispatcher.serve_peer": { symbol: "Dispatcher.serve_peer", package: "obu-host", file: "crates/obu-host/src/dispatcher.rs", language: "rust", query: "Dispatcher serve_peer crates/obu-host/src/dispatcher.rs" },
  "host.TaskLifecycle.transition": { symbol: "TaskLifecycle.transition", package: "obu-host", file: "crates/obu-host/src/task_lifecycle.rs", language: "rust", query: "TaskLifecycle transition crates/obu-host/src/task_lifecycle.rs" },
  "host.native_messaging.run": { symbol: "run", package: "obu-host", file: "crates/obu-host/src/native_messaging.rs", language: "rust", query: "native_messaging run crates/obu-host/src/native_messaging.rs" },
  "extension.NativeTransportController.connect": { symbol: "NativeTransportController.connect", package: "@open-browser-use/extension", file: "packages/extension/src/native_transport_controller.ts", language: "typescript", query: "NativeTransportController connect packages/extension/src/native_transport_controller.ts" },
  "extension.BrowserSessionController": { symbol: "BrowserSessionController", package: "@open-browser-use/extension", file: "packages/extension/src/browser_session_controller.ts", language: "typescript", query: "BrowserSessionController packages/extension/src/browser_session_controller.ts" },
  "extension.NativeHostBridge.resolveResponse": { symbol: "NativeHostBridge.resolveResponse", package: "@open-browser-use/extension", file: "packages/extension/src/native_host_bridge.ts", language: "typescript", query: "NativeHostBridge resolveResponse packages/extension/src/native_host_bridge.ts" },
  "extension.appendDebugLog": { symbol: "appendDebugLog", package: "@open-browser-use/extension", file: "packages/extension/src/background.ts", language: "typescript", query: "appendDebugLog packages/extension/src/background.ts" },
};

export function createSource(key: string): Record<string, unknown> {
  const anchor = SOURCE_ANCHORS[key];
  if (!anchor) throw new Error(`unknown dev-log source anchor: ${key}`);
  return {
    entrypoint: { key, symbol: anchor.symbol, package: anchor.package, file: anchor.file, language: anchor.language },
    codegraph: { query: anchor.query },
  };
}

export async function withSdkMethodLog<T>(
  name: string,
  source: Record<string, unknown>,
  ids: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  emitDevLog({
    component: "sdk",
    event: "sdk.method.started",
    level: "info",
    ids,
    source,
    operation: { kind: "sdk_method", name, status: "started" },
    summary: `${name} started`,
  });
  try {
    const result = await fn();
    emitDevLog({
      component: "sdk",
      event: "sdk.method.finished",
      level: "info",
      ids,
      source,
      operation: { kind: "sdk_method", name, status: "succeeded", durationMs: Date.now() - started },
      summary: `${name} succeeded`,
    });
    return result;
  } catch (error) {
    emitDevLog({
      component: "sdk",
      event: "sdk.method.finished",
      level: "error",
      ids,
      source,
      operation: { kind: "sdk_method", name, status: "failed", durationMs: Date.now() - started },
      error: { message: error instanceof Error ? error.message : String(error) },
      summary: `${name} failed`,
    });
    throw error;
  }
}
```

Keep this SDK-visible TypeScript source-anchor table in lockstep with the
matching subset of the Rust `SOURCE_ANCHORS` registry through shared
schema/fixture tests. Do not derive symbols by splitting the key;
`sdk.Browser.method` intentionally maps to `Browser`, and other anchors may use
logical entrypoints that do not equal the last key segment.

Export testing helpers from `packages/sdk/src/index.ts` so Vitest can import through source paths as needed.

- [ ] **Step 4: Instrument backend selection**

In `packages/sdk/src/browsers.ts`, import `emitDevLog` and `createSource`. In `selectBackend`, emit:

```typescript
emitDevLog({
  component: "sdk",
  event: "backend.discovery",
  level: "info",
  ids: {},
  source: createSource("sdk.selectBackend"),
  operation: { kind: "backend", name: "selectBackend", status: "started" },
  output: { backendCount: backends.length, diagnosticCount: diagnostics.length },
  summary: `selectBackend saw ${backends.length} backends`,
});
```

On each successful return, emit `backend.select` with `status: "succeeded"` and `output` containing `{ type, name, socketPath }`. In `noBackend`, emit `backend.select` with `status: "failed"` and `error.productErrorCode = "no_backend"`.

In `Browsers.list()` and `Browsers.diagnostics()`, emit `backend.discovery` with the number of visible backends and diagnostics. In `Browsers.get()`, wrap `connectBackend` so pre-transport connection failures are visible:

```typescript
const connectStartedAt = Date.now();
emitDevLog({
  component: "sdk",
  event: "backend.connect.started",
  level: "info",
  ids: {},
  source: createSource("sdk.Browsers.get"),
  operation: { kind: "backend", name: "connectBackend", status: "started" },
  input: { type: backend.type, name: backend.name, socketPath: backend.socketPath },
  summary: `connecting backend ${backend.type}:${backend.name}`,
});
try {
  const connected = await this.connector.connectBackend(backend);
  emitDevLog({
    component: "sdk",
    event: "backend.connect.finished",
    level: "info",
    ids: {},
    source: createSource("sdk.Browsers.get"),
    operation: { kind: "backend", name: "connectBackend", status: "succeeded", durationMs: Date.now() - connectStartedAt },
    output: { type: backend.type, name: backend.name, socketPath: backend.socketPath },
    summary: `connected backend ${backend.type}:${backend.name}`,
  });
  return new Browser(connected.transport, connected.info, connected.backend, opts.guards ?? this.defaultGuards);
} catch (error) {
  emitDevLog({
    component: "sdk",
    event: "backend.connect.finished",
    level: "error",
    ids: {},
    source: createSource("sdk.Browsers.get"),
    operation: { kind: "backend", name: "connectBackend", status: "failed", durationMs: Date.now() - connectStartedAt },
    error: { message: error instanceof Error ? error.message : String(error) },
    summary: `backend ${backend.type}:${backend.name} connection failed`,
  });
  throw error;
}
```

- [ ] **Step 5: Wrap Browser-level public methods**

In `packages/sdk/src/browser.ts`, wrap `name`, `turnEnded`, `yieldControl`, `finishTurn`, `resumeControl`, `clearLifecycleDiagnostics`, viewport setters, and visibility setters with:

```typescript
return await withSdkMethodLog(
  "Browser.name",
  createSource("sdk.Browser.method"),
  {},
  async () => {
    await this.transport.sendRequest(M.NAME_SESSION, withSessionMeta({ label }));
  },
);
```

Use the exact method name for each wrapper, for example `"Browser.finishTurn"` and `"Browser.resumeControl"`.

- [ ] **Step 6: Run focused SDK tests**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- dev-log.test.ts browsers.test.ts browser.test.ts
pnpm --filter @open-browser-use/sdk typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/dev-log.ts packages/sdk/src/index.ts packages/sdk/src/browsers.ts packages/sdk/src/browser.ts packages/sdk/tests
git commit -m "feat: add SDK dev log sink"
```

## Task 7: SDK Observe, Action, RPC, High-Level, And Task Events

**Files:**
- Modify: `packages/sdk/src/tab.ts`
- Modify: `packages/sdk/src/high-level-action.ts`
- Modify: `packages/sdk/src/browser-tasks.ts`
- Modify: `packages/sdk/src/wire/transport.ts`
- Test: `packages/sdk/tests/tab-observe.test.ts`
- Test: `packages/sdk/tests/tab-action.test.ts`
- Test: `packages/sdk/tests/high-level-action.test.ts`
- Test: `packages/sdk/tests/browser-tasks.test.ts`
- Test: `packages/sdk/tests/transport.test.ts`

- [ ] **Step 1: Write failing transport log test**

Add to `packages/sdk/tests/transport.test.ts`:

```typescript
import { clearDevLogSinkForTests, getCapturedDevLogEventsForTests, installDevLogCaptureForTests } from "../src/dev-log.js";

it("emits rpc request lifecycle events", async () => {
  installDevLogCaptureForTests();
  const connection = new FakeConnection();
  const transport = new Transport(connection);
  connection.onWrite = (request) => connection.respond(request.id, { value: "ok" });

  await transport.sendRequest("getInfo", {}, 100);

  expect(getCapturedDevLogEventsForTests()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "rpc.request.started", operation: expect.objectContaining({ name: "getInfo", status: "started" }) }),
      expect.objectContaining({ event: "rpc.request.finished", operation: expect.objectContaining({ name: "getInfo", status: "succeeded" }) }),
    ]),
  );
  clearDevLogSinkForTests();
});

it("emits transport lifecycle events for request timeouts", async () => {
  installDevLogCaptureForTests();
  const connection = new FakeConnection();
  const transport = new Transport(connection);

  await expect(transport.sendRequest("getInfo", {}, 1)).rejects.toThrow(/timeout|timed out/i);

  expect(getCapturedDevLogEventsForTests()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "transport.lifecycle",
        operation: expect.objectContaining({ name: "timeout", status: "failed" }),
      }),
    ]),
  );
  clearDevLogSinkForTests();
});
```

- [ ] **Step 2: Write failing task lifecycle test**

Add to `packages/sdk/tests/browser-tasks.test.ts`:

```typescript
import { clearDevLogSinkForTests, getCapturedDevLogEventsForTests, installDevLogCaptureForTests } from "../src/dev-log.js";

it("logs durable task resume lifecycle outcomes", async () => {
  installMeta();
  installDevLogCaptureForTests();
  const transport = new TaskTransport();
  const browser = new Browser(
    transport as unknown as Transport,
    { type: "webextension", name: "chrome" },
    { type: "webextension", name: "chrome", socketPath: "/tmp/sock" },
    new Guards(),
  );

  await browser.tasks.resume("task-1");

  expect(getCapturedDevLogEventsForTests()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "task.lifecycle", state: expect.objectContaining({ machine: "durable_task_resume", to: "resuming" }) }),
      expect.objectContaining({ event: "task.lifecycle", state: expect.objectContaining({ machine: "durable_task_resume", to: "attached" }) }),
      expect.objectContaining({ event: "task.lifecycle", operation: expect.objectContaining({ status: "succeeded" }) }),
    ]),
  );
  clearDevLogSinkForTests();
});
```

Extend `packages/sdk/tests/browser-tasks.test.ts` with failure-path cases for
`attach_failed`, `blocked`, and `observation_failed`. They should use the same
capture helpers and local `TaskTransport`/metadata scaffolding, configuring the
fake transport to return each status so the test asserts a `task.lifecycle` event
with `operation.status = "failed"` or `"blocked"` and the matching
`state.machine = "durable_task_resume"` transition.

Also extend the existing `tab-observe.test.ts`, `tab-action.test.ts`, and
`high-level-action.test.ts` suites before implementation:

- `tab.observe()` emits paired `observe.started`/`observe.finished` events with
  `ids.tabId`, `ids.observationId`, and source `sdk.Tab.observe`;
- `tab.step()` emits paired `action.started`/`action.finished` events with
  `ids.tabId`, `ids.actionId`, and source `sdk.Tab.step`;
- `HighLevelActionResult.transition(next)` emits
  `high_level_action.transition` before mutating `this.trace.state`.

If those suites already have fake transports or action fixtures, reuse them and
add dev-log assertions there. If not, add minimal local helpers rather than
leaving the instrumentation covered only by typecheck.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- transport.test.ts browser-tasks.test.ts
```

Expected: FAIL because no lifecycle events are emitted.

- [ ] **Step 4: Emit RPC lifecycle events**

In `packages/sdk/src/wire/transport.ts`, import `emitDevLog` and `createSource`. Around `sendRequest`:

```typescript
const startedAt = Date.now();
emitDevLog({
  component: "sdk",
  event: "rpc.request.started",
  level: "debug",
  ids: { requestId: id },
  source: createSource("sdk.Transport.sendRequest"),
  operation: { kind: "rpc", name: method, status: "started" },
  input: { method, timeoutMs },
  summary: `RPC ${method} started`,
});
```

On resolution, emit `rpc.request.finished` with `status: "succeeded"`. On rejection, emit `status: "failed"`, error code/message/product error data, and `nextAction` when available.

In the timeout, late-response, close, and reconnect paths already tracked by `Transport`, emit `transport.lifecycle` with `operation.kind = "transport"`, `operation.name` equal to `timeout|late_response|close|reconnect`, `ids.requestId` when known, and `source = createSource("sdk.Transport.sendRequest")`:

```typescript
emitDevLog({
  component: "sdk",
  event: "transport.lifecycle",
  level: "warn",
  ids: { requestId: id },
  source: createSource("sdk.Transport.sendRequest"),
  operation: { kind: "transport", name: "timeout", status: "failed", durationMs: Date.now() - startedAt },
  error: { message: `RPC ${method} timed out after ${timeoutMs}ms` },
  summary: `transport timeout for ${method}`,
});
```

- [ ] **Step 5: Emit observe/action/high-level events**

In `packages/sdk/src/tab.ts`, emit `observe.started` before the first state transition and `observe.finished` before every return/throw. Include `ids.tabId`, `ids.observationId`, state trace, section status, and source `sdk.Tab.observe`.

In `Tab.step`, emit `action.started` and `action.finished` with `ids.tabId`, `ids.actionId`, action kind, status/effect, state trace, and source `sdk.Tab.step`.

In `packages/sdk/src/high-level-action.ts`, emit `high_level_action.transition` inside `transition(next)`:

```typescript
emitDevLog({
  component: "sdk",
  event: "high_level_action.transition",
  level: "info",
  ids: {},
  source: createSource("sdk.HighLevelActionResult.transition"),
  operation: { kind: "high_level_action", name: this.name, status: next },
  state: { machine: `high_level_action.${this.name}`, from: this.trace.state, to: next },
  summary: `${this.name} transitioned ${this.trace.state} -> ${next}`,
});
this.trace.transition(next);
```

- [ ] **Step 6: Emit task lifecycle events**

In `packages/sdk/src/browser-tasks.ts`, add a local helper:

```typescript
function emitTaskLifecycle(taskId: string, to: string, status: string, extra: Record<string, unknown> = {}): void {
  emitDevLog({
    component: "sdk",
    event: "task.lifecycle",
    level: status === "failed" || status === "blocked" ? "warn" : "info",
    ids: { taskId },
    source: createSource("sdk.BrowserTasks.resume"),
    operation: { kind: "task", name: "BrowserTasks.resume", status },
    state: { machine: "durable_task_resume", to },
    output: extra,
    summary: `task ${taskId} resume ${to}`,
  });
}
```

Call it at `resuming`, `attach_failed`, `blocked`, `attached`, `observation_failed`, and `succeeded` points in `resume()`.

- [ ] **Step 7: Run focused SDK tests**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- transport.test.ts browser-tasks.test.ts tab-observe.test.ts tab-action.test.ts high-level-action.test.ts
pnpm --filter @open-browser-use/sdk typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/tab.ts packages/sdk/src/high-level-action.ts packages/sdk/src/browser-tasks.ts packages/sdk/src/wire/transport.ts packages/sdk/tests
git commit -m "feat: emit SDK dev log events"
```

## Task 8: Native-Pipe, Host Peer, Task, And Extension Lifecycle Diagnostics

**Files:**
- Modify: `crates/obu-node-repl/src/native_pipe/broker.rs`
- Modify: `crates/obu-host/src/dispatcher.rs`
- Modify: `crates/obu-host/src/task_lifecycle.rs`
- Modify: `packages/sdk/src/browser.ts`
- Modify: `packages/extension/src/native_transport_controller.ts`
- Modify: `packages/extension/src/background.ts`
- Test: `crates/obu-node-repl/tests/native_pipe_broker.rs`
- Test: `crates/obu-host/tests/native_messaging.rs`
- Test: `packages/sdk/tests/browser.test.ts`
- Test: `packages/extension/scripts/test-native-transport-controller.mjs`

- [ ] **Step 1: Write failing native-pipe lifecycle test**

Add to `crates/obu-node-repl/tests/native_pipe_broker.rs`:

```rust
#[tokio::test]
async fn native_pipe_broker_emits_lifecycle_for_connect_failures() {
    let (outbox_tx, mut outbox_rx) = tokio::sync::mpsc::channel(8);
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let broker = NativePipeBroker::new_for_tests_with_lifecycle_sink(outbox_tx, move |draft| {
        sink_events.lock().unwrap().push(draft);
    });

    broker.dispatch_request(NativePipeRequest {
        id: "native-pipe-1".into(),
        token: "token".into(),
        op: NativePipeOp::Connect { path: "/not/allowed.sock".into() },
    }).await;

    let _response = outbox_rx.recv().await.unwrap();
    let events = events.lock().unwrap();
    assert!(events.iter().any(|event| event.event == "native_pipe.lifecycle"));
    assert!(events.iter().any(|event| event.operation.as_ref().unwrap().status.as_deref() == Some("failed")));
}
```

- [ ] **Step 2: Write failing SDK diagnostic normalization test**

Add to `packages/sdk/tests/browser.test.ts`:

```typescript
import { clearDevLogSinkForTests, getCapturedDevLogEventsForTests, installDevLogCaptureForTests } from "../src/dev-log.js";

it("logs host and extension lifecycle diagnostics from browser metadata", () => {
  installDevLogCaptureForTests();
  new Browser(
    {} as never,
    {
      type: "webextension",
      name: "chrome",
      metadata: {
        diagnostics: {
          peer: {
            recent_events: [{ kind: "auth_rejected", reason: "capability token mismatch", at_unix_ms: 1 }],
          },
          extension: {
            native_transport: { state: "connected", updatedAt: 2 },
            session_lifecycle: [{ machine: "browser_session", from: "claiming", to: "claimed" }],
          },
        },
      },
      capabilities: {},
    },
    { type: "webextension", name: "chrome", socketPath: "/tmp/chrome.sock" },
    new Guards(),
  );

  expect(getCapturedDevLogEventsForTests()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ event: "host.peer.lifecycle", state: expect.objectContaining({ machine: "host.peer" }) }),
      expect.objectContaining({ event: "extension.lifecycle", state: expect.objectContaining({ machine: "native_transport" }) }),
    ]),
  );
  clearDevLogSinkForTests();
});
```

- [ ] **Step 3: Run and confirm failure**

Run:

```bash
cargo test -p obu-node-repl --test native_pipe_broker native_pipe_broker_emits_lifecycle_for_connect_failures
pnpm --filter @open-browser-use/sdk test -- browser.test.ts
```

Expected: FAIL with missing `new_for_tests_with_lifecycle_sink` and missing SDK diagnostic log events.

- [ ] **Step 4: Emit native-pipe lifecycle events**

Add an optional lifecycle sink to `NativePipeBroker`:

```rust
type NativePipeLifecycleSink = Arc<dyn Fn(DevLogEventDraft) + Send + Sync>;
```

Emit `native_pipe.lifecycle` in `dispatch`, `connect`, `write`, `close`, and `read_loop` async close. Include `ids.requestId`, connection id where present, operation name `connect|write|close|async_close`, and status.

- [ ] **Step 5: Surface host peer/task lifecycle diagnostics**

In `crates/obu-host/src/dispatcher.rs`, ensure `peer_lifecycle_metadata()` includes recent events already recorded by `PeerLifecycleDiagnostics`, with fields derived from the current `PeerLifecycleDiagnosticEvent` shape (`kind`, `reason`, `at_unix_ms`). Derive `nextAction` from `kind` when useful:

```rust
fn peer_event_next_action(kind: PeerLifecycleEventKind) -> Option<&'static str> {
    match kind {
        PeerLifecycleEventKind::AuthRejected | PeerLifecycleEventKind::OsCredentialRejected => Some("check capability token and peer authorization"),
        PeerLifecycleEventKind::FirstFrameMissingAuth => Some("send auth as the first native-pipe frame"),
        PeerLifecycleEventKind::PeerClosed | PeerLifecycleEventKind::RequestCancelled => Some("reconnect and retry the request if it is idempotent"),
        _ => None,
    }
}

let recent_events = self.inner.peer_diagnostics.recent_events(20);
json!({
    "recent_event_count": recent_events.len(),
    "recent_events": recent_events.into_iter().map(|event| json!({
        "machine": "host.peer",
        "event": event.kind,
        "reason": event.reason,
        "atUnixMs": event.at_unix_ms,
        "nextAction": peer_event_next_action(event.kind),
    })).collect::<Vec<_>>(),
})
```

In `crates/obu-host/src/task_lifecycle.rs`, add a helper:

```rust
pub fn task_lifecycle_diagnostic(from: TaskState, to: TaskState) -> serde_json::Value {
    serde_json::json!({
        "machine": "host.task",
        "from": from.as_str(),
        "to": to.as_str(),
    })
}
```

Use it in task-store resume/complete response diagnostics where task transitions are already made.

- [ ] **Step 6: Preserve extension lifecycle snapshots**

In `packages/extension/src/background.ts`, `publishExtensionStatus()` already sends:

```typescript
{
  overlay_release: overlayCoordinator.releaseDiagnostics(),
  session_lifecycle: sessionRepository.lifecycleDiagnostics(),
  native_requests: nativeHostBridge.diagnostics(),
}
```

Add `native_transport: nativeTransport.currentStatus()` to that notification. In `native_transport_controller.ts`, keep `state`, `message`, `diagnosis`, and `updatedAt` stable in `currentStatus()`.

- [ ] **Step 7: Normalize surfaced host/extension diagnostics into dev-log events**

In `packages/sdk/src/browser.ts`, call `emitLifecycleDiagnostics(this.diagnostics)` from the `Browser` constructor after `this.diagnostics` is assigned. Add this helper near `transportDiagnostics`:

```typescript
function emitLifecycleDiagnostics(diagnostics: Record<string, unknown>): void {
  const peer = recordOrEmpty(diagnostics.peer);
  for (const event of arrayField(peer, "recent_events")) {
    const row = recordOrEmpty(event);
    emitDevLog({
      component: "host",
      event: "host.peer.lifecycle",
      level: row.reason ? "warn" : "info",
      ids: {},
      source: createSource("host.Dispatcher.serve_peer"),
      operation: { kind: "host_peer", name: String(row.event ?? row.kind ?? "peer"), status: row.reason ? "failed" : "succeeded" },
      state: { machine: "host.peer", to: String(row.event ?? row.kind ?? "unknown") },
      output: row,
      nextAction: typeof row.nextAction === "string" ? row.nextAction : undefined,
      summary: `host peer lifecycle ${String(row.event ?? row.kind ?? "unknown")}`,
    });
  }

  const extension = recordOrEmpty(diagnostics.extension);
  const nativeTransport = recordOrEmpty(extension.native_transport);
  if (nativeTransport.state) {
    emitDevLog({
      component: "extension",
      event: "extension.lifecycle",
      level: nativeTransport.diagnosis ? "warn" : "info",
      ids: {},
      source: createSource("extension.NativeTransportController.connect"),
      operation: { kind: "extension_event", name: "native_transport", status: String(nativeTransport.state) },
      state: { machine: "native_transport", to: String(nativeTransport.state) },
      output: nativeTransport,
      summary: `extension native transport ${String(nativeTransport.state)}`,
    });
  }
}
```

For `session_lifecycle`, `overlay_release`, `native_requests`, update, and tab-ownership arrays, emit one `extension.lifecycle` per structured state transition using the matching source anchor when available. Raw `appendDebugLog` rows surfaced through an explicit snapshot remain `extension.debug`.

- [ ] **Step 8: Run focused native/extension tests**

Run:

```bash
cargo test -p obu-node-repl --test native_pipe_broker native_pipe_broker_emits_lifecycle_for_connect_failures
cargo test -p obu-host native_messaging
pnpm --filter @open-browser-use/sdk test -- browser.test.ts
pnpm --filter @open-browser-use/extension test
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/obu-node-repl/src/native_pipe crates/obu-node-repl/tests/native_pipe_broker.rs crates/obu-host/src/dispatcher.rs crates/obu-host/src/task_lifecycle.rs packages/sdk/src/browser.ts packages/sdk/tests/browser.test.ts packages/extension/src/native_transport_controller.ts packages/extension/src/background.ts
git commit -m "feat: surface host and extension lifecycle diagnostics"
```

## Task 9: Pruning, Tombstones, Rebuild, And Troubleshooting Docs

**Files:**
- Modify: `crates/obu-node-repl/src/dev_log/writer.rs`
- Modify: `crates/obu-node-repl/src/dev_log/index.rs`
- Modify: `crates/obu-node-repl/src/dev_log/query.rs`
- Modify: `docs/troubleshooting.md`
- Test: `crates/obu-node-repl/src/dev_log/mod.rs`

- [ ] **Step 1: Write failing pruning, payload-budget, and retention tests**

Add to `crates/obu-node-repl/src/dev_log/mod.rs` tests:

```rust
#[test]
fn pruning_appends_tombstone_before_artifact_removal() {
    let temp = tempdir().unwrap();
    let config = DevLogConfig::enabled(temp.path().to_path_buf(), "run-prune-1".to_string());
    let aggregator = DevLogAggregator::start(config).unwrap();
    let artifact_path = temp.path().join("run-prune-1").join("artifacts").join("large.txt");
    std::fs::create_dir_all(artifact_path.parent().unwrap()).unwrap();
    std::fs::write(&artifact_path, "large payload").unwrap();

    aggregator.record(DevLogEventDraft {
        component: "sdk".into(),
        event: "observe.finished".into(),
        level: "info".into(),
        artifacts: vec![DevLogArtifactRef {
            id: "artifact-1".into(),
            kind: "payload".into(),
            path: Some(artifact_path.to_string_lossy().into_owned()),
            bytes: Some(13),
            uri: None,
            mime_type: Some("text/plain".into()),
            sha256: None,
            summary: Some("large payload".into()),
            retained: Some(true),
        }],
        summary: Some("observe had artifact".into()),
        ..DevLogEventDraft::default_for_test()
    }).unwrap();

    aggregator.prune_artifact("artifact-1", &artifact_path, "retention_budget").unwrap();

    assert!(!artifact_path.exists());
    let ndjson = std::fs::read_to_string(temp.path().join("run-prune-1").join("events.ndjson")).unwrap();
    assert!(ndjson.contains(r#""event":"log.pruned""#));
    assert!(ndjson.contains(r#""artifactId":"artifact-1""#));
    assert!(ndjson.contains(r#""reason":"retention_budget""#));
}
```

Add focused tests for the rest of the spec-mandated retention behavior:

- `writer_budgets_large_payloads_before_sqlite_insert`: record an event whose
  post-redaction payload exceeds 32 KB, then assert `events.ndjson` and
  `payload_json` contain a summary or artifact reference rather than the raw full
  payload, and `pruning.strategy` is `summary` or `artifact_ref`;
- `screenshots_and_binary_displays_are_never_inline_base64`: record screenshot or
  binary display shaped output, then assert SQLite stores an artifact ref or
  summary and no base64 blob in `payload_json`;
- `retention_keeps_last_20_runs_and_never_deletes_active_run`: create 22
  completed runs plus one active run, apply retention, and assert the oldest
  completed runs are removed while the active run and last 20 completed runs
  remain;
- `retention_enforces_total_500mb_budget_with_parent_manifest_metadata`: use a
  configurable small test budget instead of allocating 500 MB, then assert
  oldest completed runs are deleted and parent `manifest.json` records aggregate
  deleted-run metadata such as count, bytes, oldest/newest deleted ids, and
  reason;
- `rebuild_index_repopulates_events_and_fts_and_records_rebuild_metadata`: delete
  `index.sqlite`, rebuild, assert `logs_search` works through FTS, and assert
  rebuild metadata is visible as an `index.rebuilt` event in the active run or as
  parent manifest maintenance metadata when no active aggregator exists.

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
cargo test -p obu-node-repl pruning_appends_tombstone_before_artifact_removal
cargo test -p obu-node-repl writer_budgets_large_payloads_before_sqlite_insert
cargo test -p obu-node-repl retention_keeps_last_20_runs_and_never_deletes_active_run
cargo test -p obu-node-repl rebuild_index_repopulates_events_and_fts_and_records_rebuild_metadata
```

Expected: FAIL with missing `prune_artifact`, payload budgeting, retention engine,
or rebuild metadata behavior.

- [ ] **Step 3: Implement payload budgeting, tombstones, retention, and rebuild metadata**

In `writer.rs`, add:

```rust
pub fn prune_artifact(&self, artifact_id: &str, path: &Path, reason: &str) -> Result<()> {
    self.record_and_flush(DevLogEventDraft {
        component: "node_repl".into(),
        event: "log.pruned".into(),
        level: "info".into(),
        operation: Some(DevLogOperation {
            kind: "transport".into(),
            name: "prune_artifact".into(),
            status: Some("succeeded".into()),
            duration_ms: None,
        }),
        pruning: Some(DevLogPruning {
            payload_bytes: None,
            stored_bytes: None,
            strategy: Some("dropped".into()),
            target: Some(serde_json::json!({
                "runId": self.run_id(),
                "artifactId": artifact_id,
                "payloadPath": path.to_string_lossy(),
            })),
            reason: Some(reason.into()),
        }),
        summary: Some(format!("artifact {artifact_id} pruned: {reason}")),
        ..DevLogEventDraft::default()
    })?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}
```

`record_and_flush` is a pruning-only helper that waits until this tombstone has
been appended and fsynced before returning. Normal `record()` remains
non-blocking for browser-operation paths.

Before SQLite insertion in the writer task, apply the same retention-budget helper
used by tests: redacted payloads up to 32 KB are `pruning.strategy = "inline"`;
larger text/DOM-style payloads become `summary`; payloads that are useful but too
large become artifact files under `<run_id>/artifacts/` with
`strategy = "artifact_ref"`; payloads that cannot be retained become
`strategy = "dropped"` with an explicit reason. This must happen before both
NDJSON append and SQLite insertion so `record()` never stores raw unbounded
payload JSON unconditionally.

Add a retention engine, for example:

```rust
pub struct RetentionPolicy {
    pub keep_last_runs: usize,
    pub total_budget_bytes: u64,
    pub inline_payload_cap_bytes: usize,
}

pub fn apply_retention(root: &Path, active_run_id: Option<&str>, policy: RetentionPolicy) -> Result<RetentionReport>;
```

`apply_retention` scans run manifests, excludes the active run, keeps the newest
`keep_last_runs` completed runs, then deletes oldest completed runs until total
size is under `total_budget_bytes`. It appends/fsyncs `log.pruned` tombstones
before removing artifacts or payload files for retained runs, deletes only whole
completed run directories when run-level retention is needed, and updates the
parent `manifest.json` with aggregate retention metadata for deleted runs. Never
partially delete the active run.

In `query::rebuild_index`, read each retained `*/events.ndjson`, parse every line
as `DevLogEvent`, and insert into both SQLite tables through the same
`index::insert_event` path used by live writes. A successful rebuild must expose
maintenance metadata: when an active aggregator is available, enqueue an
`index.rebuilt` event in the active run; when rebuild runs offline, update parent
`manifest.json` with `last_index_rebuild` fields instead of appending to a
historical target run.

- [ ] **Step 4: Add docs**

Append to `docs/troubleshooting.md`:

````markdown
## Query Local Dev Logs

Dev logs are disabled unless you run `obu mcp stdio --dev-logs` or set `OBU_DEV_LOG=1`.
When enabled, records stay under `$OBU_RUNTIME_DIR/logs/dev` and are not uploaded.

Useful MCP queries:

```sql
SELECT run_id, seq, event, operation_name, operation_status, summary
FROM events
ORDER BY ingested_at DESC
LIMIT 20;
```

```sql
SELECT source_entry_key, source_symbol, codegraph_query, count(*) AS n
FROM events
WHERE operation_status IN ('failed', 'blocked')
GROUP BY source_entry_key, source_symbol, codegraph_query
ORDER BY n DESC;
```
````

- [ ] **Step 5: Run tests and doc checks**

Run:

```bash
cargo test -p obu-node-repl pruning_appends_tombstone_before_artifact_removal
cargo test -p obu-node-repl writer_budgets_large_payloads_before_sqlite_insert
cargo test -p obu-node-repl retention_keeps_last_20_runs_and_never_deletes_active_run
cargo test -p obu-node-repl rebuild_index_repopulates_events_and_fts_and_records_rebuild_metadata
cargo test -p obu-node-repl rebuild_index_restores_events_from_ndjson
git diff --check -- docs/troubleshooting.md docs/superpowers/specs/2026-05-26-agent-queryable-dev-logs-design.md docs/superpowers/plans/2026-05-26-agent-queryable-dev-logs.md
```

Expected: PASS and no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add crates/obu-node-repl/src/dev_log docs/troubleshooting.md
git commit -m "feat: add dev log pruning recovery"
```

## Task 10: End-To-End Smoke And Final Verification

**Files:**
- Modify: `crates/obu-node-repl/tests/mcp_stdio.rs`
- Modify: `scripts/mcp-stdio-clean-smoke.mjs`
- Test: `crates/obu-node-repl/tests/mcp_stdio.rs`

- [ ] **Step 1: Add smoke coverage for protocol cleanliness**

In `crates/obu-node-repl/tests/mcp_stdio.rs`, add:

```rust
#[tokio::test]
async fn dev_logs_keep_mcp_stdout_protocol_clean() {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let log_dir = runtime_dir.path().join("logs").join("dev");
    let mut child = spawn_dev_log_server(bin, runtime_dir.path(), &log_dir, "run-clean-test").await;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    drain_stderr(child.stderr.take().unwrap());

    send_initialize(&mut stdin).await;
    send(&mut stdin, json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "js",
            "arguments": {
                "source": "nodeRepl.devLog({ component: 'sdk', event: 'sdk.method.started', level: 'info', ids: {}, summary: 'hidden from stdout' }); 'visible result'"
            }
        }
    })).await;

    let mut reader = BufReader::new(stdout).lines();
    let init = read_json(&mut reader).await;
    assert_eq!(init["id"], 1);
    let exec = read_json(&mut reader).await;
    assert_eq!(exec["id"], 2);
    assert_eq!(exec["result"]["structuredContent"]["result"], "visible result");
    assert_ne!(exec["method"].as_str(), Some("dev_log_event"));
}
```

- [ ] **Step 2: Run the final focused smoke**

Run:

```bash
cargo test -p obu-node-repl --test mcp_stdio dev_logs_keep_mcp_stdout_protocol_clean
```

Expected: PASS.

- [ ] **Step 3: Run subsystem test suites**

Run:

```bash
cargo test -p obu-node-repl
pnpm --filter @open-browser-use/sdk test
pnpm --filter @open-browser-use/sdk typecheck
pnpm --filter @open-browser-use/extension test
pnpm --filter @open-browser-use/cli typecheck
pnpm check:wire-methods
pnpm check:error-codes
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 4: Manual log query check**

Run a dev-log MCP server through the existing stdio tests or local MCP client, then query:

```sql
SELECT event, operation_kind, operation_name, operation_status, summary
FROM events
WHERE run_id = '<run-id>'
ORDER BY seq ASC;
```

Expected rows include:

```text
run.started
mcp.tool.started
kernel.lifecycle
node.exec.started
backend.discovery
backend.select
rpc.request.started
observe.started
observe.finished
node.exec.finished
mcp.tool.finished
run.finished
```

- [ ] **Step 5: Commit**

```bash
git add crates/obu-node-repl/tests/mcp_stdio.rs scripts/mcp-stdio-clean-smoke.mjs
git commit -m "test: verify dev log end to end"
```

## Self-Review

Spec coverage:
- Local disabled-by-default enablement: Tasks 3 and 10.
- Env-only enablement and generated run ids: Task 3.
- Aggregator construction and default non-dev no-file behavior: Task 4.
- NDJSON plus SQLite/FTS source/index split, including live and rebuild FTS population: Task 2.
- Source anchors and CodeGraph queries: Tasks 1, 6, and 7.
- Cross-process writer ownership and `dev_log_event` bridge: Task 5.
- MCP query tools and no contamination by `logs_*`: Task 4.
- Pruning tombstones, inline payload budgeting, run retention, and rebuild metadata: Task 9.
- Backend/kernel/SDK/task failure paths/native-pipe/host/extension coverage: Tasks 5 through 8.
- Redaction implementation, metadata wiring, and payload caps: Tasks 1, 2, and 9.
- Docs and smoke validation: Tasks 9 and 10.

Placeholder scan:
- Passed: no forbidden placeholder phrases, no empty "add tests" steps, and no unspecified validation commands.

Type consistency:
- Rust event drafts use `DevLogEventDraft`, `DevLogOperation`, `DevLogIds`, and the same `camelCase` serde names across writer, protocol, and query tasks.
- SDK event drafts use `durationMs` in TypeScript and Rust persists `duration_ms` after JSON normalization.
