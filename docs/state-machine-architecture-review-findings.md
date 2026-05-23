# State Machine Architecture Review Findings

Date: 2026-05-23

This document consolidates the CodeGraph-backed multi-agent architecture review of the current state-machine refactor. The review used one local synthesis pass plus eight focused subagent reviews across the CLI, Node REPL MCP runtime, SDK, Rust host, WebExtension controllers, lifecycle planners, transport boundaries, and tests.

The central product invariant is:

Agent code may compose freely at the SDK/runtime layer, but every browser-affecting state transition must pass through explicit local lifecycle machinery, host policy, ownership boundaries, and controller-owned side effects.

## Review Scope

- CLI verify setup and runtime descriptor lifecycle reporting.
- Node REPL `browser_status` and backend discovery diagnostics.
- SDK intent-language boundaries, including tab handles, `finishTurn`, and raw CDP escape hatches.
- Rust host dispatcher, method policy, service registry, native messaging, session/turn ownership, and diagnostics.
- WebExtension lifecycle machines, controllers, repositories, native transport, overlay state, finalization, and `background.ts` wiring.
- Test coverage for public summary/detail parity, lifecycle event payloads, stale/repair/cleanup paths, and cross-layer diagnostics.

## Executive Verdict

The refactor is directionally correct: pure planners and lifecycle controllers now exist in many important places. It is not yet a complete state-machine backbone because older mutation paths still coexist with the planners. The main gap is not API quantity; it is transition authority. Several paths can still mutate state, flatten diagnostics, or advance public lifecycle status without first proving ownership, policy, cleanup success, or planner consistency.

## Execution Status Update

This document is a historical review input, not the current source of truth by itself. The product goal remains the environment contract captured in `docs/agent-browser-environment-lifecycle-goal.md`: agents may compose freely, while real browser side effects must pass through local lifecycle authority, policy, ownership, and structured diagnostics.

Current pass status:

- Extension read paths no longer perform active-tab repair side effects. `getSessionTabs()` and `getCurrentSessionTab()` now observe via `planSessionActiveTabResolution()` and return/derive repair-required diagnostics without deleting rows, detaching debuggers, syncing groups, or persisting state.
- `resumeControl()` is now an action-shaped repair executor result. When repair leaves no active tab, the extension returns `{ tab: null, repair: { status: "blocked", reason: "no_active_tab", diagnostics, cleanup } }`; the SDK keeps the compatible `resumeControl()` tab/undefined API and adds `resumeControlResult()` for the structured state.
- Native messaging late-timeout diagnostics now have regression coverage for `timed_out_late_success`, `timed_out_late_error`, and `timed_out_late_transport_closed`.
- Broader findings in this document remain review findings unless they are explicitly marked closed by implementation and tests. Do not treat old prose below as superseding the goal doc or the current tests.

## Severity And Finding IDs

Finding IDs are stable handles for planning the follow-up refactor:

- `RD-*`: runtime descriptor, verify, setup, and browser-status lifecycle.
- `HOST-*`: Rust host, dispatcher, registry, transport, policy, and native messaging.
- `TURN-*`: turn boundary, finalization, handoff, and human takeover.
- `EXT-*`: WebExtension session, tab, overlay, and native transport lifecycle.
- `SDK-*`: SDK intent-language boundaries.
- `TEST-*`: acceptance and regression coverage.

Severity is scoped as follows:

- `P1`: correctness or trust-boundary gaps that can publish contradictory lifecycle state, choose an invalid repair action, mutate real browser state without the required ownership/policy proof, or mark a lifecycle terminal while cleanup may be incomplete.
- `P2`: observability, diagnostics, SDK-shaping, test coverage, or architecture-hardening gaps that make the state machines harder to trust, debug, or evolve, but do not by themselves prove an immediate incorrect browser side effect.

## Descriptor Lifecycle Boundary Map

The runtime descriptor area spans multiple state machines. Follow-up work should keep these boundaries separate:

| Boundary | Example states | Public repair family |
| --- | --- | --- |
| Runtime descriptor setup | directory missing, unreadable, unsafe permissions, no descriptor | `setup_missing` or setup repair |
| Runtime descriptor content | malformed JSON, unsupported schema/type, missing fields, unsafe socket metadata | `invalid_descriptor` or explicit invalid cleanup |
| Runtime descriptor liveness | dead process, probe failure, auth rejection, getInfo mismatch | `stale_descriptor` |
| Browser popup/session readiness | no installed/resumed extension session, wrong profile/browser/extension id | `browser_popup_boundary` or extension mismatch |

## P1 Findings

### P1 [RD-1]: Runtime descriptor public state can contradict lifecycle details

Original evidence:

- `packages/cli/src/runtime_descriptor_lifecycle.ts:38` classifies invalid descriptor shape and unsafe descriptor reasons as `invalid`.
- `packages/cli/src/verify.ts:1815` maps descriptor file validation failures to `productError: "stale_descriptor"`.
- `packages/cli/src/verify.ts:1857` maps unsupported schema versions to `productError: "stale_descriptor"`.
- `packages/cli/src/verify.ts:1837` and `packages/cli/src/verify.ts:1975` derive public component state from `productError === "stale_descriptor"`.
- `crates/obu-node-repl/src/repl_manager/mod.rs:980` maps any no-backend plus non-empty diagnostics case to `stale_descriptor`.
- `crates/obu-node-repl/src/repl_manager/mod.rs:1158` preserves descriptor diagnostics with `lifecycle_state` and `reason_code`.
- `crates/obu-node-repl/src/repl_manager/mod.rs:1193` classifies unsupported schema as invalid.

Symptom:

The same failed descriptor can expose `runtime_descriptor_lifecycle.state: "invalid"` while `browser.runtimeDescriptor`, `check.state`, or `browser_status.product_error.code` says `stale_descriptor`.

Architecture impact:

The public verify/status surface no longer has one stable lifecycle vocabulary. Agents and repair selection code can treat invalid descriptor shape as stale live-runtime state and choose the wrong remediation.

Recommended fix direction:

Make CLI probe state, aggregate runtime descriptor state, `browser_status.product_error`, and next action consume the lifecycle planner result directly. Add an explicit `invalid_descriptor` product code or equivalent invalid-but-repairable action if invalid descriptors should be machine-repairable. Reserve `stale_descriptor` for stale live-runtime reasons such as dead process, failed probe, auth rejection, or getInfo failure.

### P1 [RD-2]: Verify advertises repair for invalid descriptors that repair does not clean up

Evidence:

- `packages/cli/src/verify.ts:1815`, `packages/cli/src/verify.ts:1936`, and `packages/cli/src/verify.ts:1967` can classify invalid descriptor cases as `needs_repair`.
- `packages/cli/src/doctor-browser.ts:538`, `packages/cli/src/doctor-browser.ts:589`, and `packages/cli/src/doctor-browser.ts:638` skip or only narrowly handle malformed descriptor cleanup.

Symptom:

Invalid JSON, unsupported schema, unsupported type, missing `socketPath`, or missing `sdk_auth_token` can send the user through `verify -> repair -> verify` without changing state.

Architecture impact:

Next action is no longer executable for the lifecycle state it represents. This undermines the repair state machine because a terminal invalid input is presented as a stale runtime repair.

Recommended fix direction:

Either implement safe cleanup for repairable invalid descriptor files and report that cleanup explicitly, or stop advertising `run_repair` for invalid-shape states and return manual/browser-popup guidance. Add integration coverage for invalid JSON, unsupported schema, and missing socket path through `verify --repair`.

### P1 [RD-3]: Malformed JSON descriptor diagnostics lose lifecycle semantics

Evidence:

- `crates/obu-node-repl/src/repl_manager/mod.rs:1189` and `crates/obu-node-repl/src/repl_manager/mod.rs:1191` parse descriptor JSON.
- `crates/obu-node-repl/src/repl_manager/mod.rs:1167` and `crates/obu-node-repl/src/repl_manager/mod.rs:1172` push generic diagnostics with no lifecycle state or reason code on errors.

Symptom:

Malformed descriptor JSON can lose stable lifecycle state and reason-code semantics, then bubble up as `stale_descriptor` when no backend is usable.

Architecture impact:

The MCP runtime diverges from CLI verify behavior. Invalid descriptor files and stale runtime failures require different next actions, but the runtime status boundary collapses them.

Recommended fix direction:

Add typed issues such as `DescriptorJsonInvalid`; classify them as invalid descriptor states; and map them to invalid-descriptor product errors before stale descriptor fallback.

### P1 [HOST-1]: Host active-tab authority accepts unvalidated logical-active writes

Evidence:

- `crates/obu-host/src/service_registry.rs:339` exposes `set_active_tab`.
- `crates/obu-host/src/service_registry.rs:351` touches/creates a session and writes `session.active_tab_id` without proving the tab exists, is active, or belongs to the same session.
- `crates/obu-host/src/backends/webext/mod.rs:699` records active tab ids from request params.
- `crates/obu-host/src/backends/webext/mod.rs:908` validates only active status if a record exists; it does not prove same-session ownership.
- `crates/obu-host/src/backends/cdp/mod.rs:180` and `crates/obu-host/src/backends/cdp/mod.rs:320` set active tab state before backend execution.

Symptom:

A session can point at a missing tab, a tab owned by another session, or a tab whose command later fails.

Architecture impact:

The host registry is supposed to be the browser-state authority, but direct setters bypass the lifecycle and ownership proof. Cleanup then repairs only the tab's recorded owner, leaving the corrupted session to be repaired later by reads.

Recommended fix direction:

Split the API into a private unchecked primitive and a public validated transition. The validated path should require an existing same-session active tab, emit transition diagnostics only on meaningful changes, and be called after command authorization and success unless the event is explicitly modeled as a non-authoritative observation.

### P1 [HOST-2]: CDP backend can mutate browser state without session and turn ownership

Evidence:

- `crates/obu-host/src/dispatcher.rs:334` takes a session mutation lock only when `session_id` exists.
- `crates/obu-host/src/dispatcher.rs:1317` treats `session_id` and `turn_id` as optional request metadata.
- `crates/obu-host/src/backends/cdp/mod.rs:134`, `crates/obu-host/src/backends/cdp/mod.rs:173`, and `crates/obu-host/src/backends/cdp/mod.rs:191` proceed with optional session context for mutating operations.
- `crates/obu-host/src/backends/cdp/targets.rs:13` can register a created tab with `session_id: None`.

Symptom:

A caller can create, attach, execute CDP, or mutate tabs without session/turn ownership.

Architecture impact:

This bypasses session serialization and can leave host state that no lifecycle session owns. Finalize, cleanup, repair, and cross-session isolation become ambiguous.

Recommended fix direction:

Require `session_id` and `turn_id` at the dispatcher for all mutating methods before backend routing. Match the WebExtension session-context requirement. Add tests that missing session/turn fails before any backend side effect is issued.

### P1 [HOST-3]: Policy checks can mutate session state before authorization

Evidence:

- `crates/obu-host/src/dispatcher.rs:879` obtains the current URL for policy enforcement through the normal `TAB_URL` command path.
- `crates/obu-host/src/backends/webext/mod.rs:674` records session context before executing tab commands.
- `crates/obu-host/src/backends/webext/mod.rs:699` remembers active tab params on that path.
- `crates/obu-host/src/backends/cdp/mod.rs:303` uses the same active-tab write pattern before command execution.

Symptom:

A disallowed current-origin or raw-CDP command can still touch session timestamps and logical active-tab state before policy denial.

Architecture impact:

Authorization is no longer side-effect free. Diagnostics can imply accepted lifecycle activity even though policy blocked the command.

Recommended fix direction:

Add a side-effect-free backend URL probe for policy, such as `current_url_for_policy(ctx, tab_id)`, that does not touch sessions, set active tabs, attach, persist, or emit lifecycle events. Route `enforce_current_origin_policy` through that path.

### P1 [HOST-4]: Request timeout can report failure while browser side effects continue

Status update:

Late completion correlation is now implemented and covered for native messaging transport diagnostics. The remaining architectural question is broader deadline ownership across host, dispatcher, extension, and Chrome operations.

Original evidence:

- `crates/obu-host/src/dispatcher.rs:286` times out around `route_request` at `client_timeout_ms`.
- `crates/obu-host/src/native_messaging.rs:322` sends the WebExtension request first.
- `crates/obu-host/src/native_messaging.rs:316` waits `timeoutMs + 5000` at the native messaging layer.
- `crates/obu-host/src/native_messaging.rs:312` removes pending correlation when the outer future is dropped.
- `packages/extension/src/background.ts:496` continues executing `dispatchHostRequest`.
- `packages/extension/src/browser_debugger_controller.ts:105` rejects debugger timeout without cancelling the underlying Chrome command.

Symptom:

The SDK can receive a timeout and retry while the original create/click/CDP/navigation action later completes in the browser.

Architecture impact:

Timeout is treated as terminal even though the side effect may still be in flight. Late success or late failure becomes uncorrelated, so the lifecycle cannot explain what happened.

Recommended fix direction:

Use one deadline model owned by the host. For non-cancellable browser effects, keep pending correlation through late completion and emit diagnostics such as `timed_out_late_success` or `timed_out_late_error`. Do not return a clean final timeout unless cancellation or reconciliation has run.

### P1 [TURN-1]: Human takeover is not a hard ownership boundary for finalization

Evidence:

- `crates/obu-node-repl/resources/js_tool_description.md:69` instructs agents to use `yieldControl()` for human takeover and resume before issuing actions.
- `packages/extension/src/browser_session_controller.ts:210` sets `controlState = "human_takeover"`.
- `packages/extension/src/finalize_tabs_controller.ts:85` starts finalization without checking takeover state.
- `crates/obu-host/src/backends/webext/mod.rs:512` pre-closes agent tabs through `execute_cdp_with_context(..., "Page.close", ...)` before extension-side lifecycle acceptance.

Symptom:

An agent can call `browser.finishTurn()` or `browser.finalizeTabs()` after yielding and still close or release tabs while the human is supposed to own the session.

Architecture impact:

Human takeover is a trust boundary, but it is enforced only by prompt guidance and selected command guards. Finalization can bypass it.

Recommended fix direction:

Model takeover state in the host registry as well as the extension. Reject `finalizeTabs` while `human_takeover` is active except for a separately named explicit cleanup/stop path. Move host pre-close work behind that lifecycle acceptance check.

### P1 [TURN-2]: `finishTurn` can mark the turn ended after failed finalization

Evidence:

- `packages/sdk/src/browser.ts:287`, `packages/sdk/src/browser.ts:291`, and `packages/sdk/src/browser.ts:295` call finalization and then `turnEnded()`.
- `packages/extension/src/finalize_tabs_controller.ts:176` can return fatal finalization after reconciliation failure.

Symptom:

`finishTurn` advances the turn boundary even when finalization returns `fatal` or partial failure.

Architecture impact:

`turnEnded` stops meaning that the turn reached a coherent lifecycle boundary. Active or stale controlled tabs may remain while downstream code sees a completed turn.

Recommended fix direction:

Make `finishTurn` a discriminated lifecycle operation. Do not call `turnEnded` when finalization returns `fatal` or non-empty failures unless the caller explicitly opts into partial completion. Prefer throwing a `FinalizeTurnError` carrying the finalization result or returning `{ finalized, turnEnded: false }`.

### P1 [EXT-1]: `stopped` can be committed even when tab cleanup failed

Evidence:

- `packages/extension/src/native_transport_controller.ts:215` starts stop.
- `packages/extension/src/native_transport_controller.ts:236` unconditionally writes `Stopped by user` in `finally`.
- `packages/extension/src/tab_lifecycle_controller.ts:136` applies cleanup steps without per-step terminal failure states.
- `packages/extension/src/background.ts:775` can reject cleanup on native confirm/prompt dialog decisions.

Symptom:

Popup stop can leave active session tabs, managed groups, debugger state, or overlays alive while persisted status says stopped and reconnect is suppressed.

