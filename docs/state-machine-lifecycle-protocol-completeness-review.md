# State Machine Lifecycle Protocol Completeness Review

Date: 2026-05-23

This document reviews the current state-machine state space and lifecycle protocol integrity of `open-browser-use`. It focuses on the core product invariant:

> The agent may compose freely in the SDK and JavaScript runtime, but every real browser side effect must pass through explicit local lifecycle machinery, host policy, session/turn ownership, and Chrome extension control boundaries.

The review is CodeGraph-backed. The checked index contained 290 files, 6,848 symbols, and 18,185 edges. The goal is not to re-list every API, but to determine whether each resource has a complete protocol for creation, use, pause/yield, resume, release/finalize, stale repair, and cleanup.

## Executive Verdict

The current refactor is directionally correct, but it is not yet a complete state-machine backbone.

Several important areas now have pure planners or lifecycle-shaped controllers: native transport, finalization, extension update, runtime descriptor lifecycle, host registry active-tab repair, browser session cleanup, and tab ownership. However, many older mutation paths still coexist with those planners. The result is broad but shallow state-space coverage: the code often has state labels, but the lifecycle protocol is not closed across SDK, host, extension, and Chrome.

The weakest areas are:

- Session and tab ownership as a cross-layer authority.
- Human takeover as a hard boundary.
- Turn finalization semantics.
- Active-tab repair and stale cleanup.
- Stop/cleanup terminal states.
- Overlay release proof.
- Timeout and late side-effect correlation.
- Structured diagnostics across host/extension/native messaging.

The architectural issue is transition authority. Today, some resources are created and used through controlled flows, but release, stale repair, and failure paths can be opportunistic, best-effort, or query-driven. A mature lifecycle backbone should make every browser-affecting transition pass through one planner/executor path with explicit state, effects, diagnostics, and cleanup obligations.

## Execution Status Update

This review is an input to the lifecycle goal doc, not the only truth. The product goal is to make open-browser-use a verifiable browser environment runtime for agents: actions have explicit authority and preconditions, observations do not secretly mutate lifecycle state, terminal states do not hide late effects or cleanup gaps, and failures are structured enough for an agent to choose a next action.

Current pass status:

- Query-shaped extension methods now observe active-tab repair without applying it. `getSessionTabs()` returns a `repair_required` plan when it sees stale session rows, and `getCurrentSessionTab()` derives the logical active tab from the pure plan without deleting rows or persisting state.
- `resumeControl()` now returns a first-class blocked repair result when no active tab can be restored: `{ tab: null, repair: { status: "blocked", reason: "no_active_tab", diagnostics, cleanup } }`. SDK callers that need this state can use `browser.resumeControlResult()`; existing `browser.resumeControl()` remains backward compatible.
- Native messaging late-timeout diagnostics have regression coverage for late success, late structured error, and late transport close.
- The matrix below remains useful as a review map, but rows that discuss query-driven active-tab repair or null-only resume failure should be read as historical unless updated in this section.

## Completeness Criteria

A resource lifecycle is considered protocol-complete only if it answers all of these questions:

1. Creation: who creates the resource, under which session/turn, and what ownership proof is recorded?
2. Use: which methods may use it, and what state/ownership/policy checks are mandatory before side effects?
3. Pause or yield: how is control suspended, and what operations are forbidden while suspended?
4. Resume: how is control recovered, and what stale state must be reconciled before use resumes?
5. Release or finalize: how are browser-visible effects, extension bookkeeping, host registry rows, overlays, debuggers, downloads, and groups released?
6. Failure: which failed/pending/blocked states are first-class, rather than hidden in logs or best-effort catches?
7. Repair: which stale states are repairable, and which component owns the repair transition?
8. Diagnostics: does the public status describe the same transition that was actually executed?

By this standard, several current machines are useful building blocks but not yet complete protocols.

## Protocol Completeness Rubric

The rest of this review uses a mechanical coverage rubric instead of a single subjective completeness score:

| Mark | Meaning |
| --- | --- |
| `complete` | The phase has an explicit state, guard, executor, failure path, and diagnostic contract. |
| `partial` | The phase exists, but some ownership, cleanup, failure, or diagnostic obligations are implicit or split across layers. |
| `missing` | The phase is absent, represented only by prompt discipline, or represented only by incidental fields/logs. |
| `not_applicable` | The phase does not apply to this resource. |

For this product, a lifecycle row is not complete unless allocation, ownership proof, use guard, pause/yield, resume/repair, release/finalize, failure terminal, and diagnostics all agree across SDK, host, extension, and Chrome-side execution.

## Resource Lifecycle Matrix

This matrix separates allocation from ownership proof. Allocation means a record or object exists. Ownership proof means the resource has been accepted into a session/turn/capability boundary and may safely drive browser side effects.

