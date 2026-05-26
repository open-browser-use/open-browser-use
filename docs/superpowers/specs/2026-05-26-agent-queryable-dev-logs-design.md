# Agent-Queryable Dev Logs Design

**Status:** P0 approved in brainstorming; pending written-spec review, then implementation plan.

**Date:** 2026-05-26

## Goal

Add a local-first dev log mode that lets agents inspect, query, and study OBU's
browser automation behavior across MCP, node-repl, SDK, host, and extension
boundaries.

The primary user is an agent debugging or improving OBU itself. The log must
answer questions such as:

- What happened in this run, in canonical ingestion order, and when did imported
  diagnostics originally occur?
- Which state machine transitioned into a bad or surprising state?
- What did `browser_status`, `observe`, `action`, RPC, native transport, and
  extension diagnostics return?
- Which code entrypoint produced the event, and what should CodeGraph inspect
  next?
- Which historical failures look similar?
- What facts can be recovered after pruning large payloads?

This is not a hosted telemetry feature. P0 keeps all records local, disabled by
default, and queryable without running an external service.

## Chosen Open-Source Building Blocks

P0 uses mature embedded components instead of adopting a hosted observability
product as the primary data model.

| Component | Role | Why it fits P0 |
|---|---|---|
| SQLite | Durable local index | Single file, local, already used through Rust `rusqlite`, easy for agents to query. |
| SQLite FTS5 | Full-text search | Lets agents search events, errors, methods, state names, and redacted summaries without a separate search server. |
| NDJSON | Append-only source log | Easy to stream, recover, diff, and inspect manually; remains useful if the SQLite index is rebuilt. |
| DuckDB | Optional research/export path | Strong for later batch analysis over NDJSON or Parquet, without becoming a runtime dependency in P0. |
| OpenTelemetry | Optional export compatibility | Good standard mapping for spans/logs later, but not the source of truth for OBU trajectory semantics. |

Not selected for P0 as core storage:

- Phoenix, Langfuse, SigNoz, Grafana Tempo/Loki: useful UIs and collectors, but
  they add service dependencies and do not naturally model OBU's browser
  observation/action/recovery semantics.
- LanceDB/Qdrant: useful later for semantic similarity over summaries, but
  embedding generation and privacy controls should be designed after the local
  schema is stable.
- rrweb/OpenReplay: useful for optional replay artifacts, but too sensitive and
  large for default dev logging.

## Product Principles

1. **Agent-queryable first.** A log is successful when an agent can query it
   without needing a human dashboard.
2. **Append-only evidence first, indexes second.** NDJSON is the recovery source;
   SQLite/FTS is a rebuildable query index.
3. **State machines are first-class.** Transitions are explicit events, not
   incidental strings inside generic debug messages.
4. **Observe/action/return are paired.** Each request-shaped event should have a
   start and completion event with correlation ids.
5. **CodeGraph anchors are first-class.** Every product-significant event carries
   a stable source entry key that an agent can feed back into CodeGraph. These
   anchors identify symbols and logical entrypoints, not fragile line numbers.
6. **Pruning preserves reasoning.** Large payloads may be dropped or summarized,
   but the event timeline, state transitions, statuses, error codes, and
   recovery hints remain.
7. **Local and private by default.** No upload, no remote collector, no page
   storage capture, and no cookies/passwords/tokens in normal logs.

## Scope

P0 covers developer runs started through `obu mcp stdio` or a dev-mode MCP
configuration. It records:

- MCP tool calls for every non-log MCP tool, including `browser_status`, `js`,
  `js_reset`, `agent_runtime_status`, and `js_add_module_dir`. `logs_*` query
  tools are exposed in dev-log mode but are explicitly excluded from the
  inspected run's trajectory.
- node-repl execution lifecycle: turn id, kernel generation, duration, stdout
  budget/truncation flags, structured user-code error detail, kernel lifecycle,
  backend-inventory sync, and native-pipe broker lifecycle.
- SDK runtime: backend listing/selection/connection, public SDK method wrappers,
  `tab.observe()`, `tab.step()`, high-level action state traces, request
  lifecycle diagnostics, and durable task resume lifecycle.
- Host/native-pipe RPC: method, request id, duration, success/error, timeout and
  late-response lifecycle.
- Host peer/auth lifecycle, request dispatch, task-store lifecycle, and
  diagnostics exposed through host-visible responses or existing `tracing` sites
  where practical.
- WebExtension debug events that already flow through `appendDebugLog`, plus
  structured lifecycle diagnostics surfaced through extension status snapshots,
  mirrored into the dev log through host-visible responses or a future export
  bridge.

P0 does not add:

- Hosted telemetry.
- Semantic embeddings.
- Browser replay recording.
- Automatic action replay.
- A graphical dashboard.
- New behavior in normal non-dev runs.

## Runtime Enablement

Dev logs are disabled unless one of these is true:

- `OBU_DEV_LOG=1`
- `obu mcp stdio --dev-logs`
- an MCP config generated with an explicit dev flag, such as
  `obu mcp-config --agent=codex-cli --print --dev-logs`