Architecture impact:

The native transport state machine can publish a terminal state that does not match browser-control cleanup reality.

Recommended fix direction:

Make stop cleanup return an explicit transition result such as `stopped`, `stop_blocked`, or `cleanup_failed`, with per-tab failures. Commit `stopped` only after cleanup succeeds. For dialog-blocked agent tabs, model action-time confirmation or downgrade to release-control instead of attempted close.

### P1 [EXT-2]: Tab removal can persist stale active-tab state

Evidence:

- `packages/extension/src/lifecycle/tab_ownership_machine.ts:97` plans deletion of active/finalized/debugger membership but has no active-tab clear or reselect field.
- `packages/extension/src/tab_lifecycle_controller.ts:55` applies tab removal.
- `packages/extension/src/tab_lifecycle_controller.ts:68` persists changed state.
- `packages/extension/src/session_store.ts:64` serializes `activeTabId`.

Symptom:

After a tab is removed, `session.activeTabId` can still point to a tab no longer present in `session.tabs`.

Architecture impact:

Persisted state can violate the invariant that active tab is undefined or points to an active owned row. Later reads rely on opportunistic resolver mutation to repair hidden stale state.

Recommended fix direction:

Extend `planTabRemoved` to return `nextActiveTabId` or `clearActiveTab`, computed from remaining active rows. Apply and persist that as part of removal, not during a later read.

## P2 Findings

### P2 [SDK-1]: High-level SDK evaluation hides raw CDP behind semantic APIs

Evidence:

- `packages/sdk/src/tab.ts:292` implements high-level tab evaluation.
- `packages/sdk/src/tab-dev.ts:19` routes through `dev.cdp("Runtime.evaluate", ...)`.
- `packages/sdk/src/wire/method-policy.ts:24` classifies raw CDP.
- `crates/obu-host/src/dispatcher.rs:859` enforces raw CDP policy.

Symptom:

Normal read-oriented SDK calls such as evaluation or snapshot text require raw-CDP permission.

Architecture impact:

CDP is no longer a clearly explicit escape hatch. It becomes hard to ban or audit raw CDP while still allowing safe semantic page reads.

Recommended fix direction:

Introduce semantic wire methods for evaluate/snapshot operations and classify them as constrained read/current-origin operations. Reserve `tab.dev.cdp(...)` for explicit raw-CDP escape.

### P2 [HOST-5]: Host reconciliation diagnostics drop the planned next active tab

Evidence:

- `crates/obu-host/src/registry_lifecycle.rs:177` returns `ReconcileSessionTabsPlan.next_active_tab_id`.
- `crates/obu-host/src/service_registry.rs:513` writes `session.active_tab_id = plan.next_active_tab_id`.
- `crates/obu-host/src/service_registry.rs:520` emits `plan_session_active_tab_reconciled(..., None, ...)`.

Symptom:

Runtime state is updated correctly, but the lifecycle event omits the tab id selected by the planner.

Architecture impact:

Diagnostics do not faithfully describe the executed transition. This weakens the pure planner as an executable contract.

Recommended fix direction:

Pass `plan.next_active_tab_id.clone()` into `plan_session_active_tab_reconciled`. Add a regression test for active `A` becoming stale while active `B` remains and verify the event payload includes `B`.

### P2 [HOST-6]: Direct host tab removal repairs active state without a reconcile event

Evidence:

- `crates/obu-host/src/service_registry.rs:248` clears handles before removal.
- `crates/obu-host/src/service_registry.rs:259` chooses a replacement active tab.
- `crates/obu-host/src/service_registry.rs:260` writes the replacement into `session.active_tab_id`.

Symptom:

Removing an active tab can change session active state but only records stale-tab and handle events.

Architecture impact:

The registry has multiple executor paths for the same logical active-tab transition, with different diagnostic coverage.

Recommended fix direction:

Route post-removal active repair through the same planner/event path as `current_tab_for_session`, or introduce a removal-specific plan that includes stale rows, handle cleanup, and `SessionActiveTabReconciled`.