| Resource | Allocation or creation | Ownership or commandability proof | Use guard | Pause or yield | Resume or repair | Release or finalize | Failure terminal and diagnostics | Coverage summary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Runtime descriptor | Host publishes descriptor; CLI/Node REPL discover descriptor files | Descriptor auth token, socket path, schema, browser kind, extension id, and getInfo checks | CLI verify and Node REPL discovery probe descriptor before SDK bootstrap | `not_applicable` | Fresh/stale/invalid summaries exist, plus host drop lifecycle | Host can drop descriptor; doctor/verify can repair some stale diagnostics | Invalid setup, invalid descriptor, and stale runtime reasons are not one shared vocabulary | create `partial`; use `partial`; repair `partial`; diagnostics `partial` |
| Native transport | Extension `connect()` opens native port and sends hello | Connected port plus hello ack and version compatibility | Native bridge only sends when a current port exists; heartbeat checks liveness | `stop()` sets stopping/stopped and suppresses reconnect | `resume()` clears stopping and reconnects | Stop calls host stop, extension cleanup, port disconnect, pending rejection | `stopped` can be committed before cleanup success; cleanup failures are not terminal states | create `partial`; use `partial`; pause `partial`; resume `partial`; release `partial`; failure `missing` |
| Browser session | `sessionFor()` lazily allocates; create/claim flows attach tabs | Session id, turn id, active session tab row, and non-takeover control state | `requireSessionTab()` checks active row and local takeover state | `yieldControl()` marks `human_takeover` and hides overlay | `resumeControl()` resolves active tab, clears takeover, activates overlay | Cleanup/finalize/prune paths release tabs and sessions | Session is a mutable record, not a discriminated lifecycle; host does not model takeover | create `partial`; ownership `partial`; pause `partial`; resume `partial`; release `partial`; failure `missing` |
| Session tab | `createSessionTab()`, `claimUserTab()`, restore durable tab | `origin`, `status`, session membership, active row, managed group membership | Active tab commands require `status === "active"` in extension and host registry repair on read | Handoff/deliverable model non-commandable retention, but not full pause | Active-tab resolver and restore can repair some stale rows | Finalize closes agent tabs, releases user tabs, or keeps handoff/deliverable | Tab removal can leave stale `activeTabId`; resolver mutates hidden state | create `partial`; ownership `partial`; use `partial`; repair `partial`; release `partial`; failure `partial` |
| Turn | SDK injects `session_id` and `turn_id` through `withSessionMeta()` | Dispatcher/extension receive turn metadata, but not all mutating paths require it | Requests carry turn metadata; some host paths still accept optional session/turn | Human yield exists at session level, not as turn state | Resume starts another actionable phase, but turn state is not repaired | `finishTurn()` calls finalize then `turnEnded()` | Fatal/partial finalization can still allow turn-end semantics | create `partial`; use `partial`; pause `missing`; resume `missing`; release `partial`; failure `missing` |
| Overlay takeover | `OverlayCoordinator.activate()` records active takeover and sends content state | Active takeover has tab id, session id, turn id, cursor state | Cursor/input flows send content messages and can track waiters | `hide()` is used for yield/cleanup | `reassert()` and replacement can restore foreground overlay | `hide()` and tab removal forget overlay | Hide deletes local state before browser-side release is proven; no `release_pending` | create `partial`; use `partial`; pause `partial`; resume `partial`; release `partial`; failure `missing` |
| Debugger attachment | Browser debugger controller attaches and session tracks `attachedTabIds` | Attached set plus tab/session ownership | CDP/input/screenshot flows require active session tab or debugger lock | Cleanup attempts detach during stop/finalize | Tab replacement/removal updates attached rows | Cleanup detaches or drops attached ids | Detach races are ignored during cleanup; failure does not become lifecycle state | create `partial`; use `partial`; repair `partial`; release `partial`; failure `missing` |
| Download ownership | SDK waits for download; extension queues owner; host registry has download handles | Owner queue maps URL/id to session/tab; host handle has owner session when known | Download guard classifies download methods; notifications include session/source | `not_applicable` | Owners are removed on tab removal; completed/failed downloads clear owner | Complete/failed or owner removal releases ownership | Download lifecycle is not transactionally tied to tab/session terminal cleanup | create `partial`; ownership `partial`; use `partial`; repair `partial`; release `partial`; failure `partial` |
| File chooser handle | SDK `waitForEvent("filechooser")`; host inserts `FileChooserState` | Host state records tab id, owner session id, backend node id, multiple flag | `setFiles()` runs upload guard and consumes handle | `not_applicable` | Missing handles can be described through stale diagnostics | `take_file_chooser()` consumes handle and records stale consumed state | Consumed handle becomes stale diagnostic, but timeout/cancel/owner-tab-gone lifecycle is incomplete | create `partial`; ownership `partial`; use `partial`; release `partial`; failure `partial` |
| Managed tab/group | `TabGroupManager.ensureSessionGroup()` and deliverable-group moves | Group kind, session id, tab origin/status, persisted group index | Group reconciliation preserves title/color/collapse state | `not_applicable` | `reconcileGroup()` deletes missing groups; restore rebuilds durable tabs | `removeManagedTab()`, `releaseManagedTab()`, deliverable moves update groups | Group disappearance is repaired, but not part of a session/tab transition transaction | create `partial`; use `partial`; repair `partial`; release `partial`; diagnostics `partial` |
| Capability and method policy | SDK `Guards` classify commands; host dispatcher enforces policy | Method classification, current URL, raw CDP/download/upload checks, capability support | `ensureCommandAllowed()` and dispatcher policy gates requests | `not_applicable` | Capability unsupported paths return errors | Policy does not release resources | Some policy probes can use normal command paths and mutate state before denial | create `not_applicable`; use `partial`; failure `partial`; diagnostics `partial` |
| Foreground observation | `ForegroundObserver` listens to focus/active tab changes | `findSessionForTab()` proves observed tab belongs to a session | Foreground changes can update logical active tab | Window focus changes sync foreground overlay visibility | Active foreground tab can repair logical active selection | `not_applicable` | Foreground updates mutate `activeTabId` directly without full active-tab repair cleanup | create `not_applicable`; use `partial`; repair `partial`; diagnostics `partial` |
| Browser effect request | SDK `Transport.sendRequest()` allocates pending request id; extension/native bridges allocate pending ids | Pending map plus connection/port correlation | Defensive timeout, native bridge pending map, host request timeout | `not_applicable` | No full late-completion reconciliation state | Pending requests are rejected on close/stop; individual browser effects may continue | Timeout can be terminal at SDK while Chrome side effect continues | create `partial`; use `partial`; repair `missing`; release `partial`; failure `missing` |
| Extension update | `handleUpdateAvailable()` creates pending update | Pending update plus activity snapshot controls reload decision | `planApplyPendingExtensionUpdate()` waits for idle or reloads | `waiting_for_idle` gates reload while browser-control activity exists | Scheduled checks retry when activity changes | `chrome.runtime.reload()` applies update | Depends on lower lifecycle signals; false idle is possible if release states are missing | create `complete`; use `partial`; pause `partial`; resume `partial`; release `complete`; failure `partial` |
| Host registry tab/session | Backend register/update/remove create host records | Tab record session id/status, session active tab, handle owner session | Current tab repair planner and dispatcher policy consult registry | Stale records model removed/invalidated resources | Active-tab repair and reconcile planners select next active tab | Clear handles, mark stale, remove records | Public setter can write invalid active tab; some diagnostics omit planner details | create `partial`; ownership `partial`; use `partial`; repair `partial`; release `partial`; diagnostics `partial` |

