# Agent-Queryable Dev Logs Design

**Status:** P0 approved in brainstorming; pending written-spec review, then implementation plan.

**Date:** 2026-05-26

## Goal

Add a local-first dev log mode that lets agents inspect, query, and study OBU's
browser automation behavior across MCP, node-repl, SDK, host, and extension
boundaries.

The primary user is an agent debugging or improving OBU itself. The log must
answer questions such as:

- What happened in this run, in exact order?
- Which state machine transitioned into a bad or surprising state?
- What did `browser_status`, `observe`, `action`, RPC, native transport, and
  extension diagnostics return?
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
5. **Pruning preserves reasoning.** Large payloads may be dropped or summarized,
   but the event timeline, state transitions, statuses, error codes, and
   recovery hints remain.
6. **Local and private by default.** No upload, no remote collector, no page
   storage capture, and no cookies/passwords/tokens in normal logs.

## Scope

P0 covers developer runs started through `obu mcp stdio` or a dev-mode MCP
configuration. It records:

- MCP tool calls: `browser_status`, `js`, `js_reset`, and later log-query tools.
- node-repl execution lifecycle: turn id, kernel generation, duration, stdout
  budget/truncation flags, structured user-code error detail.
- SDK runtime: `browser_status` discovery, `tab.observe()`, `tab.step()`,
  high-level action state traces, request lifecycle diagnostics.
- Host/native-pipe RPC: method, request id, duration, success/error, timeout and
  late-response lifecycle.
- Host state machines and diagnostics exposed through existing `tracing` sites
  where practical.
- WebExtension debug events that already flow through `appendDebugLog`, mirrored
  into the dev log through host-visible responses or a future export bridge.

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

The CLI wrapper propagates the log configuration into `obu-node-repl` and the
Node kernel:

```text
OBU_DEV_LOG=1
OBU_DEV_LOG_DIR=$OBU_RUNTIME_DIR/logs/dev
OBU_DEV_LOG_RUN_ID=<generated-run-id>
```

The default run id is time-sortable:

```text
YYYYMMDDTHHMMSSmmmZ-<short-random>
```

All files live under:

```text
$OBU_RUNTIME_DIR/logs/dev/<run_id>/
  manifest.json
  events.ndjson
  events.sqlite
  artifacts/
```

The runtime directory owner-only validation already used by OBU applies before
writing logs.

## Event Model

Every event is a JSON object with a stable envelope:

```ts
type DevLogEvent = {
  schemaVersion: 1;
  seq: number;
  ts: string;
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
  operation?: {
    kind: "mcp_tool" | "js_exec" | "rpc" | "observe" | "action" | "high_level_action" | "transport" | "extension_event";
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
  pruning?: {
    payloadBytes?: number;
    storedBytes?: number;
    strategy?: "inline" | "summary" | "artifact_ref" | "dropped";
  };
  text?: string;
};
```

The envelope is intentionally close to OpenTelemetry concepts, but names remain
OBU-native so browser-control semantics are not forced into generic span fields.

### Required Event Families

P0 defines these event names:

| Event | Meaning |
|---|---|
| `run.started` / `run.finished` | Log run envelope. |
| `mcp.tool.started` / `mcp.tool.finished` | MCP request lifecycle. |
| `node.exec.started` / `node.exec.finished` | `js` kernel execution lifecycle. |
| `browser_status.returned` | Readiness, backend discovery, product error, advisories. |
| `observe.started` / `observe.finished` | `tab.observe()` input mode, result status, sections, state trace. |
| `action.started` / `action.finished` | `tab.step(action)` input kind, result status/effect, state trace. |
| `high_level_action.transition` | High-level action state transition and current step summary. |
| `rpc.request.started` / `rpc.request.finished` | SDK/native-pipe/host RPC method, result/error, duration. |
| `transport.lifecycle` | Timeout, late response, close, reconnect, native status change. |
| `extension.debug` | Sanitized extension debug event mirrored from existing debug log vocabulary. |
| `log.pruned` | A pruning operation changed retention or payload storage. |
| `index.rebuilt` | SQLite/FTS index was rebuilt from NDJSON. |

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
  ts TEXT NOT NULL,
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
  operation_kind TEXT,
  operation_name TEXT,
  operation_status TEXT,
  duration_ms INTEGER,
  error_code TEXT,
  product_error_code TEXT,
  next_action TEXT,
  summary TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE VIRTUAL TABLE events_fts USING fts5(
  run_id UNINDEXED,
  seq UNINDEXED,
  event,
  component,
  operation_name,
  summary,
  error_code,
  product_error_code,
  next_action
);
```

Useful indexes:

```sql
CREATE INDEX events_by_correlation ON events(run_id, correlation_id, seq);
CREATE INDEX events_by_state ON events(machine, state_to, ts);
CREATE INDEX events_by_error ON events(error_code, product_error_code, ts);
CREATE INDEX events_by_operation ON events(operation_kind, operation_name, operation_status, ts);
CREATE INDEX events_by_turn ON events(session_id, turn_id, seq);
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
| `logs_failure_context` | Return the smallest useful context around an error, including previous state transitions and correlated request/action/observe events. |
| `logs_rebuild_index` | Rebuild SQLite/FTS from NDJSON for the selected run or all runs. |