`OBU_DEV_LOG` environment parsing must accept `1`, `true`, `yes`, and `on`
case-insensitively. It must not depend on a CLI parser's boolean env handling if
that parser rejects `1`, because `OBU_DEV_LOG=1` is a documented primary path.

The CLI wrapper propagates the log configuration into `obu-node-repl` and the
Node kernel:

```text
OBU_DEV_LOG=1
OBU_DEV_LOG_DIR=$OBU_RUNTIME_DIR/logs/dev
OBU_DEV_LOG_RUN_ID=<generated-run-id>
```

Because `obu-node-repl` intentionally spawns the Node kernel with a minimal
environment, the spawn allowlist must explicitly pass these `OBU_DEV_LOG*`
variables through. A test must prove that enabling dev logs at `obu mcp stdio`
is observable inside SDK code running in the Node kernel.

The Rust node-repl side owns final config resolution. When dev logs are enabled
and no run id is supplied by CLI or env, `obu-node-repl` generates the default
run id before constructing the dev-log aggregator and before spawning the Node
kernel.

The default run id is time-sortable:

```text
YYYYMMDDTHHMMSSmmmZ-<short-random>
```

All files live under:

```text
$OBU_RUNTIME_DIR/logs/dev/
  index.sqlite
  manifest.json
  <run_id>/
    manifest.json
    events.ndjson
    artifacts/
```

The runtime directory owner-only validation already used by OBU applies before
writing logs. `events.ndjson` is the per-run append-only source of truth.
`index.sqlite` is a global, rebuildable index over all retained runs so agents
can ask cross-run research questions without attaching many SQLite databases.