## Core Transition Closure

State-space completeness requires more than listing states. The key question is whether every important event has a legal transition, guard, executor, and failure state. The tables below show the current intended closure and the gaps that prevent it from being a complete protocol.

### Browser Session Transition Closure

| From | Event | Required guard | Intended next state | Current executor | Failure or gap |
| --- | --- | --- | --- | --- | --- |
| `empty` or implicit session | create agent tab | session id and turn id present; session not yielded | `active` with active agent tab | `BrowserSessionController.createSessionTab()` | Session allocation and ownership acquisition are conflated through `sessionFor()` |
| `empty` or implicit session | claim user tab | tab is claimable and not owned by another session | `active` with claimed user tab | `BrowserSessionController.claimUserTab()` | Host-level ownership state is not the authoritative guard |
| `active` | tab command | active session tab; not `human_takeover` | `active` with updated active tab | `requireSessionTab()` | Guard is local to selected extension paths |
| `active` | yield control | session has current turn | `human_takeover` | `yieldControl()` | Host registry does not model takeover |
| `human_takeover` | resume control | active tab can be resolved and is still commandable | `active` or structured blocked repair | `resumeControl()` | Current action path applies repair and returns typed blocked state when no active tab remains |
| `human_takeover` | finalize tabs | explicit cleanup mode or user-approved cleanup | blocked or cleanup-specific state | None | Current finalization can bypass takeover |
| `active` | finalize tabs | finalize plan accepted; no takeover | `finalizing` then `finalized` or failed | `FinalizeTabsController.finalizeTabs()` | No session-level `finalizing` or `finalize_failed` state |
| any active-ish state | stop/unavailable cleanup | cleanup plan accepted | `cleanup` then empty/stale/failed | `TabLifecycleController.cleanupAllSessionTabs()` | Cleanup failure can be hidden by native transport `stopped` |

### Session Tab Transition Closure

| From | Event | Required guard | Intended next state | Current executor | Failure or gap |
| --- | --- | --- | --- | --- | --- |
| absent | create tab | Chrome tab created with id; session accepts action | `active(agent)` | `createSessionTab()` | Host registry may learn state through later backend paths |
| absent | claim tab | Chrome tab is claimable and not cross-session owned | `active(user)` | `claimUserTab()` | SDK can still expose deprecated commandable-looking open tabs |
| `active` | command | row exists, status active, not yielded | `active` | `requireSessionTab()` and backend command path | Host `set_active_tab()` can write invalid logical active ids |
| `active` | foreground observation | observed tab belongs to session | `active` with logical active tab changed | `ForegroundObserver.handleForegroundTabChanged()` | Updates `activeTabId` without full active-tab cleanup plan |
| `active` | tab removed | row exists in session | `gone` then repaired active selection | `TabLifecycleController.handleTabRemoved()` | Removal does not clear/reselect `activeTabId` |
| `active` | finalize close/release | finalize plan accepted | `closing` or `releasing`, then absent/released | `FinalizeTabsController.finalizeTabs()` | Intermediate states are not represented |
| `active` | keep handoff/deliverable | keep request is valid | `handoff` or `deliverable` | `FinalizeTabsController.finalizeTabs()` | Handoff remains in `session.tabs`; deliverable moves to `finalizedTabs`, but session-level terminal state is not explicit |
| any | resolver sees gone tab | Chrome reports tab gone | `gone` plus cleanup obligations | `resolveSessionActiveTabId()` | Query-shaped method deletes rows without returning cleanup/diagnostics plan |

### Turn Transition Closure

| From | Event | Required guard | Intended next state | Current executor | Failure or gap |
| --- | --- | --- | --- | --- | --- |
| absent | SDK request begins | session id and turn id are present for mutating methods | `open` | `withSessionMeta()` plus dispatcher/session params | Some backend paths accept optional metadata |
| `open` | browser command | policy and ownership allow command | `open` | SDK guards, host dispatcher, extension controllers | Policy probes can mutate state before denial |
| `open` | yield control | session active | `yielded` | `yieldControl()` | Yield is modeled on session, not turn |
| `yielded` | resume control | repair succeeds | `open` or new turn-open state | `resumeControl()` | No explicit turn resume state |
| `open` | finish turn | finalization succeeds | `ended` | `Browser.finishTurn()` | `finishTurn()` can call `turnEnded()` after partial/fatal finalization |
| `open` | finalization fails | fatal/partial result | `finalize_failed` or `finalize_partial` | `FinalizeTabsController` returns result | SDK result does not encode `turnEnded: false` |

### Native Transport Transition Closure

| From | Event | Required guard | Intended next state | Current executor | Failure or gap |
| --- | --- | --- | --- | --- | --- |
| `disconnected` | connect | not stopping; not already connected | `connecting` then `hello_pending` | `NativeTransportController.connect()` | `hello_pending` is represented by timer/port fields, not state |
| `hello_pending` | hello ack | version compatible | `connected` | native message handler | State exists only as `connecting` plus timer |
| `connected` | heartbeat timeout | heartbeat request fails | `disconnected` or reconnecting, with unavailable cleanup | heartbeat failure handler | Active takeover release is best-effort cleanup |
| `connected` | stop | stop requested by user | `stopping` | `stop()` | `stopping` is boolean, not public lifecycle state |
| `stopping` | cleanup succeeds | all controlled resources released | `stopped` | `stop()` finally block | Success is not distinguished from cleanup failure |
| `stopping` | cleanup blocked/fails | per-resource failures recorded | `stop_blocked` or `cleanup_failed` | None | Current code can still publish `stopped` |
| `stopped` | resume | user resumes control | `disconnected` then connect flow | `resume()` | Resume does not reconcile prior cleanup failures |

