# State Machine State Space And Lifecycle Gap Analysis

Date: 2026-05-23

This document is a CodeGraph-backed status analysis of the current implementation against the product goal:

> open-browser-use should behave as a verifiable browser environment runtime for agents. SDK/runtime code may compose freely, but every real browser side effect must pass through explicit local lifecycle authority, host policy, session and turn ownership, Chrome extension control boundaries, and structured diagnostics.

This is a follow-up comparison document for:

- `docs/agent-browser-environment-lifecycle-goal.md`
- `docs/state-machine-architecture-review-findings.md`
- `docs/state-machine-lifecycle-protocol-completeness-review.md`

It is not a replacement for those documents. It records the current distance from state-space completeness and lifecycle protocol integrity so future implementation passes can compare findings, evidence, and fixes.

## CodeGraph Scope

CodeGraph was used to inspect structural entry points and lifecycle files rather than relying only on text search.

Observed state-machine coverage:

- Extension lifecycle planners: `packages/extension/src/lifecycle/` contains 10 planner files: browser session, CDP input, download lifecycle, extension update, finalization, foreground observer, native request bridge, native transport, overlay, and tab ownership.
- Host lifecycle planners: `crates/obu-host/src/peer_lifecycle.rs`, `crates/obu-host/src/registry_lifecycle.rs`, and `crates/obu-host/src/runtime_descriptor_lifecycle.rs`.
- CodeGraph entry points for this audit included SDK `Transport`, CLI `RuntimeDescriptorLifecycle`, host `RuntimeDescriptorState`, extension `resumeControl`, host `list_tabs_with_context`, `finalizeTabs`, and `resumeControlResult`.
- Follow-up completeness pass also covered `VerifySetupState`, Node REPL `KernelState`, host `PeerLifecycleState`, host registry file chooser/download/Playwright handle state, extension update pending state, extension native request pending state, dispatcher mutation taxonomy, and generated method policy classification.

## Completeness Bar

A lifecycle protocol is complete only when all of these hold:

1. State space is explicit and closed: invalid combinations are unrepresentable or rejected at one boundary.
2. Read/observe paths do not mutate lifecycle state unless they are explicitly named and typed as reconciliation actions.
3. Every browser-affecting action has a guard, planner, executor, cleanup obligations, and structured failure state.
4. Pending, partial, blocked, stale, failed, and repair-required states are first-class and agent-observable.
5. SDK, host, extension, CLI, and Node REPL use compatible lifecycle vocabulary.
6. Tests cover success, partial failure, fatal failure, stale repair, blocked ownership, late completion, and cleanup failure.

## Current Verdict

The implementation has a solid lifecycle backbone in several places, but it is not yet state-space complete.

The important progress is real:

- Extension active-tab read paths now use a pure planner and return repair-required data instead of deleting or persisting state.
- Extension `resumeControl()` now returns typed blocked repair state when no active tab can be restored.
- Host active-tab writes are validated against same-session active tab authority.
- Human takeover is represented in both extension and host registry.
- Overlay release has `release_pending` and `release_failed`.
- Native transport distinguishes `cleanup_failed` from `stopped`.
- Native messaging records late timeout diagnostics.
- SDK tabs enforce commandability before browser-affecting methods.
- CLI runtime descriptor lifecycle distinguishes invalid vs stale descriptor states.

The remaining gaps are mostly cross-layer closure gaps: host read paths can still reconcile, session and turn state are still mutable records, finalization failures are not durable lifecycle states, timeout diagnostics are observable but not yet a recovery protocol, descriptor vocabulary is duplicated across TS and Rust, browser-effect handles are not a closed state space, peer pre-dispatch terminal paths do not all produce closure diagnostics, and extension update idle waiting has no terminal policy.

## Gap Matrix

| Gap | Severity | Current state | Missing for completeness |
| --- | --- | --- | --- |
| `GAP-1` Host read/reconcile boundary | P1 | Extension reads are pure; host `getTabs`/`getCurrentTab` still mutate registry state | Provide pure host observation APIs; any reconcile-capable read path must be explicitly typed as repair/reconcile and return applied effects |
| `GAP-2` Browser session state space | P2 | Session is a mutable record with optional fields | Discriminated session lifecycle or explicit invalid-state guards plus persistent diagnostics |
| `GAP-3` Finalization failure persistence | P2 | `finalizeTabs()` returns `partial`/`fatal` but does not durably mark session failure | Durable `finalize_partial`/`finalize_failed` lifecycle diagnostics |
| `GAP-4` Native transport implicit states | P2 | Public states include `connected`, `stopped`, `cleanup_failed`, etc.; intermediate states are booleans/timers | First-class `stopping`, `hello_pending`, `heartbeat_failed`, `reconnect_scheduled` |
| `GAP-5` Timeout recovery protocol | P2 | Native messaging records late completion diagnostics | Agent-visible `timed_out_pending_reconcile` protocol and next action |
| `GAP-6` Runtime descriptor vocabulary parity | P3 | CLI and Node REPL have parallel lifecycle vocabularies with different ownership surfaces | Generated/shared lifecycle schema or owner/applicability-scoped parity fixture |
| `GAP-7` Resume repair adoption | P3 | `resumeControlResult()` exposes typed blocked/repair state; default API still flattens to `undefined` | Runtime/help/docs and higher-level flows should prefer structured result when recovery matters |
| `GAP-8` Overlay release terminal policy | P3 | Pending/failed release is modeled and blocks idle | Bounded retry/escalation/acknowledgement policy for persistent release failure |
| `GAP-9` Turn lifecycle state space | P2 | `turn_id` is required metadata for mutating calls, but the turn itself has no durable lifecycle state | First-class `open`/`yielded`/`finalizing`/`ended`/`failed` turn state or equivalent session-scoped protocol |
| `GAP-10` Browser-effect handle lifecycle | P2 | File chooser, download, debugger, and injected-runtime handles have insertion/cleanup events but no closed public state model | Handle state unions with pending/active/consumed/completed/failed/stale/gone outcomes and owner/turn proof |
| `GAP-11` Extension update pending lifecycle | P3 | Pending update only models `waiting_for_idle` and depends on activity snapshots | Terminal blocked/escalated/acknowledged update states and bounded idle-wait policy |
| `GAP-12` Agent runtime kernel lifecycle diagnostics | P3 | Node REPL has internal `KernelState`, but public status does not expose kernel failed/restarting/recovered lifecycle | Public kernel lifecycle diagnostics for spawn/ready/executing/restarting/failed/recovered states |
| `GAP-13` Peer terminal diagnostics | P2 | Peer auth/rejection states exist, but some pre-dispatch close/rejection paths return before peer shutdown is recorded | Every accepted, rejected, empty, closed, and canceled peer path emits a terminal diagnostic with rejection/close reason and cleanup outcome |