Caller-supplied run ids are accepted only after validation as a single safe path
segment. A valid run id matches `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and must not
contain path separators, `.`/`..` segments, drive prefixes, control characters,
or percent-encoded separators. Invalid explicit run ids fail fast before any
filesystem path is joined. Generated run ids always use the time-sortable format
above.

## Write Ownership

P0 allows concurrent event producers but keeps canonical persistence serialized.
MCP wrappers, stdout demux, SDK code, and diagnostic importers may all produce
event drafts concurrently. They feed a bounded queue owned by the Rust-side
node-repl dev-log aggregator. The aggregator is the only canonical writer and
sequencer for a run: it owns `seq`, appends to `events.ndjson`, and attempts to
update `index.sqlite`.

Per-run `events.ndjson` writes are authoritative and must be ordered by the
aggregator's single sequence stream. `index.sqlite` is a rebuildable global
index, not the source of truth. Multiple dev-mode MCP sessions may write their
own run files while contending for the same global SQLite index. SQLite uses WAL,
short transactions, and a busy timeout, but index writes must remain
best-effort: if the global index is locked past the allowed budget, the run still
records the NDJSON event and a later `logs_rebuild_index` can restore the index.
Log writing must never block browser automation indefinitely.

Query tools use separate read-only SQLite connections. `logs_sql` must not share
the write connection used by the aggregator.

`seq` is the canonical run-order key. `ingestedAt` is the Rust aggregator's
timestamp for the canonical write. `occurredAt` is optional producer evidence
for facts imported after the fact, such as host peer diagnostics or extension
debug snapshots. For live node-repl and SDK events, `occurredAt` usually equals
`ingestedAt`; for imported host/extension snapshots, it may be older. Timeline
queries default to `ORDER BY seq`; any occurrence-time view must expose that it
is reconstructing producer time and can be partial.

SDK and Node-kernel code emit event drafts through a kernel-local log sink. The
sink serializes drafts onto the existing kernel stdout protocol as a dedicated
frame:

```ts
type DevLogKernelFrame = {
  type: "dev_log_event";
  draft: Omit<DevLogEvent, "seq" | "ingestedAt" | "runId" | "schemaVersion">;
};
```

The Rust stdout demux handles `dev_log_event` frames before `exec_result`
routing, validates/redacts/budgets the draft, assigns `schemaVersion`, `runId`,
`seq`, and `ingestedAt`, then hands the complete event to the aggregator. The
Node sink must not await file or SQLite work from browser automation paths. If
its bounded queue overflows, it coalesces drops and sends a later `log.dropped`
event with `component`, `dropped.count`, and `dropped.reason`; logging
backpressure must never fail or delay the browser operation being logged.

Host and extension events enter P0 through host-visible responses, structured
diagnostics, or sanitized snapshots that the node-repl aggregator records. The
Rust host does not write to the same run file in P0; a later version may import
host sidecar logs, but sidecars must never allocate the canonical run sequence.

## Event Model

The event envelope is a cross-language contract. The source of truth is a
machine-readable schema, `docs/superpowers/schemas/dev-log-event.schema.json`,
plus fixture NDJSON files that both Rust and TypeScript tests load. Rust event
types, TypeScript `DevLogDraft` types, and kernel-frame tests must be generated
from or contract-tested against that schema. Hand-maintained shapes are allowed
only when fixtures prove wire compatibility in both languages.

Every event is a JSON object with a stable envelope:

```ts
type DevLogEvent = {
  schemaVersion: 1;
  seq: number;
  ingestedAt: string;
  occurredAt?: string;
  monotonicMs?: number;
  runId: string;
  component: "cli" | "mcp" | "node_repl" | "sdk" | "host" | "extension";
  event: string;
  level: "debug" | "info" | "warn" | "error";
  ids: {
    sessionId?: string;
    turnId?: string;
    taskId?: string;
    tabId?: string | number;
    requestId?: string | number;
    actionId?: string;
    observationId?: string;
    correlationId?: string;
  };
  state?: {
    machine: string;
    from?: string;
    to?: string;
    trace?: Array<{ state: string; at: number }>;
  };
  source?: {
    entrypoint?: {
      key: string;
      symbol: string;
      package?: string;
      file?: string;
      language?: "typescript" | "javascript" | "rust";
    };
    emitter?: {
      key: string;
      symbol: string;
      package?: string;
      file?: string;
      language?: "typescript" | "javascript" | "rust";
    };
    codegraph?: {
      query: string;
    };
  };
  operation?: {
    kind:
      | "mcp_tool"
      | "js_exec"
      | "kernel"
      | "backend"
      | "sdk_method"
      | "rpc"
      | "observe"
      | "action"
      | "high_level_action"
      | "task"
      | "transport"
      | "native_pipe"
      | "host_peer"
      | "extension_event";
    name: string;
    status?: "started" | "succeeded" | "partial" | "blocked" | "failed" | "cancelled";
    durationMs?: number;
  };
  input?: unknown;
  output?: unknown;
  error?: {
    code?: string | number;
    message: string;
    productErrorCode?: string;
    data?: unknown;
  };
  nextAction?: string;
  summary?: string;
  redaction?: {
    applied: boolean;
    rules?: string[];
    redactedPaths?: string[];
    omittedPaths?: string[];
  };
  artifacts?: Array<{
    id: string;
    kind: "screenshot" | "image" | "binary_display" | "payload" | "other";
    uri?: string;
    path?: string;
    mimeType?: string;
    bytes?: number;
    sha256?: string;
    summary?: string;
    retained?: boolean;
  }>;
  dropped?: {
    count: number;
    sourceComponent?: "cli" | "mcp" | "node_repl" | "sdk" | "host" | "extension";
    reason: "queue_full" | "disabled" | "serialization_failed";
  };
  pruning?: {
    payloadBytes?: number;
    storedBytes?: number;
    strategy?: "inline" | "summary" | "artifact_ref" | "dropped";
    target?: {
      runId?: string;
      seq?: number;
      artifactId?: string;
      payloadPath?: string;
      generation?: string;
    };
    reason?: string;
  };
  text?: string;
};
```

The envelope is intentionally close to OpenTelemetry concepts, but names remain
OBU-native so browser-control semantics are not forced into generic span fields.

`ids`, `source`, and `operation` are structurally optional because envelope
events such as `run.started`, `run.finished`, `log.dropped`, and `log.pruned`
do not always have a request operation. They are not optional for event families
that need them. The writer validates required fields by event family before
persistence and records invalid drafts as dropped diagnostics instead of
persisting ambiguous product events.

### Source Anchors

Source anchors are stable, normalized entrypoints for agent investigation. They
are not line numbers. The key must be stable enough for dashboards, SQL, and
tests, while `symbol` and `file` are hints an agent can pass to CodeGraph.

Examples:

| Key | Symbol | CodeGraph query |
|---|---|---|
| `mcp.call_tool` | `ObuServer.call_tool` | `ObuServer call_tool crates/obu-node-repl/src/mcp_server.rs` |
| `mcp.call_js` | `ObuServer.call_js` | `ObuServer call_js crates/obu-node-repl/src/mcp_server.rs` |
| `node.JsRuntimeManager.lifecycle` | `JsRuntimeManager.boot_locked` | `JsRuntimeManager boot_locked crates/obu-node-repl/src/repl_manager/mod.rs` |
| `node.NativePipeBroker.dispatch` | `NativePipeBroker.dispatch` | `NativePipeBroker dispatch crates/obu-node-repl/src/native_pipe/broker.rs` |
| `sdk.Browsers.get` | `Browsers.get` | `Browsers get packages/sdk/src/browsers.ts` |
| `sdk.selectBackend` | `selectBackend` | `selectBackend packages/sdk/src/browsers.ts` |
| `sdk.Browser.method` | `Browser` | `Browser packages/sdk/src/browser.ts` |
| `sdk.BrowserTasks.resume` | `BrowserTasks.resume` | `BrowserTasks resume packages/sdk/src/browser-tasks.ts` |
| `sdk.Tab.observe` | `Tab.observe` | `Tab.observe packages/sdk/src/tab.ts` |
| `sdk.Tab.step` | `Tab.step` | `Tab.step packages/sdk/src/tab.ts` |
| `sdk.Tab.subdomain` | `Tab` | `Tab clipboard content cua dev dom_cua playwright packages/sdk/src/tab.ts` |
| `sdk.Transport.sendRequest` | `Transport.sendRequest` | `Transport.sendRequest packages/sdk/src/wire/transport.ts` |
| `sdk.HighLevelActionResult.transition` | `HighLevelActionResult.transition` | `HighLevelActionResult.transition packages/sdk/src/high-level-action.ts` |
| `host.Dispatcher.dispatch_frame` | `Dispatcher.dispatch_frame` | `Dispatcher dispatch_frame crates/obu-host/src/dispatcher.rs` |
| `host.Dispatcher.serve_peer` | `Dispatcher.serve_peer` | `Dispatcher serve_peer crates/obu-host/src/dispatcher.rs` |
| `host.TaskLifecycle.transition` | `TaskLifecycle.transition` | `TaskLifecycle transition crates/obu-host/src/task_lifecycle.rs` |
| `host.native_messaging.run` | `run` | `native_messaging run crates/obu-host/src/native_messaging.rs` |
| `extension.NativeTransportController.connect` | `NativeTransportController.connect` | `NativeTransportController connect packages/extension/src/native_transport_controller.ts` |
| `extension.BrowserSessionController` | `BrowserSessionController` | `BrowserSessionController packages/extension/src/browser_session_controller.ts` |
| `extension.NativeHostBridge.resolveResponse` | `NativeHostBridge.resolveResponse` | `NativeHostBridge resolveResponse packages/extension/src/native_host_bridge.ts` |
| `extension.appendDebugLog` | `appendDebugLog` | `appendDebugLog packages/extension/src/background.ts` |

P0 should maintain a small source-anchor registry in code rather than building
keys ad hoc at call sites. The registry is also the place to add tests that each
source key has a CodeGraph-friendly query.

### Event Families

P0 defines these event names. All are required for their producing layer when
that layer observes the event. `extension.lifecycle` is required when structured
extension lifecycle snapshots are surfaced through host-visible diagnostics.
`extension.debug` remains best-effort in P0 because raw debug entries only enter
the log when surfaced through host-visible diagnostics or an explicit snapshot
export.

| Event | Meaning |
|---|---|
| `run.started` / `run.finished` | Log run envelope. |
| `mcp.tool.started` / `mcp.tool.finished` | MCP request lifecycle. |
| `kernel.lifecycle` | Node kernel spawn, ready, executing, restart, failure, generation, and recovery transitions. |
| `node.exec.started` / `node.exec.finished` | `js` kernel execution lifecycle. |
| `browser_status.returned` | Readiness, backend discovery, product error, advisories. |
| `backend.discovery` | Backend inventory and descriptor diagnostics observed before SDK selection. |
| `backend.select` | SDK backend selection, ignored candidates, selected backend, and no-backend failures. |
| `backend.connect.started` / `backend.connect.finished` | SDK connection attempt to the selected backend before transport RPC is available. |
| `sdk.method.started` / `sdk.method.finished` | Public SDK wrapper call intent before it collapses to lower-level RPC or observe/action events. |
| `observe.started` / `observe.finished` | `tab.observe()` input mode, result status, sections, state trace. |
| `action.started` / `action.finished` | `tab.step(action)` input kind, result status/effect, state trace. |
| `high_level_action.transition` | High-level action state transition and current step summary. |
| `task.lifecycle` | Durable host task state transitions and resume attempt outcomes. |
| `rpc.request.started` / `rpc.request.finished` | SDK/native-pipe/host RPC method, result/error, duration. |
| `transport.lifecycle` | Timeout, late response, close, reconnect, native status change. |
| `native_pipe.lifecycle` | Kernel native-pipe handshake, connect, write, close, token rejection, and broker-level failures. |
| `host.peer.lifecycle` | Host peer first-frame, auth, dispatch, cancellation, shutdown, and backpressure diagnostics. |
| `extension.lifecycle` | Structured extension lifecycle snapshots mapped into `state.machine/from/to` when available. |
| `extension.debug` | Best-effort sanitized extension debug event when surfaced through host-visible diagnostics or explicit snapshot export. |
| `log.dropped` | Dev-log event drafts were dropped before persistence because the non-blocking log channel was full or disabled mid-run. |
| `log.pruned` | A pruning operation changed retention or payload storage. |
| `index.rebuilt` | SQLite/FTS index was rebuilt from NDJSON. |

### Event Family Invariants

Request-shaped families must be pairable and queryable. The writer enforces
these invariants before persistence:

| Family | Required fields | Pairing key |
|---|---|---|
| `mcp.tool.started/finished` | `ids.correlationId`, `source.entrypoint.key`, `operation.kind/name/status` | `ids.correlationId` |
| `node.exec.started/finished` | `ids.turnId`, `ids.correlationId`, `operation.kind/name/status`, `source.entrypoint.key` | `ids.correlationId` |
| `backend.connect.started/finished` | `ids.correlationId`, `operation.status`, `source.entrypoint.key` | `ids.correlationId` |
| `sdk.method.started/finished` | `ids.correlationId`, `operation.name/status`, `source.entrypoint.key` | `ids.correlationId` |
| `rpc.request.started/finished` | `ids.requestId`, `ids.correlationId`, `operation.name/status`, `source.entrypoint.key` | `ids.requestId` |
| `observe.started/finished` | `ids.observationId`, `ids.tabId`, `operation.status`, `source.entrypoint.key` | `ids.observationId` |
| `action.started/finished` | `ids.actionId`, `ids.tabId`, `operation.status`, `source.entrypoint.key` | `ids.actionId` |
| `task.lifecycle` | `ids.taskId`, `state.machine`, `state.to`, `source.entrypoint.key` | `ids.taskId` |
| `native_pipe.lifecycle` | `ids.requestId` when request-scoped, `operation.name/status`, `source.entrypoint.key` | `ids.requestId` when present |
| `host.peer.lifecycle` | `state.machine`, `state.to`, `source.entrypoint.key`, `occurredAt` when imported from diagnostics | `ids.correlationId` when present |
| `extension.lifecycle` / `extension.debug` | `source.entrypoint.key`, `occurredAt` when imported from snapshots with their own timestamp | `ids.correlationId` when present |

Completion events must include `operation.status` in
`succeeded|partial|blocked|failed|cancelled`. Started events must use
`operation.status = "started"`. If a completion event arrives without a known
started event, it is still persisted but `logs_failure_context` and
`logs_timeline` should expose the missing pair as a diagnostic gap.

## SQLite Query Model

The SQLite database is a rebuildable index over `events.ndjson`.

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  schema_version INTEGER NOT NULL,
  obu_version TEXT,
  runtime_dir TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE events (
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

CREATE VIRTUAL TABLE events_fts USING fts5(
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

The writer inserts into `events` and `events_fts` in the same short best-effort
transaction. `logs_rebuild_index` clears and repopulates both tables from
retained NDJSON, so FTS search must work after both live writes and rebuilds.

`payload_json` stores the post-redaction, post-budget representation, not the
unbounded raw event payload. Payloads above the inline cap are replaced by a
summary, artifact reference, or explicit dropped marker with matching
`pruning.strategy` metadata before SQLite insertion.

Useful indexes:

```sql
CREATE INDEX events_by_correlation ON events(run_id, correlation_id, seq);
CREATE INDEX events_by_state ON events(machine, state_to, ingested_at);
CREATE INDEX events_by_error ON events(error_code, product_error_code, ingested_at);
CREATE INDEX events_by_operation ON events(operation_kind, operation_name, operation_status, ingested_at);
CREATE INDEX events_by_turn ON events(session_id, turn_id, seq);
CREATE INDEX events_by_source ON events(source_entry_key, source_symbol, ingested_at);
CREATE INDEX events_by_occurred_at ON events(occurred_at, run_id, seq);
```

## Agent Query Surfaces

P0 exposes query tools through MCP so an agent can study logs without shelling
out or knowing file paths. The same logic can also back CLI commands.

| Tool | Purpose |
|---|---|
| `logs_list_runs` | Return recent runs with status, counts, first error, size, and prune state. |
| `logs_timeline` | Return ordered events for one run, optionally filtered by component, turn, machine, or error. |
| `logs_search` | FTS search over summaries, event names, operation names, error codes, and next actions. |
| `logs_sql` | Read-only SQL over the SQLite index with guardrails. |
| `logs_failure_context` | Return the smallest useful context around an error, including previous state transitions, source anchors, and correlated request/action/observe events. |
| `logs_source_context` | Return events grouped by `source_entry_key` with CodeGraph queries for each source anchor. |
| `logs_rebuild_index` | Rebuild SQLite/FTS from NDJSON for the selected run or all runs. |

Read-only SQL guardrails:

- open a dedicated read-only SQLite connection for every `logs_sql` call;
- parse or prepare exactly one statement and reject trailing statements;
- require SQLite to report the prepared statement as read-only, and install an
  authorizer that denies write opcodes, `ATTACH`, `DETACH`, PRAGMAs that mutate
  state, temp-table creation, virtual-table creation, extension loading, and
  access to non-log tables;
- allow only the log schema tables/views: `runs`, `events`, and `events_fts`;
- reject recursive CTEs and SQL functions outside an explicit safe allowlist;
- enforce a row limit even when the user omits `LIMIT`;
- install a progress handler or equivalent time budget so expensive read-only
  statements are interrupted rather than blocking the MCP server;
- return a structured rejection reason so agents can rewrite the query.

Example agent queries:

```sql
SELECT machine, state_to, count(*) AS n
FROM events
WHERE operation_status IN ('failed', 'blocked')
GROUP BY machine, state_to
ORDER BY n DESC;
```

```sql
SELECT run_id, seq, event, operation_name, error_code, summary
FROM events
WHERE product_error_code = 'dialog_requires_decision'
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