### Overlay Transition Closure

| From | Event | Required guard | Intended next state | Current executor | Failure or gap |
| --- | --- | --- | --- | --- | --- |
| `inactive` | activate | tab id, session id, turn id | `active` | `OverlayCoordinator.activate()` | Activation planner exists |
| `active` | cursor move | tab visible and content script available | `active` with cursor updated | `moveMouse()` | Send failure returns visible false but no lifecycle state |
| `active` | yield/cleanup hide | content script hide acknowledged or tab gone | `released` or `gone` | `hide()` | Local state is deleted before browser-side release proof |
| `active` | tab replaced | replacement state exists | `active` on new tab or `inactive` | `replaceTabId()` | Replacement planner exists but no release failure state |
| `release_pending` | retry succeeds | content script accepts hide | `released` | None | State does not exist |
| `release_pending` | tab removed | Chrome reports gone | `gone` | `forget()` on removal | Removal path can forget, but not as explicit transition |

### Host Registry Transition Closure

| From | Event | Required guard | Intended next state | Current executor | Failure or gap |
| --- | --- | --- | --- | --- | --- |
| absent tab | backend registers tab | id, backend, optional session context | active or discovered tab record | backend registry insertion | CDP paths can register without session owner |
| active session tab | set logical active | tab exists, same session, status active | session active tab set | `ServiceRegistry.set_active_tab()` | Public setter is unchecked |
| active session tab | tab disappears | backend reconciliation observes absence | stale tab plus active repair | `plan_reconcile_session_tabs()` | Some events omit planner-selected next active id |
| handle active | file chooser consumed | handle exists | stale consumed handle diagnostic | `take_file_chooser()` | Timeout/cancel/tab-gone states are not complete |
| request active | timeout | browser effect still in flight or cancelled | timed-out pending reconcile or cancelled | dispatcher/transport timeout paths | Late side effects are not correlated |

## Current State Spaces

### Runtime Descriptor

Evidence:

- `packages/cli/src/runtime_descriptor_lifecycle.ts:1` defines `fresh | stale | invalid`.
- `crates/obu-host/src/runtime_descriptor_lifecycle.rs:9` models host publish/drop as `Absent | Fresh | Dropped`.
- `packages/cli/src/verify_setup_machine.ts:1` models setup/verify phases as a separate state sequence.

Assessment:

The descriptor lifecycle is partly explicit. The read-side lifecycle distinguishes fresh, stale, and invalid. The host-side lifecycle distinguishes absent, fresh, and dropped. The verify setup flow also has a proper sequential machine.

The incompleteness is boundary fragmentation. Descriptor setup states such as missing directory, unreadable directory, no descriptor, invalid permissions, malformed JSON, unsupported schema, and dead runtime are not represented by one shared lifecycle vocabulary. Some are setup failures, some are invalid descriptor failures, and some are stale runtime failures.

Required mature state space:

```ts
type RuntimeDescriptorLifecycle =
  | { kind: "setup_missing"; reason: SetupReason }
  | { kind: "descriptor_invalid"; reason: InvalidDescriptorReason }
  | { kind: "runtime_stale"; reason: StaleRuntimeReason }
  | { kind: "fresh"; descriptorId: string }
  | { kind: "dropped"; reason: string };
```

Protocol gap:

Repair selection should consume this state directly. Public product errors may summarize it, but must not contradict the lifecycle detail.

### Native Transport

Evidence:

- `packages/extension/src/lifecycle/native_transport_machine.ts:1` defines `disconnected | connecting | connected | version_mismatch | stopped | error`.
- `packages/extension/src/native_transport_controller.ts:140` implements `connect()`.
- `packages/extension/src/native_transport_controller.ts:215` implements `stop()`.
- `packages/extension/src/native_transport_controller.ts:241` implements `resume()`.

Assessment:

The native transport has a recognizable state machine, but the state space is missing cleanup and transition-in-progress states. `stop()` sets `stopping = true`, clears timers, writes a stopped-like status, runs stop/cleanup, and then unconditionally writes `Stopped by user` in `finally`.

This means `stopped` can be published even if browser-control cleanup failed. From a lifecycle perspective, `stopped` should mean no active browser-control resources remain, not merely that reconnect is suppressed.

Required mature state space:

```ts
type NativeTransportState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "hello_pending"; portId: string; deadlineMs: number }
  | { kind: "connected"; hostVersion: string }
  | { kind: "heartbeat_failed"; reason: string }
  | { kind: "stopping"; cleanupPlanId: string }
  | { kind: "stop_blocked"; failures: CleanupFailure[] }
  | { kind: "cleanup_failed"; failures: CleanupFailure[] }
  | { kind: "stopped" }
  | { kind: "version_mismatch"; expected: string; actual: string }
  | { kind: "error"; diagnosis: NativeHostDiagnosis };
```

Protocol gap:

`stopped` must be committed only after cleanup succeeds or after an explicit degraded cleanup path is selected and recorded. Dialog-blocked close, debugger-detach failure, overlay-release failure, and pending native requests should not be hidden behind a successful stopped state.

### Browser Session

Evidence:

- `packages/extension/src/session_store.ts:3` defines `BrowserSession`.
- `packages/extension/src/session_store.ts:5` stores optional `activeTabId`.
- `packages/extension/src/session_store.ts:6` stores optional `controlState: "human_takeover"`.
- `packages/extension/src/browser_session_controller.ts:72` creates an agent tab and records it in the session.
- `packages/extension/src/browser_session_controller.ts:210` yields control.
- `packages/extension/src/browser_session_controller.ts:219` resumes control.
- `packages/extension/src/lifecycle/browser_session_machine.ts:22` rejects selected actions during human takeover.

Assessment:

The browser session is still represented as a mutable bag of fields rather than a closed lifecycle union. `currentTurnId`, `activeTabId`, `controlState`, `tabs`, `finalizedTabs`, and `attachedTabIds` can be updated independently. Some operations call `assertSessionAcceptsAction()`, but the guard is local and does not cover every browser-affecting transition.

Human takeover is especially important. `yieldControl()` marks the session as `human_takeover` and hides overlay state, but finalization does not check this boundary. That means normal tab commands are constrained, while finalization can still close or release browser tabs after the session has been yielded.

Required mature state space:

```ts
type BrowserSessionLifecycle =
  | { kind: "empty"; sessionId: string }
  | { kind: "active"; sessionId: string; turnId: string; activeTabId?: number }
  | { kind: "human_takeover"; sessionId: string; yieldedAtTurnId: string; activeTabId?: number }
  | { kind: "resuming"; sessionId: string; turnId: string; repairPlan: ActiveTabResolutionPlan }
  | { kind: "finalizing"; sessionId: string; turnId: string; finalizePlanId: string }
  | { kind: "finalized"; sessionId: string; finalTabs: FinalTabsSummary }
  | { kind: "cleanup_failed"; sessionId: string; failures: CleanupFailure[] }
  | { kind: "stale"; sessionId: string; reason: string };
```

Protocol gap:

Every browser-affecting method should require an allowed session lifecycle state before backend routing. Finalization should be rejected during `human_takeover` unless it is an explicit cleanup/stop path with separate user-facing semantics.

### Session Tab Ownership

Evidence:

- `packages/extension/src/session_store.ts:15` defines `TabOrigin = "agent" | "user"`.
- `packages/extension/src/session_store.ts:16` defines `TabStatus = "active" | "handoff" | "deliverable"`.
- `packages/extension/src/lifecycle/tab_ownership_machine.ts:97` plans tab removal.
- `packages/extension/src/tab_lifecycle_controller.ts:55` handles tab removal.
- `packages/extension/src/browser_session_controller.ts:255` requires an active session tab for tab commands.
- `packages/extension/src/browser_session_controller.ts:265` resolves logical active tab ids.

Assessment:

The tab model has useful ownership labels and terminal-ish statuses, but it does not preserve the key invariant:

`activeTabId` must be undefined or point to a `session.tabs` row whose status is `active`.

Tab removal deletes rows and attached debugger ids, but active-tab repair must remain explicit. Current read-shaped methods only plan/observe stale active-tab state; action-shaped repair paths apply cleanup through the named executor. The remaining risk is any sibling path that still updates active-tab state outside that planner/executor split.

Required mature state space:

```ts
type SessionTabLifecycle =
  | { kind: "active"; tabId: number; origin: "agent" | "user"; commandable: true }
  | { kind: "handoff"; tabId: number; origin: "agent" | "user"; commandable: false }
  | { kind: "deliverable"; tabId: number; origin: "agent" | "user"; commandable: false }
  | { kind: "closing"; tabId: number; reason: string }
  | { kind: "releasing"; tabId: number; reason: string }
  | { kind: "released"; tabId: number; reason: string }
  | { kind: "gone"; tabId: number; observedBy: "chrome.tabs" | "replacement" | "restore" }
  | { kind: "stale"; tabId: number; reason: string; cleanupRequired: CleanupObligation[] };
```

Required planner shape:

```ts
type ActiveTabResolutionPlan = {
  nextActiveTabId?: number;
  removedTabIds: number[];
  activeTabChanged: boolean;
  cleanup: CleanupObligation[];
  changed: boolean;
};
```

Protocol gap:

`resolveSessionActiveTabId()` should become a planner plus an executor. A method shaped like a resolver should not delete session rows, detach debuggers, clear overlays, remove download owners, or persist state unless the return type explicitly carries those effects.

### Finalization And Turn Boundary

Evidence:

- `packages/extension/src/lifecycle/finalize_tabs_machine.ts:51` parses `keep`.
- `packages/extension/src/lifecycle/finalize_tabs_machine.ts:67` plans finalization steps.
- `packages/extension/src/finalize_tabs_controller.ts:85` starts finalization.
- `packages/extension/src/finalize_tabs_controller.ts:97` applies the plan.
- `packages/extension/src/finalize_tabs_controller.ts:176` can return fatal failure.
- `packages/sdk/src/browser.ts:249` exposes `turnEnded()`.
- `packages/sdk/src/browser.ts:287` implements `finishTurn()` as finalize then turn ended.

Assessment:

Finalization has one of the better local planners. It can plan close, release, handoff, and deliverable outcomes. The issue is turn protocol semantics.

`finishTurn()` currently calls `finalizeTabs()` and then `turnEnded()`. If finalization returns partial or fatal failure, the turn boundary can still advance unless an exception stops the call. This weakens the meaning of `turnEnded`: downstream consumers cannot trust it means the browser session reached a coherent lifecycle boundary.

Required mature state space:

```ts
type TurnLifecycle =
  | { kind: "open"; sessionId: string; turnId: string }
  | { kind: "yielded"; sessionId: string; turnId: string }
  | { kind: "finalizing"; sessionId: string; turnId: string; plan: FinalizeTabsPlan }
  | { kind: "finalize_partial"; sessionId: string; turnId: string; result: FinalizeTabsResult }
  | { kind: "finalize_failed"; sessionId: string; turnId: string; result: FinalizeTabsResult }
  | { kind: "ended"; sessionId: string; turnId: string; finalTabs: FinalTabsSummary };
```