## Detailed Findings

### GAP-1: Host read paths still reconcile lifecycle state

Status:

Partially fixed. Extension-level query-shaped methods now avoid cleanup mutation, but host-level read paths still repair and mutate registry/session state.

Evidence:

- Extension `getSessionTabs()` uses `planSessionActiveTabResolution()` and returns `repair_required` without applying cleanup: `packages/extension/src/browser_session_controller.ts:115`.
- Extension `getCurrentSessionTab()` also uses the pure planner and does not persist repairs: `packages/extension/src/browser_session_controller.ts:143`.
- Host WebExtension `list_tabs_with_context()` records tabs, reconciles missing tabs, and calls `forget_tab_state()` while serving `getTabs`: `crates/obu-host/src/backends/webext/mod.rs:373`.
- Host WebExtension `current_tab_with_context()` records the tab and calls `registry().set_active_tab()` while serving `getCurrentTab`: `crates/obu-host/src/backends/webext/mod.rs:413`.
- Host registry `current_tab_for_session()` takes a write lock, runs active-tab repair, mutates `active_tab_id`, and records a reconciliation lifecycle event while returning the current tab: `crates/obu-host/src/service_registry.rs:451`.

Why it matters:

The product invariant says observation and action should have different authority. If `getTabs` or `getCurrentTab` can mutate registry lifecycle state, downstream agents cannot know whether a read merely observed the environment or repaired it.

Recommended fix:

Split host authority into two explicit surfaces:

- `observe_session_tabs` / `observe_current_tab`: side-effect free, returns rows plus repair plan.
- `reconcile_session_tabs` / `repair_current_tab`: explicit action, applies cleanup and emits diagnostics.

If the current host `getTabs`/`getCurrentTab` behavior remains the bridge that imports WebExtension rows into the host registry, then it should be renamed, documented, or typed as a reconcile-capable operation rather than treated as pure observation.

Acceptance tests:

- Pure host observe APIs do not update registry tabs, stale diagnostics, active tab, lifecycle event count, or cleanup handles.
- Any host read-shaped API that updates registry tabs, stale diagnostics, active tab, lifecycle event count, or cleanup handles returns the plan/effects it applied and is exposed as reconcile/repair authority.
- Explicit reconcile action performs those mutations and returns the plan/effects it applied.

### GAP-2: Browser session is still a mutable field bag

Status:

Partial. Guards and planners exist, but `BrowserSession` is still not a closed state space.

Evidence:

- `BrowserSession` is represented as independent fields: `currentTurnId`, optional `activeTabId`, optional `controlState`, `tabs`, `finalizedTabs`, `attachedTabIds`, groups, and label: `packages/extension/src/session_store.ts:3`.
- Session tab status is only `active | handoff | deliverable`: `packages/extension/src/session_store.ts:15`.
- Active-tab repair cleanup obligations are explicit at the planner level: `packages/extension/src/browser_session_controller.ts:330`.
- `resumeControl()` now expresses blocked repair state, but session-level states such as `resuming`, `finalizing`, `finalize_failed`, `cleanup_failed`, or `stale` are not encoded on the session object: `packages/extension/src/browser_session_controller.ts:242`.

Why it matters:

Independent fields can represent invalid combinations, such as a yielded session with pending finalization failure, an active tab id pointing at a finalized tab, or attached debugger ids without a commandable tab. The current code repairs many of these, but the state space itself does not prevent them.

Recommended fix:

Introduce a session lifecycle state model, even if initially stored as diagnostics:

```ts
type BrowserSessionLifecycle =
  | { kind: "active"; activeTabId?: number }
  | { kind: "human_takeover"; activeTabId?: number }
  | { kind: "resuming"; repairPlanId: string }
  | { kind: "finalizing"; planId: string }
  | { kind: "finalize_partial"; failures: FinalizeTabFailure[] }
  | { kind: "finalize_failed"; errorCode: string; errorMessage: string }
  | { kind: "cleanup_failed"; failures: CleanupFailure[] }
  | { kind: "stale"; reason: string };
```

Acceptance tests:

- Invalid field combinations are rejected or normalized by one planner.
- `finalize_partial`, `finalize_failed`, and `cleanup_failed` survive a status/read call until acknowledged or repaired.