Log query tools are not part of the browser automation trajectory by default.
Calling `logs_*` must not append `mcp.tool.started/finished` events to the run
being inspected, or agents will contaminate the evidence they are studying. If
query auditing is needed, write it to a separate admin stream or admin run.

## Pruning And Recovery

P0 pruning is deterministic and visible in the log.

Default retention:

- keep last 20 runs;
- keep at most 500 MB total under `$OBU_RUNTIME_DIR/logs/dev`;
- inline event payloads up to 32 KB after redaction;
- larger payloads become summaries or artifact references;
- screenshots and binary displays are artifact refs, never inline base64 in the
  SQLite summary path.

Pruning order:

1. Determine expired artifacts and payloads, but do not delete them yet.
2. Append and fsync `log.pruned` tombstone events for artifacts or payloads
   that are about to become unavailable. Each tombstone must identify the
   affected run, event sequence, artifact id or payload path, and reason through
   `pruning.target`.
3. Remove the expired artifacts or payload files.
4. Delete oldest complete runs until total size is under budget.
5. Never partially delete the active run.

Recovery guarantees after pruning:

- run manifest survives for retained runs;
- event order, component, event name, ids, operation status, state transition,
  source anchor, error code, product error code, next action, and summary survive;
- full payload may be absent, but absence is explicit through `pruning.strategy`;
- artifact or payload deletion is discoverable by joining `log.pruned`
  tombstones to the original event through `pruning.target`;