Required SDK shape:

```ts
type FinishTurnResult =
  | { kind: "ended"; finalize: BrowserFinalizeTabsResult }
  | { kind: "not_ended"; finalize: BrowserFinalizeTabsResult; reason: "finalize_failed" | "partial_failure" };
```

Protocol gap:

The SDK should not mark a turn ended after fatal finalization. Partial finalization should require explicit caller opt-in or return a discriminated result that clearly says the turn remains open.

### Overlay Takeover

Evidence:

- `packages/extension/src/lifecycle/overlay_machine.ts:43` plans overlay activation.
- `packages/extension/src/overlay_coordinator.ts:77` activates takeover state.
- `packages/extension/src/overlay_coordinator.ts:221` hides overlay state.
- `packages/extension/src/overlay_coordinator.ts:250` sends content messages and returns `false` on failure.

Assessment:

Overlay activation has a small planner, but release is best-effort. `hide()` deletes local active takeover state before it proves that the content script accepted the hide command. If content messaging fails, the page may still display cursor/input-lock state while the extension believes the overlay is gone.

This is not just visual cleanup. Extension update idle detection uses overlay activity as one signal. If overlay release is locally committed too early, the update machine can decide the browser is idle while page-side takeover state remains visible.

Required mature state space:

```ts
type OverlayLifecycle =
  | { kind: "inactive" }
  | { kind: "active"; tabId: number; sessionId: string; turnId: string; lastCursor?: CursorTarget }
  | { kind: "release_pending"; tabId: number; attempts: number; reason: string }
  | { kind: "released"; tabId: number }
  | { kind: "release_failed"; tabId: number; reason: string; retryable: boolean }
  | { kind: "gone"; tabId: number };
```

Protocol gap:

Overlay hide should be a planned transition. Local state should not be forgotten until either the hide is acknowledged, the tab is known gone, or a retryable `release_pending` state is recorded.

### Host Registry

Evidence:

- `crates/obu-host/src/service_registry.rs:339` exposes `set_active_tab()`.
- `crates/obu-host/src/service_registry.rs:362` repairs current active tab on read.
- `crates/obu-host/src/registry_lifecycle.rs:154` plans current active-tab repair.
- `crates/obu-host/src/registry_lifecycle.rs:177` plans session reconciliation against observed tabs.
- `crates/obu-host/src/registry_lifecycle.rs:303` plans active-tab set events.

Assessment:

The Rust host registry now has useful pure lifecycle planning. Active-tab repair and reconciliation are good steps toward a real authority. But there is still an unchecked public setter for logical active tab state. It writes `session.active_tab_id` without proving that the tab exists, is active, and belongs to the same session.

This creates a mismatch: reads are planner-repaired, but writes can still create invalid state. The host registry should be the browser-state authority, so its public mutation API must be validated by default.

Required mature shape:

```rust
enum ActiveTabTransition {
    Set {
        session_id: String,
        tab_id: String,
        turn_id: Option<String>,
    },
    Reconciled {
        session_id: String,
        previous: Option<String>,
        next: Option<String>,
        reason: String,
    },
    Rejected {
        session_id: String,
        tab_id: String,
        reason: ActiveTabRejectReason,
    },
}
```

Protocol gap:

Split active-tab APIs into:

- A private unchecked primitive for restore/replay internals.
- A public validated transition requiring same-session active ownership.
- A planner-derived diagnostic event emitted only for meaningful changes.

### Native Request Bridge And Timeouts

Evidence:

- `packages/extension/src/native_host_bridge.ts:46` sends native requests.
- `packages/extension/src/native_host_bridge.ts:69` resolves native responses.
- `packages/sdk/src/wire/transport.ts:43` implements SDK request timeout handling.
- `packages/sdk/src/wire/transport.ts:64` deletes pending requests on defensive timeout.

Assessment:

The request bridge tracks pending requests, but timeout semantics are not lifecycle-complete for browser side effects. A timeout can be returned to the SDK while the browser action continues in Chrome or extension code. If the agent retries, two browser-affecting operations can occur while only one failure is visible at the SDK boundary.

Required mature state space:

```ts
type BrowserEffectRequestLifecycle =
  | { kind: "pending"; requestId: number; deadlineMs: number }
  | { kind: "timed_out_pending_reconcile"; requestId: number; method: string }
  | { kind: "cancelled"; requestId: number }
  | { kind: "completed"; requestId: number; result: unknown }
  | { kind: "timed_out_late_success"; requestId: number; resultSummary: unknown }
  | { kind: "timed_out_late_error"; requestId: number; error: StructuredRpcError };
```

Protocol gap:

Timeout must either cancel the side effect, keep correlation through late completion, or reconcile state before reporting a clean terminal failure.

### Extension Update

Evidence:

- `packages/extension/src/lifecycle/extension_update_machine.ts:96` computes browser-control activity.
- `packages/extension/src/lifecycle/extension_update_machine.ts:112` plans `none | wait_for_idle | reload`.
- `packages/extension/src/background.ts:1000` applies pending extension update.
- `packages/extension/src/background.ts:1026` builds activity snapshots from overlay, debugger, native, and session signals.

Assessment:

The extension update machine is comparatively clean. It waits for idle before reload and uses several activity signals. Its correctness depends on lower-level lifecycle truth. If overlay release, debugger cleanup, pending native requests, or active session tab counts are inaccurate, extension update can reload too early or wait forever.

Protocol gap:

Extension update should depend on lifecycle states, not just derived counters. For example, `overlay.release_pending` and `native.stop_blocked` should block reload; `tab.gone` and `overlay.gone` should not.

## Cross-Layer Protocol Integrity

### Creation

Creation is partially constrained:

- SDK requests carry session metadata through `withSessionMeta()`.
- Extension `createSessionTab()` records session ownership, active tab, tab origin, group ownership, overlay activation, and persisted state.
- Host registry can track tab/session rows.