### GAP-3: Finalization failures are returned but not durable lifecycle state

Status:

Partial. `finalizeTabs()` has structured return values, but failure state is not preserved as a session lifecycle state.

Evidence:

- `finalizeTabs()` blocks human takeover: `packages/extension/src/finalize_tabs_controller.ts:88`.
- Per-tab failures are returned in `failures` and logged as `tabs.finalize.partial_failure`: `packages/extension/src/finalize_tabs_controller.ts:154`.
- Reconciliation failure returns `status: "fatal"` with error fields: `packages/extension/src/finalize_tabs_controller.ts:183`.
- Success/partial result is returned as `status: failures.length > 0 ? "partial" : "ok"`: `packages/extension/src/finalize_tabs_controller.ts:215`.

Why it matters:

Finalization is the episode boundary for an agent environment. If a partial or fatal finalization is only visible in the immediate response, later status surfaces may look idle/ready even though cleanup did not fully complete.

Recommended fix:

Persist a compact finalization diagnostic on the session or extension status:

- `last_finalize_status`
- `last_finalize_failures`
- `requires_repair: true`
- `cleared_by: successful_finalize | explicit_repair | diagnostics_ack`

Acceptance tests:

- A failed tab cleanup leaves `finalize_partial` visible through `getInfo`/extension diagnostics.
- A fatal reconciliation leaves `finalize_failed` visible and blocks false idle.
- A subsequent successful finalize or explicit repair clears the diagnostic.

### GAP-4: Native transport has hidden intermediate states

Status:

Partial. `cleanup_failed` is first-class, but several transition states remain implicit.

Evidence:

- Public native host states are `disconnected | connecting | connected | version_mismatch | stopped | cleanup_failed | error`: `packages/extension/src/lifecycle/native_transport_machine.ts:1`.
- `stopping` is a controller boolean, not a public state: `packages/extension/src/native_transport_controller.ts:217`.
- During stop, the controller first publishes `stoppedStatus("Stopping...")`, then later publishes either `cleanup_failed` or final `stopped`: `packages/extension/src/native_transport_controller.ts:223`.
- Bootstrapping treats stored `stopped` and `cleanup_failed` as `stopping = true`: `packages/extension/src/native_transport_controller.ts:117`.

Why it matters:

For a product-facing environment protocol, `stopped` should mean cleanup completed. Publishing `stopped` as a temporary "Stopping..." state makes the public state ambiguous, even if the final state is corrected later.

Recommended fix:

Add first-class states:

- `stopping`
- `hello_pending`
- `heartbeat_failed`
- `reconnect_scheduled`

Acceptance tests:

- Public/persisted stop state publishes `stopping`, not `stopped`, before cleanup completes.
- `stopped` is only published as public/persisted state after cleanup success.
- `cleanup_failed` survives restart and blocks reconnect until explicit resume/repair.

### GAP-5: Timeout late completion is observable but not yet a recovery protocol

Status:

Partial. Rust host native messaging preserves late completion diagnostics, but SDK/agent recovery remains a separate manual interpretation. The extension-to-native bridge also still tracks pending native requests as an in-memory map/boolean rather than a typed request lifecycle.

Evidence:

- Native transport diagnostics include `pending`, `recent_events`, and `awaiting_late_completion`: `crates/obu-host/src/native_messaging.rs:305`.
- On timeout, the host records `timed_out_awaiting_late_completion`: `crates/obu-host/src/native_messaging.rs:386`.
- Late responses become `timed_out_late_success` or `timed_out_late_error`: `crates/obu-host/src/native_messaging.rs:422`.
- Late transport close becomes `timed_out_late_transport_closed`: `crates/obu-host/src/native_messaging.rs:446`.
- SDK `Transport` still resolves timeout as an immediate `ERR_TIMEOUT` and removes the pending request from SDK state: `packages/sdk/src/wire/transport.ts:64`.
- Extension `NativeHostBridge` tracks pending native requests in `pending: Map<number, PendingNativeRequest>` and exposes only `hasPendingRequests()`: `packages/extension/src/native_host_bridge.ts:55`.
- Extension pending requests are rejected on disconnect/stop through `rejectPending()`, but no per-request public lifecycle state survives the rejection: `packages/extension/src/native_host_bridge.ts:111`.

Why it matters:

In an agent environment, timeout is not always terminal. A click, navigation, close, CDP command, or extension-native bridge request can still complete or be rejected after a higher layer has already moved on. The current diagnostics explain some host-side late outcomes, but the API does not yet guide the agent to reconcile before retrying, and extension bridge pending requests are not exposed with the same state vocabulary.

Recommended fix:

Add a product-level timeout state:

```ts
type BrowserEffectTimeoutState =
  | { kind: "timed_out_pending_reconcile"; requestId: number; method: string }
  | { kind: "timed_out_late_success"; requestId: number; method: string }
  | { kind: "timed_out_late_error"; requestId: number; method: string; error: StructuredRpcError }
  | { kind: "timed_out_late_transport_closed"; requestId: number; method: string };
```

Acceptance tests:

- After SDK timeout, `browser.ensureReady()` or a dedicated diagnostic method exposes the pending reconcile state.
- Extension `NativeHostBridge` exposes pending/rejected/late response diagnostics with request id, method, and next action rather than only a boolean pending count.
- Late success changes the next action from "retry" to "observe/reconcile current browser state".
- Late error preserves structured RPC `error.data`.

### GAP-6: Runtime descriptor lifecycle vocabulary is duplicated across TS and Rust

Status:

Mostly good behavior, but architecture still has drift risk.

Evidence:

- CLI lifecycle has `fresh | stale | invalid`, setup states, product errors, next action mapping, and reason codes including auth/getInfo mismatch/browser kind/extension id mismatch: `packages/cli/src/runtime_descriptor_lifecycle.ts:1`.
- Node REPL lifecycle has `Fresh | Invalid | Stale`, setup states, and reason codes, but its enum is separately maintained and has a different applicability surface: `crates/obu-node-repl/src/repl_manager/runtime_descriptor_lifecycle.rs:35`.
- CLI maps browser kind mismatch to `browser_popup_boundary` and extension id mismatch to `extension_id_mismatch`: `packages/cli/src/runtime_descriptor_lifecycle.ts:107`.
- Node REPL plans ignored descriptors through its own structs: `crates/obu-node-repl/src/repl_manager/runtime_descriptor_lifecycle.rs:177`.

Why it matters:

Descriptor setup/read/liveness is a cross-component environment boundary. If TS and Rust reason-code enums drift without an owner/applicability map, CLI verify and Node `browser_status` can again disagree.

Recommended fix:

Generate lifecycle reason-code schema from one source, or add fixture parity tests that compare TS/Rust public reason codes through an owner/applicability map. Full enum equality is not required when a reason belongs only to CLI verify, Node REPL discovery, host publication, or a browser-popup boundary; the non-applicability must be explicit.

Acceptance tests:

- Every descriptor reason emitted by CLI has a Node REPL equivalent or documented owner/applicability-scoped non-applicability.
- Every Node REPL descriptor reason maps to a product error and next action compatible with CLI verify, or is documented as Node-only with an equivalent product outcome.

### GAP-7: Structured resume result exists but is not yet the default recovery interface

Status:

Partial. Structured state exists; adoption is incomplete.

Evidence:

- SDK exports `BrowserResumeControlResult` and `BrowserResumeControlRepair`: `packages/sdk/src/browser.ts:200`.
- `resumeControlResult()` returns `resumed` or `blocked`: `packages/sdk/src/browser.ts:280`.
- The older `resumeControl()` still flattens blocked/no-tab to `undefined`: `packages/sdk/src/browser.ts:275`.
- Repair details are normalized from the wire but default to empty arrays if the backend does not provide detail: `packages/sdk/src/browser.ts:763`.
- This audit did not find internal production callers of `resumeControlResult()` through CodeGraph, which suggests the structured path is available but not yet used by higher-level runtime helpers in this repo. This does not prove whether external users or examples outside the indexed source have adopted it.

Why it matters:

Agents need structured blocked state when resuming after human takeover. Returning `undefined` is compatible but not sufficient as the main recovery protocol.

Recommended fix:

Use `resumeControlResult()` in help text, examples, and any higher-level runtime recovery helper. Keep `resumeControl()` as a convenience wrapper.

Acceptance tests:

- Help/examples mention structured blocked repair.
- A blocked resume path returns recovery diagnostics all the way through SDK public API.

### GAP-8: Overlay release has pending/failed states but no terminal policy

Status:

Partial. The state model is better than before, but lacks escalation/acknowledgement semantics.

Evidence:

- Overlay lifecycle state includes `active`, `release_pending`, and `release_failed`: `packages/extension/src/lifecycle/overlay_machine.ts:14`.
- Failed release increments failure count: `packages/extension/src/lifecycle/overlay_machine.ts:92`.
- Pending/failed release blocks activity/idle checks: `packages/extension/src/overlay_coordinator.ts:166`.
- Diagnostics expose `release_pending`/`release_failed` with session and turn ids: `packages/extension/src/overlay_coordinator.ts:172`.
- `hide()` keeps failed state when content script hide is not acknowledged: `packages/extension/src/overlay_coordinator.ts:266`.

Why it matters:

Overlay release is browser-visible cleanup. If it remains failed indefinitely, the system can avoid false idle, but the agent/user still needs a terminal next action: retry, tab-gone acknowledgement, manual cleanup, or forced stale marking.

Recommended fix:

Define a bounded release policy:

- Retry while tab is live and content script can be prepared.
- Mark `gone` when Chrome proves tab is gone.
- Escalate to `overlay_release_failed` diagnostic after N failures.
- Clear only through successful hide, tab-gone proof, explicit repair, or stop cleanup authority.

Acceptance tests:

- Repeated hide failure moves from pending to failed with bounded count.
- Failed release blocks idle/update reload.
- Explicit repair or tab-gone proof clears the state.

### GAP-9: Turn lifecycle is metadata, not a closed state space

Status:

Partial. Session and turn metadata are required in more places than before, but turn state is still represented by a mutable `currentTurnId` field and request metadata rather than a lifecycle protocol.

Evidence:

- `BrowserSession` stores `currentTurnId` as an independent string field, alongside optional active tab and control state: `packages/extension/src/session_store.ts:3`.
- Extension `markTurnEnded()` only checks that the session is not in human takeover and writes `currentTurnId`; it does not persist `ended`, `finalizing`, `failed`, or `partial` state: `packages/extension/src/browser_session_controller.ts:227`.
- Host dispatcher requires `session_id` and `turn_id` for mutating methods: `crates/obu-host/src/dispatcher.rs:1275`.
- Host CDP/WebExtension `turnEnded` routes touch session state and reject human takeover, but do not record a distinct turn terminal state: `crates/obu-host/src/backends/cdp/mod.rs:315` and `crates/obu-host/src/backends/webext/mod.rs:632`.
- SDK `finishTurn()` now avoids ending the turn after fatal finalization and requires opt-in for partial finalization, but the resulting `turnEnded` truth is returned to the immediate caller rather than becoming durable lifecycle state: `packages/sdk/src/browser.ts:320`.