- SQLite can be rebuilt from remaining NDJSON records;
- deleted runs are represented by aggregate retention metadata in the parent
  log manifest.

`events.ndjson` remains append-only for retained runs. Pruning does not rewrite
old event records in place. If future compaction is needed, it must produce a
new generation such as `events.compacted.ndjson` and update the run manifest so
the original-to-compacted relationship is explicit.

P0 recovery means reconstructing the debugging timeline and last known state. It
does not mean replaying browser actions, because browser actions may have side
effects and depend on external page state.

## Redaction

P0 uses a shared redaction helper for Node/SDK log payloads and mirrors the
extension's existing debug-data sanitization rules.

Rules:

- redact keys matching `token`, `password`, `secret`, `auth`, `cookie`,
  `credential`, and `api_key`;
- redact browser-storage and credential payloads such as `sessionStorage`,
  cookie jars, bearer/session tokens, and password fields;
- cap string lengths in summaries;
- cap object depth and array length;
- do not log raw cookies, local storage, session storage, password values, or
  complete page text by default;
- allow richer artifacts only when a dev flag explicitly requests them.

Envelope and control-plane ids are not redacted by substring matching.
`ids.sessionId`, `ids.turnId`, `requestId`, `actionId`, and `observationId` are
kept because they are the join keys that make the log queryable. Redaction
applies to user/page payloads and diagnostic data copied into `input`, `output`,
`error.data`, `text`, and artifact summaries.