Gaps:

- Some backend paths still allow optional session/turn metadata.
- Host active-tab writes can be unvalidated.
- SDK can construct command-looking tab handles for ids that are not proven commandable.

Required rule:

Every mutating browser operation must require session id, turn id, method policy approval, and a commandable resource proof before backend routing.

### Use

Use is partially constrained:

- Extension `requireSessionTab()` rejects tab commands during human takeover.
- SDK guards classify some methods.
- Host dispatcher enforces policy for raw CDP/current-origin cases.

Gaps:

- Some policy probes use normal backend command paths and can mutate state before authorization.
- Raw CDP can be hidden behind high-level semantic SDK calls.
- Structured RPC error data can be flattened before reaching the SDK.

Required rule:

Policy reads must be side-effect free, and semantic SDK reads should not require the same raw-CDP permission as explicit escape hatches.

### Pause/Yield

Pause/yield is weakly modeled:

- `yieldControl()` sets `controlState = "human_takeover"`.
- Overlay is hidden.
- Some tab commands are rejected until resume.

Gaps:

- Finalization can still run.
- Host registry does not model human takeover as an ownership state.
- Stop/cleanup and finalize semantics are not separated clearly from normal agent control.

Required rule:

Human takeover is an ownership boundary, not prompt guidance. While active, ordinary browser-affecting operations must be rejected unless they are explicit user-approved cleanup operations.

### Resume

Resume is partially modeled:

- `resumeControl()` resolves active tab, clears takeover, activates overlay, persists state.

Gaps:

- Active-tab resolution mutates state without a cleanup plan.
- Stale debugger/download/group/overlay cleanup is not guaranteed during repair.
- No first-class `resuming` or `repair_failed` state exists.

Required rule:

Resume should run reconciliation before returning a commandable tab. If reconciliation fails, the result should be a typed blocked/repair state, not `null` plus hidden mutations.

### Release/Finalize

Release/finalize is partially modeled:

- Finalize planner handles close/release/handoff/deliverable.
- Cleanup closes agent tabs on stop and releases controlled tabs in unavailable mode.
- Deliverable and handoff states exist.

Gaps:

- `finishTurn()` can advance the turn boundary after failed finalization.
- Stop can publish `stopped` after cleanup failure.
- Overlay release has no proof state.
- Tab removal can leave stale active-tab id.

Required rule:

Release must be transactional at the lifecycle level. The executor may perform many best-effort browser operations, but the public state must record exactly which resources were released, which are pending, and which failed.

## Missing State-Space Elements

The following states should become first-class before this architecture can be considered complete:

| Area | Current representation | Missing first-class states | Why the gap matters |
| --- | --- | --- | --- |
| Session | `BrowserSession` is a mutable record with `currentTurnId`, optional `activeTabId`, optional `controlState`, maps, sets, and group ids | `resuming`, `finalizing`, `cleanup_failed`, `stale`, host-visible `human_takeover` | Independent field mutation lets finalization, cleanup, and active-tab repair bypass one session authority |
| Tab | `SessionTab` stores `origin`, `status`, and optional cursor; status is only `active`, `handoff`, or `deliverable` | `closing`, `releasing`, `released`, `gone`, `stale`, `cleanup_required` | Browser-visible close/release and Chrome-gone transitions are side effects, but current state jumps directly to deletion or map movement |
| Turn | `turn_id` is request metadata passed through SDK/extension/host boundaries | `open`, `yielded`, `finalizing`, `finalize_partial`, `finalize_failed`, `ended` | `turnEnded()` can become a marker rather than proof that finalization reached a coherent boundary |
| Native transport | Public status has `disconnected`, `connecting`, `connected`, `version_mismatch`, `stopped`, `error`; private booleans/timers represent in-flight work | `hello_pending`, `stopping`, `stop_blocked`, `cleanup_failed`, `heartbeat_failed` | Terminal public status can hide cleanup and heartbeat failure details |
| Overlay | `activeTakeovers` map plus content-script send results | `release_pending`, `release_failed`, `released`, `gone` | Local overlay state can be removed before page-side cursor/input state is actually released |
| Browser effect request | SDK, host, and extension bridges use pending maps plus timeouts | `timed_out_pending_reconcile`, `cancelled`; native messaging now records `timed_out_late_success`, `timed_out_late_error`, and `timed_out_late_transport_closed` | A timeout can still be returned while the browser operation continues unless the caller uses diagnostics to reconcile late completion |
| Runtime descriptor | CLI read-side lifecycle is `fresh`, `stale`, `invalid`; host publish/drop has a separate lifecycle; setup machine is separate again | `setup_missing`, `descriptor_invalid`, `runtime_stale`, `fresh`, `dropped` as one shared vocabulary | Repair selection and public status can classify invalid descriptor shape as stale runtime state |
| File chooser | Host records `FileChooserState` and later moves consumed handles into stale diagnostics | `pending`, `consumed`, `cancelled`, `owner_tab_gone`, `timed_out`, `stale` | Upload handles are real browser capabilities, but only consumed/stale is modeled strongly |
| Download | Extension owner queues and host download handle states track started/completed/failed ownership | `pending`, `started`, `completed`, `failed`, `owner_tab_gone`, `orphaned` | Download ownership can outlive tab/session cleanup without a shared terminal protocol |
| Managed tab/group | `TabGroupManager` persists groups and managed tab status, with reconciliation for missing groups | `group_reconciling`, `group_missing`, `tab_moved`, `release_pending`, `release_failed` | Chrome tab group state is user-visible and should be part of session/tab release diagnostics |
| Policy/capability decision | SDK guards and host dispatcher classify methods and enforce checks | `preflight`, `allowed`, `denied`, `unsupported`, `side_effect_free_probe_failed` | Policy denial must be provably side-effect free; current probes can use normal command paths |
| Foreground observation | Foreground observer updates `activeTabId` and syncs overlay foreground state | `observed`, `accepted_as_logical_active`, `ignored`, `repair_required` | Foreground changes can mutate active-tab state without the same repair executor used for stale rows |
| Extension update | Pending update state is `waiting_for_idle`; activity snapshot uses aggregate reasons | Dependency-specific blockers such as `overlay_release_pending`, `native_stop_blocked`, `tab_cleanup_failed` | Reload safety depends on lower lifecycle proof, not just counter-based idle signals |