Why it matters:

The product environment is turn-based for agents. If a turn is only a request metadata field, later diagnostics cannot prove whether the turn is open, yielded, finalizing, ended, ended-with-partial, or failed. That makes replay, repair, and RL-style episode accounting ambiguous.

Recommended fix:

Add a first-class turn lifecycle, either as its own session-scoped record or as a discriminated field inside session lifecycle:

```ts
type BrowserTurnLifecycle =
  | { kind: "open"; sessionId: string; turnId: string }
  | { kind: "yielded"; sessionId: string; turnId: string }
  | { kind: "finalizing"; sessionId: string; turnId: string }
  | { kind: "ended"; sessionId: string; turnId: string; finalization: "ok" }
  | { kind: "ended_partial"; sessionId: string; turnId: string; failures: unknown[] }
  | { kind: "failed"; sessionId: string; turnId: string; errorCode: string; diagnostics: unknown[] };
```

Acceptance tests:

- `turnEnded` persists an `ended` transition rather than only updating `currentTurnId`.
- Fatal finalization persists `failed` or `finalize_failed` turn state and does not publish `ended`.
- Partial finalization with explicit opt-in persists `ended_partial` and includes failures/diagnostics.
- Human takeover moves the active turn to `yielded`, and resume records a new actionable/open state or an explicit repair-blocked state.

### GAP-10: Browser-effect handles are not a closed public lifecycle

Status:

Partial. Host registry and extension controllers now have lifecycle events for file choosers, downloads, Playwright injection, and cleanup, but handle state is split between mutable maps, tombstones, optional fields, and notification queues.

Evidence:

- Host `FileChooserState` is an active row with tab id, owner session id, backend node id, and multiplicity, but has no explicit `pending | active | consumed | failed | stale | gone` state: `crates/obu-host/src/service_registry.rs:111`.
- Host `DownloadState` tracks `completed_path?: Option<String>`, but failed/canceled terminal states are not retained as a durable handle state: `crates/obu-host/src/service_registry.rs:130`.
- `take_file_chooser()` consumes the handle and records a stale consumed diagnostic, which is useful but conflates successful consumption with stale tombstone state: `crates/obu-host/src/service_registry.rs:803`.
- `mark_download_completed()` sets `completed_path` and records a completion event, while failed downloads surface as errors from waiters and are not stored as terminal failed handles: `crates/obu-host/src/service_registry.rs:889`.
- Extension download ownership is tracked in `ownersByUrl` and `ownersById` maps and removed on terminal Chrome download status, but the owner queue itself is not an agent-visible lifecycle state: `packages/extension/src/browser_download_controller.ts:35`.
- Extension download lifecycle recognizes only Chrome `complete` and `interrupted` as terminal status; pending/in-progress/canceled/unknown states collapse to `undefined`: `packages/extension/src/lifecycle/download_lifecycle_machine.ts:1`.
- Host method policy classifies `playwright_wait_for_file_chooser` as `current-origin` and `playwright_wait_for_download` as `download`, but dispatcher mutation taxonomy does not model handle-producing waiters as lifecycle-authority operations: `packages/sdk/src/wire/method-policy.ts:62` and `crates/obu-host/src/dispatcher.rs:1315`.
- Dispatcher-level mutation checks require `session_id` and `turn_id` only for methods classified by `requires_mutation_context()`, so handle-producing waiters can reach backend routing without the same top-level lifecycle authority proof as other browser-effect resources: `crates/obu-host/src/dispatcher.rs:1275`.
- WebExtension file-chooser waiting obtains session/turn proof indirectly through contextual CDP commands, but WebExtension download waiting reads `ctx.session_id` as an event filter and does not first call `require_session_context()`: `crates/obu-host/src/backends/webext/mod.rs:1298`, `crates/obu-host/src/backends/webext/mod.rs:1362`, and `crates/obu-host/src/backends/webext/mod.rs:1407`.
- CDP file-chooser and download waiters use the attached CDP session as the browser transport proof and may derive handle owner session from registry state when request metadata is absent, so CDP and WebExtension do not currently expose the same OBU session/turn authority contract for handle creation: `crates/obu-host/src/backends/cdp/playwright/mod.rs:250`, `crates/obu-host/src/backends/cdp/playwright/mod.rs:331`, and `crates/obu-host/src/backends/cdp/playwright/mod.rs:401`.

Why it matters:

File chooser and download handles are browser-effect resources. Agents need to know whether a handle is pending, usable, already consumed, completed, failed, canceled, stale because the tab disappeared, or unavailable because ownership was wrong. A stale tombstone helps after the fact, but it is not a complete public protocol for choosing the next action.

Recommended fix:

Introduce explicit handle lifecycle unions and align dispatcher method taxonomy plus backend implementation with handle creation/use:

```ts
type BrowserEffectHandleLifecycle =
  | { kind: "pending"; handleType: "file_chooser" | "download"; tabId: string; sessionId: string; turnId: string }
  | { kind: "active"; handleId: string; handleType: "file_chooser" | "download"; tabId: string; sessionId: string }
  | { kind: "consumed"; handleId: string; handleType: "file_chooser" }
  | { kind: "completed"; handleId: string; handleType: "download"; path?: string }
  | { kind: "failed"; handleId: string; handleType: "download"; errorCode: string; errorMessage: string }
  | { kind: "stale"; handleId: string; handleType: "file_chooser" | "download"; reason: string }
  | { kind: "gone"; handleId: string; handleType: "file_chooser" | "download"; tabId: string };
```