The redaction decision is part of the event's `redaction` metadata, and any
payload-size storage decision is part of `pruning`. `summary` remains a
human- and FTS-friendly string derived after redaction so agents can tell whether
an absence is expected without reading raw payloads.

## Integration Points

### CLI

- Add `--dev-logs` to `obu mcp stdio`.
- Add `--dev-logs` to `obu mcp-config --print` so generated agent configs can
  opt into the mode.
- Add `obu logs` commands only after MCP query tools are available.

### Node REPL MCP Server

- Create the run manifest and log writer.
- Wrap MCP tool dispatch so every non-log MCP tool has
  `mcp.tool.started/finished`, including `browser_status`, `js`, `js_reset`,
  `agent_runtime_status`, and `js_add_module_dir`; exclude `logs_*` tools from
  the inspected run's trajectory.
- Emit `kernel.lifecycle` for spawn, ready, executing, restart, failed, and
  recovered states using the same generation values exposed by `browser_status`.
- Wrap `call_js` for `node.exec.started/finished`.
- Add stdout-demux support for `dev_log_event` kernel frames and route them to
  the Rust-side aggregator without exposing them as user-visible MCP stdout.
- Emit `native_pipe.lifecycle` for kernel native-pipe handshake, connect, write,
  close, token rejection, async close, and broker dispatch failures.
- Register MCP query tools backed by the SQLite index.
- Own canonical run sequencing and all writes to `events.ndjson` and
  `index.sqlite`.

### SDK

- Add a small log sink interface with a no-op default.
- In the Node kernel, connect that sink to the `dev_log_event` stdout frame
  when `OBU_DEV_LOG=1`; outside the managed kernel it remains no-op unless a
  future embedder installs its own sink.
- Emit `backend.discovery`, `backend.select`, and `backend.connect.*` around
  `Browsers.list()`, `Browsers.diagnostics()`, `Browsers.get()`,
  `selectBackend()`, and connector `connectBackend()` so no-backend and
  pre-transport failures are queryable.