## Architecture Backbone Recommendation

The state-machine refactor should converge on a consistent pattern:

```ts
type TransitionPlan<S, E, D> = {
  from: S;
  to: S;
  effects: E[];
  diagnostics: D[];
  cleanup: CleanupObligation[];
  publicStatus: PublicLifecycleStatus;
};
```

Each resource should have:

1. A discriminated union state type.
2. Pure planner functions that accept current state and event input.
3. Controller executors that apply effects and record diagnostics.
4. No query method that mutates hidden lifecycle state.
5. Public status derived from planner states, not reconstructed manually.
6. Tests that assert state, effects, diagnostics, and public summary parity.

The priority order should be:

1. Session/tab/turn lifecycle unions.
2. Active-tab resolution planner and executor.
3. Human takeover enforcement across finalization and host registry.
4. Stop cleanup result states.
5. Overlay release states.
6. Timeout late-completion correlation.
7. Host active-tab validated transition.
8. Runtime descriptor shared lifecycle vocabulary.

## Proposed Acceptance Criteria

The lifecycle protocol should be considered complete only when these acceptance criteria pass:

1. A yielded session rejects tab commands, finalization, and normal turn-ending operations unless an explicit cleanup mode is requested.
2. `finishTurn()` does not call `turnEnded()` after fatal finalization and exposes partial finalization as a typed result.
3. Removing an active tab immediately clears or reselects `activeTabId` and persists the corrected state.
4. Active-tab resolution returns a plan with removed rows, next active tab, cleanup obligations, and diagnostics.
5. `stop()` returns `stopped` only after browser-control cleanup succeeds, otherwise returns `stop_blocked` or `cleanup_failed`.
6. Overlay hide remains pending or failed if the content script cannot acknowledge release and the tab is not known gone.
7. Host `set_active_tab` rejects missing, cross-session, non-active, or non-commandable tabs.
8. Policy probes do not touch session timestamps, active tab ids, lifecycle events, or backend mutable state.
9. Timed-out browser effects remain correlated until cancellation, late success, late error, or reconciliation.
10. Public diagnostics preserve structured error data and planner-selected next active tab ids.
11. Extension update waits on explicit lifecycle blockers, not only counters derived from mutable maps.
12. Runtime descriptor setup, invalid descriptor, and stale runtime failures map to distinct public states and next actions.

## Test Plan

Required regression tests should cover both final state and transition diagnostics:

- Extension session tests:
  - `yieldControl(); finalizeTabs()` is rejected.
  - `yieldControl(); finishTurn()` does not close/release tabs.
  - `resumeControl()` runs active-tab repair and returns typed blocked state when repair fails.

- Tab ownership tests:
  - Removing the active tab clears or reselects `activeTabId`.
  - Resolver does not mutate state without returning cleanup obligations.
  - Gone tabs clean overlay, debugger, managed group, and download ownership consistently.

- Finalization tests:
  - Fatal finalization prevents `turnEnded()`.
  - Partial finalization requires explicit opt-in to end the turn.
  - Handoff and deliverable states appear in final tabs and persistence.

- Native transport tests:
  - Cleanup failure produces `cleanup_failed`, not `stopped`.
  - Dialog-blocked close produces `stop_blocked` or release fallback.
  - Pending requests are rejected with structured lifecycle error data.

- Overlay tests:
  - Hide failure creates `release_pending` or `release_failed`.
  - Tab removal converts overlay state to `gone`.
  - Extension update treats pending overlay release as non-idle.

- Host registry tests:
  - Validated active-tab set rejects missing/cross-session/non-active tabs.
  - Reconciliation event includes the planner-selected next active tab.
  - No-op active-tab writes do not flood lifecycle diagnostics.
  - File chooser consumption, timeout, and owner-tab-gone paths produce distinct handle lifecycle diagnostics.
  - Download completion, failure, and owner-tab-gone paths produce distinct handle lifecycle diagnostics.

- Managed group and foreground tests:
  - Managed group disappearance is recorded as a repair transition, not only silent deletion.
  - Releasing a tab updates session rows, managed group rows, overlays, and diagnostics in one executor path.
  - Foreground observation cannot update `activeTabId` without the same active-tab repair invariants used by tab removal.

- Policy and capability tests:
  - Policy preflight denial does not touch session timestamps, active tab ids, lifecycle events, or backend mutable state.
  - Unsupported capability and denied policy errors preserve structured code/data across SDK, host, and extension boundaries.

- Timeout tests:
  - Browser effect timeout records late success or late failure if the browser action completes after SDK timeout.
  - Retry behavior cannot silently duplicate side effects without diagnostics.

- Runtime descriptor tests:
  - Missing setup, invalid descriptor, and stale runtime produce distinct lifecycle states.
  - CLI verify and Node REPL browser status agree on state, product error, and next action.

## Summary

The current code has enough lifecycle machinery to support a mature architecture, but the state spaces are not yet closed. The next refactor should treat state machines as the architecture backbone, not as helper planners around existing mutation paths.

The target architecture is:

- SDK expresses intent.
- Host validates policy, session, turn, capability, and lifecycle state.
- Extension executes Chrome-side facts.
- State machines own transition legality, cleanup obligations, and public diagnostics.

Until session/tab/turn/overlay/native transport lifecycles are made explicit and cross-layer, the product remains partly a controlled browser tool rather than a fully constrained browser capability container.
