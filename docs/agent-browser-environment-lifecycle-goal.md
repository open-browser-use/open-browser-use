# Agent Browser Environment Lifecycle Goal

Date: 2026-05-23

This goal document consolidates the execution state and implementation plan for:

- `docs/state-machine-architecture-review-findings.md`
- `docs/state-machine-lifecycle-protocol-completeness-review.md`

Those documents are inputs, not the only source of truth. The product goal is broader: open-browser-use should behave as a verifiable browser environment runtime for agents. SDK and JavaScript runtime code may compose freely, but every real browser side effect must pass through explicit local lifecycle machinery, host policy, session and turn ownership, Chrome extension control boundaries, and structured diagnostics.

## Product Goal

Build a browser environment contract that agents can reason about safely.

The environment contract is:

1. Action preconditions are checked before side effects.
2. Every browser-affecting transition has one authority.
3. Observations and public status reflect the real environment state.
4. Terminal states do not hide pending cleanup, late side effects, or stale ownership.
5. Reset and repair paths are executable, repeatable, and diagnostic.
6. Failures are structured enough for an agent to choose a next action.
7. Human takeover is external controller ownership, not prompt guidance.

The state-machine work is successful only when these properties hold across SDK, Node REPL MCP, Rust host, WebExtension controllers, runtime descriptors, repair tooling, and tests.

## Current Execution Summary

The current implementation has been carried through the planned lifecycle gaps. The table below remains as the traceability map from the original review findings to the runtime areas that had to be closed; completion evidence is listed after the phase plan.

| Area | Current execution state | Closed goal |
| --- | --- | --- |
| Runtime descriptor lifecycle | CLI now separates invalid and stale descriptors and has `invalid_descriptor` repair behavior. | Node REPL public diagnostics must match CLI lifecycle states and product errors. |
| Host mutation boundary | Dispatcher has a mutating-method guard requiring `session_id` and `turn_id`; registry active-tab writes are validated. | Red host concurrency tests must be updated or fixed so the new guard is proven, not just present. |
| Host policy boundary | Current-origin policy uses `current_url_for_policy` instead of normal tab command routing. | Add tests proving denied policy probes do not mutate registry timestamps, active tab, events, or backend state. |
| Native timeout lifecycle | Timed-out extension requests preserve late completion diagnostics. | Regression coverage now asserts late success, late structured error, and late transport-closed outcomes. |
| Human takeover | Extension finalization and host registry have takeover guards. | Normal turn-ending and all browser-affecting paths must consistently reject while yielded, except explicit cleanup/stop flows. |
| Turn finalization | SDK `finishTurn()` does not call `turnEnded()` after fatal finalization and only ends partial turns with opt-in. | Add cross-layer tests from SDK behavior through extension finalization result shape. |
| Extension stop cleanup | Native transport has `cleanup_failed` rather than always publishing `stopped`. | Ensure every cleanup failure that leaves controlled browser state is visible and blocks false idle. |
| Session tab removal | Tab removal repairs or clears active tab and cleans related rows; read-shaped tab queries now expose repair-required planning without mutating. | Continue auditing sibling active-tab paths so only action-shaped repair executors perform cleanup mutations. |
| Overlay release | Overlay state can remain `release_pending`. | Add failed-release diagnostics and make pending release an explicit activity blocker. |
| SDK commandability | Unowned user tabs are exposed as `UserTabRef`; commandable `Tab` requires ownership. | Audit nested tab surfaces so every browser-affecting method enforces commandability. |
| Host registry diagnostics | Active-tab repair, direct removal, and no-op suppression have planner/event machinery. | Diagnostics must preserve planner-selected next active tab ids, direct-removal reconciliation events, and no-op active-tab event suppression. |

## Execution Order

### Phase 0: Stabilize Current Work

Purpose: make the current refactor testable before expanding scope.

Tasks:

- Fix `cargo test -p obu-host --tests`, currently failing in `dispatcher_concurrency`.
- Fix `cargo test -p obu-node-repl --test discover_backends`, currently failing descriptor diagnostic parity cases.
- Keep TypeScript package tests green.

Acceptance:

- `git diff --check`
- `pnpm --filter @open-browser-use/cli test`
- `pnpm --filter @open-browser-use/sdk test`
- `pnpm --filter @open-browser-use/extension test`
- `cargo test -p obu-host --tests`
- `cargo test -p obu-node-repl --test discover_backends`

### Phase 1: Runtime Descriptor Environment Status

Purpose: make setup, invalid descriptor, stale runtime, and popup boundary distinct agent-observable states.

Tasks:

- Derive CLI verify public state, product error, next action, and lifecycle detail from the descriptor lifecycle planner.
- Derive Node REPL `browser_status` and `discoverBackendDiagnostics()` from the same conceptual state vocabulary.
- Tie host descriptor publish/drop lifecycle into the same public environment vocabulary, so host `fresh` and `dropped` states do not contradict CLI or Node REPL setup/content/liveness states.
- Keep invalid descriptor repair executable and explicit.
- Reserve `stale_descriptor` for live-runtime staleness only.

Unit coverage:

- CLI invalid JSON, unsupported schema, unsupported type, missing socket, missing token, non-socket path, auth rejection, and getInfo mismatch.
- Node REPL missing runtime root, unsafe runtime root, no descriptor, malformed JSON, stale descriptor, invalid descriptor, and popup boundary.
- Host descriptor publish/drop lifecycle reports `fresh` and `dropped` in a way that composes with CLI and Node REPL setup, invalid descriptor, stale runtime, and popup boundary states.
- Public parity assertions: lifecycle state, reason code, product error, and next action agree.

### Phase 2: Host Action Boundary

Purpose: make the Rust host the mandatory preflight authority for browser side effects.

Tasks:

- Keep `route_request` ordering as: method support, mutation context, session lock, tab lock, policy, backend route.
- Require `session_id` and `turn_id` for all browser-affecting methods before backend execution.
- Keep active-tab writes validated against existing same-session active tab rows.
- Keep policy probes side-effect free.
- Preserve structured RPC error data across host and extension boundaries.
- Preserve host registry lifecycle diagnostics from planner output, including selected next active tab ids during reconciliation, direct-removal reconciliation events, and no-op active-tab event suppression.

Unit coverage:

- Missing session or turn rejects before backend side effect.
- Cross-session, missing, non-active, or non-commandable active-tab writes fail.
- Policy denial does not touch session timestamp, active tab, lifecycle events, or fake backend mutable counters.
- RPC `error.data` survives native messaging and SDK-visible error shaping.
- Reconciliation events include planner-selected next active tab ids.
- Direct host tab removal records a reconciliation event when it repairs active state.
- Repeated active-tab writes to the same tab do not emit lifecycle events.

### Phase 3: Extension Session And Tab Protocol

Purpose: make extension session state a closed protocol, not a mutable bag repaired by incidental reads.

Tasks:

- Split active-tab resolution into a pure observation/planner boundary and a clearly named apply/repair executor. Renaming the current resolver is not sufficient unless read-shaped call sites stop mutating state directly.
- Route `getCurrentSessionTab`, `resumeControl`, `requireCurrentSessionTabForBrowserCommand`, tab removal, tab replacement, and restore through the same active-tab repair semantics.
- Ensure gone tabs clean overlays, debugger attachments, managed groups, download ownership, finalized rows, active rows, and persisted state through one executor path.
- Ensure foreground observation cannot bypass active-tab invariants.

Unit coverage:

- Removing active tab clears or reselects `activeTabId` immediately.
- Pure planner returns removed rows, next active tab, cleanup obligations, diagnostics, and changed flag without mutating session, overlay, debugger, download, managed group, or persisted state.
- Apply/repair executor consumes the planner result and is the only path allowed to perform those cleanup mutations.
- Gone active tab through `getCurrentSessionTab`, `resumeControl`, and command guard produces the same repair result.
- Foreground update cannot select a missing or non-session tab.

### Phase 4: Turn, Finalization, Stop, And Overlay Boundaries

Purpose: make episode boundaries truthful for agents.

Tasks:

- Reject normal browser-affecting operations, finalization, and normal turn end while a session is in human takeover.
- Keep explicit cleanup/stop semantics separate from normal finalize/turn-end semantics. Cleanup during human takeover may only be initiated by user stop, host shutdown, repair, or other trusted lifecycle teardown paths; normal SDK agent calls must not choose cleanup-shaped APIs to bypass takeover ownership.
- Ensure `finishTurn()` ends the turn only after successful finalization, or after explicit partial opt-in.
- Keep `stopped` reserved for successful browser-control cleanup.
- Keep overlay release pending or failed until hidden state is acknowledged or the tab is known gone.
- Treat pending overlay release as browser-control activity for extension update and idle checks.

Unit coverage:

- `yieldControl(); finalizeTabs()` rejects.
- `yieldControl(); turnEnded()` rejects for normal SDK agent calls.
- Cleanup during takeover succeeds only through user stop, host shutdown, repair, or trusted lifecycle teardown paths, and emits diagnostics identifying that authority.
- Fatal finalization prevents `turnEnded()`.
- Partial finalization defaults to `turnEnded: false`.
- `endTurnOnPartial: true` is the only partial path that ends the turn.
- Native stop cleanup failure publishes `cleanup_failed`, not `stopped`.
- Overlay hide failure creates pending or failed state and blocks idle/update reload.