Acceptance tests:

- File chooser wait, consume, wrong-session use, wrong-tab use, timeout, and owner-tab removal each produce distinct handle lifecycle diagnostics.
- Download wait, completion, canceled/interrupted failure, explicit removal, owner-tab removal, and path lookup after terminal states each produce distinct lifecycle diagnostics.
- Handle-producing waiters are classified as lifecycle-authority operations at dispatcher level and fail before backend handle insertion when `session_id` or `turn_id` is missing.
- CDP and WebExtension handle waiters share the same public owner/session/turn proof contract, even if their transport-specific event correlation remains different internally.
- Public diagnostics expose active and stale handle counts plus recent handle terminal events with next action guidance.

### GAP-11: Extension update pending lifecycle has no terminal policy

Status:

Partial. Pending extension update is visible and blocked by browser-control activity, but the only persisted state is `waiting_for_idle`.

Evidence:

- `PendingExtensionUpdate` has only `state: "waiting_for_idle"` plus version and pending timestamp: `packages/extension/src/lifecycle/extension_update_machine.ts:4`.
- Activity snapshots block reload for active takeover, overlay pending, debugger attach locks, native pending requests, native hello/reconnect, active session tabs, and debugger attachments: `packages/extension/src/lifecycle/extension_update_machine.ts:96`.
- `planApplyPendingExtensionUpdate()` can only return `none`, `wait_for_idle`, or `reload`: `packages/extension/src/lifecycle/extension_update_machine.ts:112`.
- `maybeApplyPendingExtensionUpdate()` logs `waiting_for_idle`, publishes status, and then waits for future triggers; there is no timeout, escalation, acknowledgement, or blocked terminal state: `packages/extension/src/background.ts:1050`.
- Status publishes `pending_update` to the native host, but does not include age, blocking reason history, retry count, or required next action: `packages/extension/src/background.ts:1107`.

Why it matters:

Extension update is a lifecycle boundary for the browser environment itself. If activity never clears because another lifecycle is stuck, the runtime can remain in `waiting_for_idle` forever. That is safe against false reload, but not complete: agents and users need to know whether to wait, stop, repair an overlay/native/session blocker, or acknowledge a deferred update.

Recommended fix:

Expand pending update state into a small protocol:

```ts
type ExtensionUpdateLifecycle =
  | { kind: "none" }
  | { kind: "waiting_for_idle"; version?: string; pendingSince: number; reasons: BrowserControlActivityReason[] }
  | { kind: "blocked"; version?: string; pendingSince: number; reasons: BrowserControlActivityReason[]; nextAction: "repair_lifecycle" | "stop_control" | "manual_ack" }
  | { kind: "reloading"; version?: string }
  | { kind: "acknowledged_deferred"; version?: string; reason: string };
```

Acceptance tests:

- Pending update status includes blocking reasons and age.
- Persistent blockers such as overlay release failure, cleanup failure, native pending request, active session tab, and debugger attachment move update state to `blocked` or equivalent actionable diagnostic after a bounded threshold.
- Successful idle transition publishes `reloading` before `chrome.runtime.reload()`.
- Explicit user/agent acknowledgement can defer update without losing the pending version and reason.

### GAP-12: Agent runtime kernel lifecycle is not public diagnostics

Status:

Partial. Node REPL has an internal kernel lifecycle state, but browser status and agent-facing diagnostics focus on SDK bootstrap/backends rather than kernel lifecycle recovery.

Scope:

This is an agent-runtime or harness-environment lifecycle gap, not a direct browser side-effect authority gap. It belongs in this document because the product goal treats the JavaScript kernel, SDK runtime, browser backend, and extension as one verifiable agent environment.

Evidence:

- Node REPL `KernelState` is `Idle | Spawning | Ready | Executing | Restarting`: `crates/obu-node-repl/src/repl_manager/kernel_state.rs:7`.
- `JsRuntimeManager` stores the kernel state internally and starts at `Idle`: `crates/obu-node-repl/src/repl_manager/mod.rs:194`.
- `boot_locked()` moves `Idle/Spawning` to `Ready`, but spawn/ready failure is returned as an error rather than persisted as a public failed lifecycle state: `crates/obu-node-repl/src/repl_manager/mod.rs:266`.
- `exec_with_turn_id_and_progress_sink()` moves `Ready` to `Executing`, then back to `Ready` on success; on manager error it kills the kernel, resets the registry, and returns to `Idle`: `crates/obu-node-repl/src/repl_manager/mod.rs:383`.
- `browser_status()` reports SDK bootstrap, backends, descriptor diagnostics, hints, and advisories, but not kernel state, last restart/failure reason, or recovered generation: `crates/obu-node-repl/src/repl_manager/mod.rs:236`.

Why it matters:

For a harness-agent or RL-style environment, the JavaScript kernel is part of the environment state. If it restarts, loses bindings, drops displays, or kills an in-flight exec, the browser environment may still be recoverable, but the agent needs a stable diagnostic state rather than inferring recovery from an error and a later clean `browser_status`.

Recommended fix:

Expose a public agent-runtime lifecycle summary:

```ts
type AgentRuntimeKernelLifecycle =
  | { kind: "idle" }
  | { kind: "spawning" }
  | { kind: "ready"; generation: number }
  | { kind: "executing"; execId: string; turnId: string }
  | { kind: "restarting"; previousGeneration: number }
  | { kind: "failed"; stage: "spawn" | "ready" | "exec" | "restart"; errorMessage: string; recovered: boolean };
```