- Emit `sdk.method.started/finished` from public SDK wrapper boundaries that do
  not already have a more specific event family. The event must carry the
  wrapper source anchor even when the lower-level `rpc.request.*` event also
  exists, so agents can recover the caller intent.
- Emit observe/action/high-level action events from existing state trace points,
  including source anchors from a small source-anchor registry.
- Emit `task.lifecycle` for `BrowserTasks.resume()` and host task-state outcomes,
  including `attach_failed`, `blocked`, `observation_failed`, and successful
  attach/commit paths.
- Record RPC lifecycle through `Transport.sendRequest`.
- Keep SDK event emission best-effort: logging failures must not break browser
  automation.

### Host

- Keep stderr tracing for protocol safety.
- Forward selected host lifecycle facts into the node-repl log through existing
  response/diagnostic surfaces first.
- Do not write the canonical P0 run file directly from Rust host code.
- Reuse existing structured diagnostics where possible, especially peer/auth
  lifecycle, request lifecycle, and task-store events. When host diagnostics
  include state-machine events, map them into `state.machine`, `state.from`, and
  `state.to` rather than burying them only in `text`.

### Extension

- P0 does not require the extension to write to the filesystem.
- Existing `appendDebugLog` events remain the source vocabulary for extension
  diagnostics.
- When a host response includes extension diagnostics, node-repl/SDK records the
  sanitized event into the run log.
- Structured extension status snapshots such as native transport, native request,
  session lifecycle, overlay release, update, and tab ownership diagnostics map
  to `extension.lifecycle` with `state.machine/from/to` when those fields are
  available. Raw `appendDebugLog` entries remain `extension.debug`.
- `extension.debug` is best-effort in P0. A later explicit bridge can export
  extension debug snapshots on demand.

## Testing Strategy

Unit tests:

- shared schema fixture roundtrips in Rust and TypeScript;
- run id validation rejects path traversal, dot segments, drive prefixes, and
  encoded separators before filesystem joins;
- event redaction and payload caps;
- event-family validators reject product-significant events that lack required
  ids, source anchors, or operation status;
- NDJSON append format and sequence allocation;
- SQLite index insertion and FTS search;
- source-anchor registry shape and SQL indexing;
- source-anchor registry covers backend selection, public SDK wrappers,
  native-pipe broker, host peer/task lifecycle, and structured extension
  lifecycle anchors;
- read-only SQL guardrails;
- `logs_sql` rejects mutating CTEs, forbidden tables, multiple statements,
  unsafe functions, recursive CTEs, and long-running read-only statements;
- pruning keeps timeline-critical fields;
- `log.pruned` tombstones identify the original event and artifact/payload that
  became unavailable;
- redaction metadata is present in NDJSON and rebuilds into SQLite
  `redaction_json`;
- rebuild index from NDJSON.

Integration tests:

- `obu mcp stdio --dev-logs` starts with clean MCP stdout and writes logs under
  the runtime directory;
- `OBU_DEV_LOG=1` enables dev logs without the CLI flag, and
  `obu mcp stdio --dev-logs` without `OBU_DEV_LOG_RUN_ID` generates a
  time-sortable run id visible inside the Node kernel;
- MCP server shutdown, stdin EOF, and startup failure paths flush `run.finished`
  with the correct status before the process exits;
- dev-log enablement survives the node-repl minimal environment and is visible
  to SDK code running in the Node kernel;
- `browser_status` creates a queryable `browser_status.returned` event;
- `kernel.lifecycle` events show spawn, ready, reset/restart, failed, and
  recovered generation transitions in order;
- `agent_runtime_status` and `js_add_module_dir` create normal
  `mcp.tool.started/finished` events and `logs_*` tools do not contaminate the
  inspected run;
- SDK `dev_log_event` frames from the kernel are assigned canonical Rust-side
  sequence numbers and do not interfere with `exec_result` routing;
- imported host and extension snapshots preserve producer timestamps as
  `occurredAt` while `seq` and `ingestedAt` reflect aggregator ingestion order;
- `agent.browsers.get()` no-backend and successful-connect paths create
  `backend.discovery`, `backend.select`, and `backend.connect.*` events before
  any transport RPC is available;
- public SDK wrappers that are not `observe`, `step`, or high-level actions
  create `sdk.method.*` events with their own source anchors while still
  correlating to underlying `rpc.request.*` events when applicable;
- a simulated `js` call with `tab.observe()` and `tab.step()` creates correlated
  observe/action/RPC events with CodeGraph-friendly source anchors;
- a durable task resume creates queryable `task.lifecycle` events for successful
  attach, blocked, attach_failed, and observation_failed outcomes;
- native-pipe handshake/connect/write/close and token rejection create
  `native_pipe.lifecycle` events with kernel request ids and connection ids;
- host peer/auth rejection and normal peer shutdown create `host.peer.lifecycle`
  events surfaced through host-visible diagnostics;
- extension status snapshots with lifecycle diagnostics create
  `extension.lifecycle` events while raw debug entries remain `extension.debug`;