### Phase 5: SDK Environment Interface

Purpose: make SDK objects reflect ownership and action validity.

Tasks:

- Ensure unowned tabs remain non-commandable refs until claimed.
- Audit `Tab`, `Locator`, `FrameLocator`, `TabContent`, `TabCua`, `TabDomCua`, `TabDev`, and Playwright helper surfaces for commandability checks.
- Keep semantic SDK APIs distinct from explicit raw CDP escape hatches.
- Preserve structured failure information so agents can recover.

Unit coverage:

- `browser.user.openTabs()` and `browser.tabs.selected()` return `UserTabRef` for unowned tabs.
- `UserTabRef` only exposes claim semantics.
- Commandable `Tab` methods reject when metadata says commandable false.
- `tab_evaluate` and `tab_snapshot_text` remain explicit wire methods and policy-classified.

### Phase 6: Cross-Layer Acceptance

Purpose: prove the environment contract end to end.

Acceptance scenarios:

- Invalid descriptor files lead to invalid descriptor diagnostics and executable repair, not stale runtime diagnostics.
- Stale runtime descriptors lead to stale diagnostics and stale repair, not invalid descriptor repair.
- A denied current-origin action leaves session and registry state unchanged.
- A browser effect timeout records late success or late error when the extension later completes.
- A yielded session cannot be finalized or ended by normal agent calls.
- Removing the active tab produces one planned repair and matching public diagnostics.
- A cleanup failure prevents false stopped or idle status.
- An unowned user tab cannot execute a browser-affecting SDK method before claim.

## Completion Evidence

This implementation pass closes the review findings against the product goal, not just the document wording:

- Runtime descriptor diagnostics now distinguish setup missing, popup boundary, invalid descriptor, stale descriptor, fresh descriptor, and host publish/drop lifecycle states across CLI, Node REPL, and host descriptor code.
- Host dispatch rejects browser-affecting methods without session and turn context before policy or backend routing, keeps denied policy probes side-effect free, and preserves structured error data.
- Extension active-tab repair now has a pure planner and a named repair executor; stale active, handoff, deliverable, finalized, overlay, debugger, managed group, and download ownership cleanup use the same executor path.
- Human takeover is enforced as an ownership boundary for normal finalization, turn end, and browser command paths, while trusted cleanup/stop paths remain separate.
- Overlay release pending and failed states are first-class activity blockers and are published through extension diagnostics and Node `browser_status` advisories.
- SDK `Tab`, `Locator`, `FrameLocator`, `TabContent`, `TabCua`, `TabDomCua`, `TabDev`, `TabPlaywright`, and clipboard surfaces enforce commandability before guard URL lookup or transport calls.

Validated commands:

- `git diff --check`
- `pnpm --filter @open-browser-use/cli test`
- `pnpm --filter @open-browser-use/sdk test`
- `pnpm --filter @open-browser-use/extension test`
- `cargo test -p obu-host --tests`
- `cargo test -p obu-node-repl --test discover_backends`

## Mapping From Review Findings To Phases

| Review finding | Phase |
| --- | --- |
| `RD-1`, `RD-2`, `RD-3`, `RD-4` | Phase 1 |
| `HOST-1`, `HOST-2` | Phase 2 |
| `HOST-3`, `HOST-8` | Phase 2 |
| `HOST-4` | Phase 2 and Phase 6 |
| `TURN-1`, `TURN-2` | Phase 4 |
| `EXT-1`, `EXT-2`, `EXT-3`, `EXT-4` | Phase 3 and Phase 4 |
| `SDK-1`, `SDK-2` | Phase 5 |
| `HOST-5`, `HOST-6`, `HOST-7` | Phase 2 and Phase 3 diagnostics |
| `TEST-1` | Phase 6 |

## Definition Of Done

This goal is complete when:

1. All Phase 0 test commands pass, plus the targeted unit and acceptance tests added for Phases 1-6.
2. Public lifecycle diagnostics do not contradict internal planner state.
3. Browser-affecting methods fail before side effects when ownership or policy preconditions are missing.
4. Finalization, stop, timeout, overlay release, descriptor repair, and tab removal all produce structured terminal or pending diagnostics.
5. Human takeover is enforced as an ownership boundary in SDK, host, and extension paths.
6. SDK handles encode commandability accurately enough that an agent cannot mistake an observation for an owned actuator.