Acceptance tests:

- `browser_status()` or a dedicated runtime status method exposes current kernel lifecycle state and generation.
- Spawn/ready failure records `failed` with stage and message instead of only returning an error.
- Exec manager failure records `failed` then `idle`/`ready` recovery with a new generation and cleared registry.
- Kernel restart diagnostics do not collapse descriptor/backend browser-status failures with JavaScript runtime failures.

### GAP-13: Peer terminal diagnostics are incomplete on pre-dispatch paths

Status:

Partial. Host peer lifecycle has explicit auth, rejection, cancellation, and closed states, but not every peer path records a terminal close event.

Evidence:

- `PeerLifecycleState` includes `Rejected`, `Closing`, and `Closed`, and `PeerLifecycleEventKind` includes `PeerClosed`: `crates/obu-host/src/peer_lifecycle.rs:22` and `crates/obu-host/src/peer_lifecycle.rs:47`.
- `plan_peer_shutdown()` records `PeerClosed` and cancels pending work after the main read loop exits: `crates/obu-host/src/peer_lifecycle.rs:409` and `crates/obu-host/src/dispatcher.rs:213`.
- If the stream closes before any first frame is received, `serve_peer_with_max_in_flight()` returns `Ok(())` without recording a close diagnostic: `crates/obu-host/src/dispatcher.rs:155`.
- If capability-token auth rejects the first frame, or if auth is required but the first frame is not auth, the dispatcher sends an error response and returns before the shutdown plan runs: `crates/obu-host/src/dispatcher.rs:171` and `crates/obu-host/src/dispatcher.rs:175`.

Why it matters:

Peer lifecycle is the SDK-to-host transport boundary. For protocol completeness, rejected peers, empty peers, accepted peers that later close, and canceled in-flight requests all need terminal diagnostics. Without a terminal event on pre-dispatch paths, diagnostics can show a rejection reason but not prove whether the peer lifecycle reached a closed state or whether pending work was canceled.

Recommended fix:

Make peer closure a total lifecycle transition:

- Add a shutdown/terminal plan variant for pre-dispatch close and rejected-before-dispatch paths.
- Record `PeerClosed` or a more specific terminal event after every accepted, rejected, empty, and error first-frame outcome.
- Include rejection/close reason and whether request cancellation was needed.
- Keep request cancellation diagnostics separate from peer terminal diagnostics.

Acceptance tests:

- Empty peer connection records a terminal close diagnostic.
- Missing-auth and auth-mismatch peers record both rejection and terminal close diagnostics.
- Accepted peer normal close records `PeerClosed` after the read loop.
- In-flight request cancellation records request cancellation and peer terminal diagnostics without double-counting request failure as peer rejection.

## Completeness Audit Map

This pass treats the table below as the current exhaustiveness index for the CodeGraph-visible lifecycle/state-machine surfaces. A surface is either mapped to a gap above, marked covered by an existing gap, or explicitly called out as currently sufficient at this abstraction.

| Surface | CodeGraph evidence | Gap coverage |
| --- | --- | --- |
| Runtime descriptor setup/read/liveness | CLI `RuntimeDescriptorLifecycle`, host `RuntimeDescriptorState`, Node REPL `RuntimeDescriptorReadState`/`RuntimeDescriptorSetupState` | `GAP-6` |
| CLI verify sequence | `VerifySetupState` and `selectVerifyResultAndAction()` | No separate gap; current issue is descriptor vocabulary/next-action parity in `GAP-6` |
| Host peer auth/connection lifecycle | `PeerLifecycleState`, `PeerLifecycleEventKind`, peer diagnostics | `GAP-13`; peer auth states are explicit, but pre-dispatch close/rejection paths still need terminal diagnostics. Timeout/recovery concerns remain covered by `GAP-5` |
| Host registry session/tab lifecycle | `BrowserSessionRecord`, `RegistryLifecycleEventKind`, active-tab repair/reconcile planners | `GAP-1`, `GAP-2`, `GAP-9`, `GAP-10` |
| Host method policy and mutation taxonomy | `METHOD_POLICY_CLASSIFICATIONS`, `requires_mutation_context()`, `is_tab_mutating_method()` | `GAP-1` for read-shaped reconcile authority; `GAP-10` for handle-producing waiters |
| Extension browser session and tab ownership | `BrowserSession`, `SessionTab`, browser session planner, tab ownership planner | `GAP-2`, `GAP-7`, `GAP-9` |
| Extension finalization | `FinalizeTabsPlan`, `FinalizeTabOutcome`, `FinalizeTabFailure` | `GAP-3`, plus turn persistence in `GAP-9` |
| Extension native transport | `NativeHostState`, reconnect/restore planners, transport controller timers/booleans | `GAP-4` |
| Extension native request bridge | `NativeResponsePlan`, `PendingNativeRequest`, pending rejection planner | `GAP-5` |
| Host/SDK browser-effect timeout | Host native messaging late events, SDK `Transport` timeout behavior | `GAP-5` |
| Overlay takeover/release | `OverlayLifecycleState`, release request/result planners | `GAP-8` |
| Foreground observer | `ForegroundChangeReason`, foreground active-tab update planner | Covered by active-tab/session closure in `GAP-2`; direct foreground `activeTabId` mutation is one concrete `GAP-2` example |
| CDP input bypass/cursor visual state | `cdpInputBypassFromParams()`, `cdpCursorEventFromParams()` | Covered by overlay/command lifecycle in `GAP-8` and session commandability; no separate public state gap found |
| File chooser/download handles | `FileChooserState`, `DownloadState`, host registry handle planners, extension download owner queues | `GAP-10` |
| Playwright injected runtime handle/cache | `playwright_injected_tab_ids`, injected/cleared registry events | `GAP-10` |
| Debugger attachment | `attachedTabIds`, debugger attach lock, cleanup detach | `GAP-2` for session field closure; `GAP-10` for handle/attachment terminal diagnostics |
| Extension update | `PendingExtensionUpdate`, activity snapshot, apply/check planners | `GAP-11` |
| SDK commandability | `Tab`, nested tab surfaces, `Guards`, `METHOD_CLASSIFICATION` | Mostly complete; remaining structured recovery adoption is `GAP-7` |
| Node REPL kernel runtime | `KernelState`, `ExecRegistry`, `JsRuntimeManager` state transitions | `GAP-12` |