Read-only SQL guardrails:

- allow only `SELECT`, `WITH`, `EXPLAIN QUERY PLAN`;
- reject multiple statements;
- enforce a row limit;
- expose only log database tables;
- use a dedicated read-only SQLite connection.

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
ORDER BY ts DESC
LIMIT 20;
```

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

1. Remove expired artifacts that are not referenced by retained events.
2. Drop or summarize large payload fields inside old events when a summary
   exists.
3. Delete oldest complete runs until total size is under budget.
4. Never partially delete the active run.

Recovery guarantees after pruning:

- run manifest survives for retained runs;
- event order, component, event name, ids, operation status, state transition,
  error code, product error code, next action, and summary survive;
- full payload may be absent, but absence is explicit through `pruning.strategy`;
- SQLite can be rebuilt from remaining NDJSON records;
- deleted runs are represented by aggregate retention metadata in the parent
  log manifest.

P0 recovery means reconstructing the debugging timeline and last known state. It
does not mean replaying browser actions, because browser actions may have side
effects and depend on external page state.

## Redaction

P0 uses a shared redaction helper for Node/SDK log payloads and mirrors the
extension's existing debug-data sanitization rules.

Rules:

- redact keys matching `token`, `password`, `secret`, `auth`, `cookie`,
  `credential`, `session`, and `api_key`;
- cap string lengths in summaries;
- cap object depth and array length;
- do not log raw cookies, local storage, session storage, password values, or
  complete page text by default;
- allow richer artifacts only when a dev flag explicitly requests them.

The redaction decision is part of the event's `pruning` or `summary` metadata so
agents can tell whether an absence is expected.

## Integration Points

### CLI

- Add `--dev-logs` to `obu mcp stdio`.
- Add `--dev-logs` to `obu mcp-config --print` so generated agent configs can
  opt into the mode.
- Add `obu logs` commands only after MCP query tools are available.

### Node REPL MCP Server

- Create the run manifest and log writer.
- Wrap `call_tool` so every MCP tool has `mcp.tool.started/finished`.
- Wrap `call_js` for `node.exec.started/finished`.
- Register MCP query tools backed by the SQLite index.

### SDK

- Add a small log sink interface with a no-op default.
- Emit observe/action/high-level action events from existing state trace points.
- Record RPC lifecycle through `Transport.sendRequest`.
- Keep SDK event emission best-effort: logging failures must not break browser
  automation.

### Host

- Keep stderr tracing for protocol safety.
- Add optional JSON file layer only in dev log mode, or forward selected host
  lifecycle events into the node-repl log through existing response/diagnostic
  surfaces first.
- Reuse existing structured diagnostics where possible, especially request
  lifecycle and task-store events.

### Extension

- P0 does not require the extension to write to the filesystem.
- Existing `appendDebugLog` events remain the source vocabulary for extension
  diagnostics.
- When a host response includes extension diagnostics, node-repl/SDK records the
  sanitized event into the run log.
- A later bridge can export extension debug snapshots on demand.

## Testing Strategy

Unit tests:

- event redaction and payload caps;
- NDJSON append format and sequence allocation;
- SQLite index insertion and FTS search;
- read-only SQL guardrails;
- pruning keeps timeline-critical fields;
- rebuild index from NDJSON.

Integration tests:

- `obu mcp stdio --dev-logs` starts with clean MCP stdout and writes logs under
  the runtime directory;
- `browser_status` creates a queryable `browser_status.returned` event;
- a simulated `js` call with `tab.observe()` and `tab.step()` creates correlated
  observe/action/RPC events;
- a timeout or structured RPC error appears in `logs_failure_context`;
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
  manifest.
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
| `crates/obu-node-repl/src/dev_log/` | create | Run manifest, NDJSON writer, SQLite indexer, query API. |
| `crates/obu-node-repl/src/mcp_server.rs` | modify | Wrap MCP calls and expose log query tools. |
| `crates/obu-node-repl/src/cli.rs` | modify | Add `--dev-logs` and log path options. |
| `packages/cli/src/index.ts` | modify | Pass dev-log env to node-repl and print dev MCP config. |
| `packages/sdk/src/dev-log.ts` | create | Browser-runtime log sink and redaction helpers. |
| `packages/sdk/src/wire/transport.ts` | modify | Emit RPC lifecycle events. |
| `packages/sdk/src/tab.ts` | modify | Emit observe/action lifecycle events. |
| `packages/sdk/src/high-level-action.ts` | modify | Emit high-level action transition events. |
| `docs/troubleshooting.md` | modify | Document how agents query local dev logs. |
| `crates/obu-node-repl/tests/` | modify/create | Dev-log writer, query, MCP tool, and stdout-clean tests. |
| `packages/sdk/tests/` | modify/create | SDK event emission and redaction tests. |