- a timeout or structured RPC error appears in `logs_failure_context`;
- calling `logs_timeline` while inspecting a run does not append query events to
  that inspected run;
- non-dev mode writes no dev log files.

Smoke tests:

- packaged MCP stdio stays protocol-clean;
- generated MCP config can include dev logs without altering normal config;
- rebuild command reconstructs SQLite from NDJSON after deleting the SQLite file.

## Risks

- **Sensitive data:** mitigated by default-off mode, owner-only runtime dir,
  shared redaction, payload caps, and no browser storage capture.
- **MCP protocol pollution:** logs must never write to stdout. All file writes
  are side-channel only.
- **Performance:** writer uses buffered append and bounded SQLite transactions;
  if indexing fails, NDJSON remains the source log.
- **Schema drift:** schema version is required in every event and in the run
  manifest. Cross-language event shapes are guarded by a shared schema and
  fixtures, not by duplicated comments.
- **SQL abuse:** `logs_sql` is read-only by SQLite connection mode, authorizer,
  prepared-statement validation, table allowlisting, row limits, and a progress
  handler/time budget.
- **Path traversal:** explicit run ids are validated as safe single path
  segments before path joins.
- **Source-anchor drift:** source keys must be registry-defined and tested
  against CodeGraph-friendly symbol/file queries rather than handwritten at
  every call site.
- **Partial cross-process coverage:** P0 favors SDK/node-repl/host-visible
  events first. Direct extension filesystem logging is deferred.

## Future Extensions

- DuckDB/Parquet export for broad research over many runs.
- OpenTelemetry OTLP export for Phoenix, SigNoz, or Grafana deployments.
- LanceDB or Qdrant semantic search over redacted run summaries.
- Optional rrweb-style replay artifacts behind a separate explicit flag.
- Human UI over the same SQLite query API.

## File Structure For Implementation

| File | Status | Responsibility |
|---|---|---|
| `docs/superpowers/schemas/dev-log-event.schema.json` | create | Shared cross-language event and kernel-frame contract. |
| `docs/superpowers/schemas/fixtures/dev-log/` | create | Rust/TypeScript contract fixtures for valid and invalid event families. |
| `crates/obu-node-repl/src/dev_log/` | create | Run manifest, canonical sequencer, NDJSON writer, SQLite indexer, query API. |
| `crates/obu-node-repl/src/mcp_server.rs` | modify | Wrap MCP calls and expose log query tools. |
| `crates/obu-node-repl/src/cli.rs` | modify | Add `--dev-logs` and log path options. |
| `crates/obu-node-repl/src/repl_manager/mod.rs` | modify | Emit kernel lifecycle events; demux `dev_log_event` kernel frames and forward event drafts to the aggregator. |
| `crates/obu-node-repl/src/repl_manager/spawn.rs` | modify | Propagate `OBU_DEV_LOG*` variables through the minimal Node kernel environment. |
| `crates/obu-node-repl/src/native_pipe/` | modify | Emit native-pipe handshake, connect, write, close, token rejection, and async close lifecycle events. |
| `crates/obu-node-repl/embedded/kernel.js` | modify | Install the kernel-side dev-log sink and serialize event drafts as `dev_log_event` frames. |
| `packages/cli/src/index.ts` | modify | Pass dev-log env to node-repl and print dev MCP config. |
| `packages/sdk/src/dev-log.ts` | create | Browser-runtime log sink, source anchors, and redaction helpers. |
| `packages/sdk/src/browsers.ts` | modify | Emit backend discovery, selection, no-backend, and connection lifecycle events. |
| `packages/sdk/src/browser*.ts` | modify | Emit `sdk.method.*` and task lifecycle events for Browser-level public wrappers. |
| `packages/sdk/src/wire/transport.ts` | modify | Emit RPC lifecycle events. |
| `packages/sdk/src/tab.ts` | modify | Emit observe/action lifecycle events. |
| `packages/sdk/src/tab-*.ts` | modify | Emit `sdk.method.*` from Tab subdomain wrappers that do not already emit observe/action/high-level-action events. |
| `packages/sdk/src/high-level-action.ts` | modify | Emit high-level action transition events. |
| `crates/obu-host/src/dispatcher.rs` | modify | Surface host peer/auth lifecycle diagnostics into dev-log-visible host events. |
| `crates/obu-host/src/task_lifecycle.rs` | modify | Surface durable task lifecycle transitions and resume outcomes. |
| `packages/extension/src/lifecycle/` | modify | Preserve structured lifecycle diagnostics for mapping into `extension.lifecycle`. |
| `packages/extension/src/native_transport_controller.ts` | modify | Surface native transport lifecycle snapshots through extension status/debug diagnostics. |
| `docs/troubleshooting.md` | modify | Document how agents query local dev logs. |
| `crates/obu-node-repl/tests/` | modify/create | Dev-log writer, query, MCP tool, and stdout-clean tests. |
| `packages/sdk/tests/` | modify/create | SDK event emission and redaction tests. |