### P2 [HOST-7]: No-op active-tab writes can flood bounded lifecycle diagnostics

Evidence:

- `crates/obu-host/src/service_registry.rs:351` and `crates/obu-host/src/service_registry.rs:354` write and record lifecycle events on every call.
- `crates/obu-host/src/registry_lifecycle.rs:596` defines active-tab set events.
- `crates/obu-host/src/backends/webext/mod.rs:660` and `crates/obu-host/src/backends/cdp/mod.rs:344` can call through repeatedly for command traffic.

Symptom:

Every tab command can record `SessionActiveTabSet` even when the session already points at that tab.

Architecture impact:

The lifecycle queue is bounded. Repeated no-op command traffic can evict the stale/repair/cleanup events needed to debug failures.

Recommended fix direction:

Make the active-tab transition compare previous and next values and emit only on meaningful changes, or emit no-op observations outside the lifecycle transition queue.

### P2 [EXT-3]: WebExtension active-tab resolver mutates state without explicit cleanup planning

Status update:

Closed for read-shaped extension tab queries in this implementation pass. `getSessionTabs()` and `getCurrentSessionTab()` now use the pure planner and avoid cleanup/persist side effects; action-shaped paths such as `resumeControl()` and browser command guards still use the named repair executor.

Current evidence:

- `packages/extension/src/browser_session_controller.ts:115` implements `getSessionTabs()` as a read path over `planSessionActiveTabResolution()`.
- `packages/extension/src/browser_session_controller.ts:143` implements `getCurrentSessionTab()` as a read path over the same planner.
- `packages/extension/src/browser_session_controller.ts:242` implements `resumeControl()` as an action path that applies repair and returns structured blocked repair state when no active tab remains.
- `packages/extension/src/browser_session_controller.ts:330` keeps the named repair executor as the mutation boundary for cleanup and active-tab update.

Original symptom:

A method shaped like a query mutated `session.tabs` and `session.activeTabId`, but returned only a tab id. The current read paths now expose repair-required diagnostics instead of applying cleanup.

Architecture impact:

Callers cannot consistently run dependent cleanup such as `removeManagedTab`, group mirror sync, download owner cleanup, attached debugger cleanup, overlay cleanup, prune, diagnostics, and persistence.

Recommended fix direction:

Replace the resolver with an explicit plan:

```ts
type ActiveTabResolutionPlan = {
  nextActiveTabId?: number;
  removedTabIds: number[];
  activeTabChanged: boolean;
  changed: boolean;
};
```

Apply this plan in one controller-owned cleanup executor.

### P2 [EXT-4]: Overlay release commits local state before browser-side release is proven

Evidence:

- `packages/extension/src/browser_session_controller.ts:213` sets `controlState = "human_takeover"`.
- `packages/extension/src/background.ts:818` hides takeover state.
- `packages/extension/src/overlay_coordinator.ts:221` deletes active takeover state before sending `OBU_CURSOR_HIDE`.
- `packages/extension/src/overlay_coordinator.ts:250` catches hide-send failures and returns `false`, but callers do not treat that as a pending release state.

Symptom:

A transient scripting failure can leave cursor/input lock state visible in the page while extension state believes no takeover is active.

Architecture impact:

Pending-update and activity checks may observe idle too early. Human takeover cleanup is best-effort rather than a lifecycle transition with proof.

Recommended fix direction:

Make overlay hide a planned transition with states such as `released`, `gone`, or `release_pending`. Keep retryable state until hide is acknowledged or tab removal confirms cleanup.

### P2 [HOST-8]: Host/extension RPC error detail is flattened

Evidence:

- `crates/obu-host/src/native_messaging.rs:337` preserves only `error.message`.
- `packages/extension/src/lifecycle/native_request_bridge_machine.ts:15` converts host errors to message-only errors.
- `packages/extension/src/native_host_bridge.ts:74` returns message-only errors.
- `packages/extension/src/background.ts:503` returns generic `-32000` with no structured data.
- `packages/sdk/src/wire/transport.ts:132` can preserve `error.data` if upstream layers keep it.

Symptom:

Policy denials, unsupported capability errors, dialog decisions, timeout details, and ownership errors lose structured codes/data across transport boundaries.

Architecture impact:

Repair selection and diagnostics cannot depend on stable machine-readable error details.

Recommended fix direction:

Introduce a structured RPC error type across extension and host transports preserving `{ code, message, data }`. Convert to local exception types only at the final edge.

### P2 [SDK-2]: SDK can still construct executable-looking tab handles for unowned tabs

Evidence:

- `packages/sdk/src/browser_user.ts:70` exposes deprecated `openTabs()` behavior.
- `packages/sdk/src/browser_tabs.ts:127` can create a `Tab` for an arbitrary id.
- `packages/sdk/src/tab.ts:162` methods do not consult `metadata.commandable`.

Symptom:

Agent code can express mutations against unclaimed or arbitrary tabs.

Architecture impact:

The host may reject the command, but the SDK intent language itself does not encode ownership. This weakens the product goal that the SDK is an intention language, not a thin Chrome handle wrapper.

Recommended fix direction:

Make unclaimed tabs explicit non-commandable refs until claimed. Remove or hard-deprecate `openTabs()` in favor of `discoverTabs()`. Require host validation before constructing a commandable `Tab`.

### P2 [RD-4]: Runtime descriptor setup states are outside the new lifecycle vocabulary

Evidence:

- `packages/cli/src/verify.ts:1748`, `packages/cli/src/verify.ts:1770`, and `packages/cli/src/verify.ts:1794` return descriptor directory and missing-descriptor states.
- `packages/cli/src/runtime_descriptor_lifecycle.ts:1` defines only fresh/stale/invalid descriptor lifecycle states.
- `crates/obu-node-repl/src/repl_manager/mod.rs:1124`, `crates/obu-node-repl/src/repl_manager/mod.rs:1129`, `crates/obu-node-repl/src/repl_manager/mod.rs:1135`, and `crates/obu-node-repl/src/repl_manager/mod.rs:1140` handle runtime root and descriptor directory validation failures as untyped diagnostics.

Symptom:

Directory missing, unreadable, invalid, permission failures, and no active descriptor found return legacy public fields or untyped diagnostics without a structured lifecycle detail object.

Architecture impact:

Consumers still need to special-case legacy fields where the refactor intends to provide lifecycle vocabulary.

Recommended fix direction:

Model descriptor setup states explicitly, either by expanding descriptor lifecycle detail with `missing`, `unreadable`, `dir_invalid`, and `no_descriptor`, or by adding a separate `runtime_descriptor_setup_lifecycle`. Map setup failures to setup repair guidance before invalid-descriptor or stale-descriptor fallback.

### P2 [TEST-1]: Peer lifecycle diagnostics lack cross-layer acceptance coverage

Evidence:

- `crates/obu-host/src/main.rs:45` and `crates/obu-host/src/main.rs:56` wire peer lifecycle diagnostics.
- `crates/obu-host/src/dispatcher.rs:908` and `crates/obu-host/src/dispatcher.rs:928` expose diagnostics through metadata.
- `crates/obu-host/tests/dispatcher_routing.rs:83` and `crates/obu-host/tests/peer_auth_unix.rs:19` cover only pieces of the path.

Symptom:

Tests cover peer planner units and dispatcher first-frame behavior, but not preservation of OS credential events into public `getInfo` metadata.

Architecture impact:

Cross-layer diagnostic preservation is unproven for one of the host's trust-boundary state machines.

Recommended fix direction:

Add an integration-style host test using shared `PeerLifecycleDiagnostics`, `UnixPeerAuthGate::new_with_diagnostics`, and `Dispatcher::new_with_policy_and_peer_diagnostics`; assert `getInfo.metadata.diagnostics.peer.recent_events` contains OS credential and first-frame events, including rejection diagnostics.

## Test Coverage Findings

The new planner tests are useful but not sufficient. The missing tests are mostly public parity and executor-event tests:

- `RD-1`, `RD-2`, `RD-3`: CLI `verify --json` should cover invalid descriptor shape and assert `check.state`, product error, next action, and lifecycle detail agree.
- `RD-1`, `RD-3`, `RD-4`: Node REPL `browser_status` should cover invalid descriptor diagnostics and setup diagnostics, not only `discoverBackendDiagnostics()`.
- `HOST-5`, `HOST-6`, `HOST-7`: Host registry tests should assert lifecycle event payloads for active-tab reconciliation, direct removal, and no-op suppression, not only final runtime state.
- `EXT-2`, `EXT-3`: WebExtension controller tests should cover gone active tabs through `getCurrentSessionTab`, `resumeControl`, `requireCurrentSessionTabForBrowserCommand`, tab removal, and restore.
- `TURN-1`, `TURN-2`: SDK lifecycle tests should cover `yieldControl(); finishTurn(...)` and finalization fatal/partial behavior.
- `HOST-8`: Transport tests should assert structured RPC error data survives native messaging round trips.

## Generalized Failure Pattern

The sibling findings share six root causes:

1. Public summary fields are still derived from older coarse product errors instead of planner states.
2. Some executor paths apply planner decisions but reconstruct diagnostic events manually, losing planner fields.
3. Resolver/query methods still mutate state, so callers cannot consistently run cleanup, diagnostics, and persistence.
4. Policy probes and timeout boundaries are treated as if they were side-effect free or terminal even when browser side effects may still happen.
5. SDK objects sometimes represent raw or unowned browser capabilities as normal commandable handles.
6. Tests often assert final state, but not the public lifecycle summary/detail parity or emitted lifecycle event payloads.

## Architecture Rules To Enforce

- One lifecycle transition must have one source of truth for state, reason code, public summary, next action, and diagnostics.
- Public product errors may summarize lifecycle states, but must not contradict them.
- Authorization and policy reads must be side-effect free unless the side effect is explicitly represented as a lifecycle event.
- Mutating browser operations must require session and turn ownership before backend routing.
- Executor code should consume planner output instead of rebuilding equivalent events by hand.
- Methods that mutate session, tab, debugger, download, overlay, or group state must return an explicit changed/cleanup plan or be named and treated as mutators.
- Resolver and query methods should not delete, persist, detach, release, or otherwise clean up state unless that behavior is encoded in their return type and tests.
- Timeouts must either cancel the side effect, reconcile it, or preserve late completion diagnostics.
- Human takeover is an ownership boundary, not prompt guidance.
- SDK tab objects should encode commandability and ownership; unclaimed refs should not expose normal tab mutation APIs.
- Tests should assert both runtime state and lifecycle diagnostics for every non-trivial state transition.

## Suggested Fix Order

1. Align runtime descriptor lifecycle/product-error mapping in CLI and Node REPL, including invalid JSON and setup diagnostics. Covers `RD-1`, `RD-2`, `RD-3`, and `RD-4`.
2. Require session/turn ownership for all mutating host paths and replace unchecked active-tab writes with validated transitions. Covers `HOST-1` and `HOST-2`.
3. Make policy probes side-effect free and preserve structured RPC error data across host/extension boundaries. Covers `HOST-3` and `HOST-8`.
4. Fix timeout lifecycle semantics so late browser effects are cancellable, correlated, or reconciled. Covers `HOST-4`.
5. Enforce human takeover and finalization/turn-ended semantics as explicit lifecycle transitions. Covers `TURN-1` and `TURN-2`.
6. Fix extension stop, tab removal, overlay release, and active-tab resolution so cleanup is planned and persisted in one executor path. Covers `EXT-1`, `EXT-2`, `EXT-3`, and `EXT-4`.
7. Separate semantic SDK read operations from explicit raw CDP escape hatches and make unowned tab refs non-commandable. Covers `SDK-1` and `SDK-2`.
8. Make host registry diagnostics planner-derived and bounded by meaningful transitions. Covers `HOST-5`, `HOST-6`, and `HOST-7`.
9. Add regression tests that assert public summary/detail parity, lifecycle event payloads, stale/repair/cleanup paths, and cross-layer diagnostics. Covers `TEST-1` plus the test bullets above.