## Resource Coverage Snapshot

| Resource | Current coverage | Completeness |
| --- | --- | --- |
| Runtime descriptor | Planner and product mapping exist in CLI; Node REPL has parallel planner | Partial, close to complete if vocabulary parity is enforced |
| Native transport | Public connected/stopped/error states plus cleanup failure | Partial; hidden intermediate states remain |
| Host peer lifecycle | Auth, rejection, cancellation, and shutdown planners exist | Partial; some pre-dispatch close/rejection paths lack terminal close diagnostics |
| Browser session | Guards and repair planners exist | Partial; mutable record allows invalid combinations |
| Session tab | Extension planner/executor split improved; host registry validates active writes | Partial; host read paths still reconcile |
| Turn | Session/turn metadata is required for mutating methods | Partial; turn itself is not a first-class lifecycle |
| Overlay | Pending/failed release modeled and blocks idle | Partial; needs terminal policy |
| Browser effect request | Late host native timeout diagnostics exist; extension bridge tracks pending requests | Partial; no typed recovery action for agents yet, and extension bridge pending state is boolean/log-only |
| Browser-effect handles | Host registry records file chooser/download insert/consume/complete/stale events | Partial; handle state is split across maps/tombstones and not a closed public lifecycle, and handle-producing waiters lack one uniform session/turn authority contract across dispatcher and backends |
| Extension update | Pending update waits for idle and blocks reload during activity | Partial; no terminal blocked/escalated/acknowledged policy |
| Agent runtime kernel | Node REPL has internal `KernelState` and exec registry | Partial; public status does not expose failed/restarting/recovered kernel lifecycle |
| SDK tab commandability | Nested tab surfaces enforce commandability | Mostly complete for SDK object boundary |
| Finalization | Structured result and takeover guard exist | Partial; failure state not durable |

## Recommended Implementation Order

1. Close `GAP-1`: split host read observation from reconcile/repair. This is the highest-leverage fix because it aligns host with the extension-side query contract.
2. Close `GAP-3`: persist finalization partial/fatal diagnostics so episode boundaries remain truthful after the immediate response.
3. Close `GAP-5`: add timeout pending-reconcile state and agent next-action semantics.
4. Close `GAP-2`: introduce explicit session lifecycle state or persistent session diagnostics for invalid combinations.
5. Close `GAP-9`: make turn lifecycle durable and queryable enough for episode accounting.
6. Close `GAP-10`: close file chooser/download/debugger/injected-runtime handle lifecycle and align dispatcher/backend authority for handle-producing waiters.
7. Close `GAP-13`: make peer terminal diagnostics total for empty, rejected, accepted, and canceled peer paths.
8. Close `GAP-4`: add native `stopping` and other hidden transition states.
9. Close `GAP-6`: generate or test parity for descriptor lifecycle vocabulary.
10. Close `GAP-7`: adopt `resumeControlResult()` in runtime docs/help and recovery flows.
11. Close `GAP-8`: define overlay release retry/escalation/acknowledgement policy.
12. Close `GAP-11`: define extension update blocked/escalated/acknowledged states.
13. Close `GAP-12`: expose agent runtime kernel lifecycle diagnostics without conflating them with browser backend status.

## Acceptance Checklist For Future Passes

- Pure observe APIs are side-effect free at both extension and host layers; any read-shaped host reconcile path is explicitly typed as repair authority and returns applied effects.
- All state repair actions return applied effects and diagnostics.
- Session lifecycle exposes partial/fatal finalization after the original call.
- Public/persisted native transport state reports `stopping` during cleanup and only reports `stopped` after cleanup success.
- Timeout responses tell agents whether to retry or observe/reconcile first.
- Peer diagnostics include terminal close events for empty, rejected, accepted, and canceled peer paths.
- Runtime descriptor reason codes are parity-checked or explicitly documented as owner/applicability-scoped across CLI and Node REPL.
- Overlay release failures have a terminal, user/agent-actionable state.
- SDK examples and help use structured recovery states where recovery matters.
- Turn state is first-class enough to distinguish open, yielded, finalizing, ended, partial-ended, and failed turns across SDK/host/extension diagnostics.
- Browser-effect handles expose active, consumed/completed, failed, stale, and gone states with owner/session/turn proof; handle-producing waiters reject missing session/turn metadata before creating handle state.
- Extension update waiting has a bounded blocked/escalated/acknowledged policy and publishes blocking reasons.
- Agent runtime kernel status exposes spawn/ready/executing/restarting/failed/recovered lifecycle separately from browser backend descriptor status.
