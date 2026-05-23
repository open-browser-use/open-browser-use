# Agent Action Observation Runtime Plan

Date: 2026-05-23
Status: Implemented initial runtime slice with lifecycle hardening

## Purpose

This document is the implementation-oriented precursor to
`docs/agent-environment-product-logic-and-optimization.md`.

The product thesis is that Open Browser Use should be an agent browser
environment, not just a browser automation library. To make that real, the
runtime must first define the core environment loop:

```text
observe -> choose action -> preflight -> execute -> reconcile state -> return delta
```

The immediate product work should therefore be:

1. Build `observe` first.
2. Unify the page action layer across Locator, DOM-CUA, and Coordinate CUA.
3. Treat backend implementations as CDP-bearing execution substrates, not as
   product-level behavior branches.
4. Make the state machines explicit enough for human takeover, resume, cursor
   state, stale observations, and action recovery.

## Implementation Snapshot

The initial runtime slice implements this loop in code:

- SDK `tab.observe()` returns observation ids, section status, lifecycle
  metadata, ownership, action-family capability summaries, page-state hashes,
  viewport/focus revisions when available, DOM-CUA affordance revisions when
  requested, pointer state, text summaries, optional DOM-CUA summaries, optional
  screenshots, and state traces.
- SDK `tab.step(...)` and `tab.act.*` normalize Locator, DOM-CUA, and
  Coordinate CUA into one environment-native action result with action-state
  traces, structured blocked/failed outcomes, pointer updates, and invalidated
  observation ids.
- Observation-scoped actions fail closed when their observation is unknown,
  expired, consumed, or no longer matches the current page, viewport, focus, or
  DOM-CUA affordance revision required by the action.
- Pointer state is shared through the browser runtime context. Coordinate
  actions update it directly, DOM-CUA actions update it from the resolved action
  point, and Locator actions mark an existing pointer stale when no cursor point
  is reported. `yieldControl()` and `resumeControl()` mark it stale so the next
  observation can show that human takeover or resume invalidated cursor
  continuity.
- DOM-CUA read/action is implemented for CDP and WebExtension through a shared
  host runtime over CDP DOM geometry and Coordinate CUA input. WebExtension keeps
  extension-only media download helpers separate.
- Backend capability discovery now advertises DOM-CUA read/action on CDP when
  the CDP substrate is sufficient, while extension-only surfaces remain
  explicitly unsupported on CDP.

This is still intentionally local-first: observations, screenshots, diagnostics,
and traces are returned to the local caller and are not uploaded by the runtime.

## Product Logic And Code Quality

The product logic is part of the code quality bar. The implementation should not
optimize for short-term command routing at the cost of losing the
agent-environment model.

Quality rules:

- Keep the observe-action-feedback loop visible in the code structure.
- Treat the observe, action, pointer, and ownership state machines as source of
  truth, not as documentation-only diagrams.
- Prefer typed operation objects and typed state transitions over ad hoc strings,
  scattered booleans, or backend-specific conditionals.
- Keep product semantics above backend adapters. Backend code should transport
  commands and report capabilities; it should not redefine the agent-facing
  action model.
- Avoid duplicating Locator, DOM-CUA, or Coordinate CUA behavior separately in
  each backend when a shared substrate operation can own the logic.
- Make invalid, blocked, partial, cancelled, and failed states first-class code
  paths with tests, not incidental error strings.
- Preserve backward compatibility for Playwright-shaped APIs while adding
  environment-native APIs for richer action results.
- Keep privacy and locality constraints in the implementation, not only in
  product prose. Traces, observations, screenshots, and metrics remain local by
  default.

Code review should reject implementations that technically add a method but lose
the product model. For example, `tab.observe()` is not complete if it only
concatenates text, DOM, and screenshot data without request state, section
status, lifecycle metadata, and page-state validity.

## Context Preservation

The runtime must preserve enough context for an agent to continue reasoning
across actions, page transitions, and human takeover without pretending stale
state is current.

Every observation, action, and resume result should carry the relevant context
needed to validate continuity:

- session id and turn id
- tab id and target identity
- URL, route, document, and frame tree revisions when available
- viewport, scroll, focus, modal, and pointer revisions when available
- ownership and commandability state
- observation id and lifecycle state
- page-state hash or equivalent compatibility token
- invalidated observation ids after state-changing actions
- structured reason when continuity cannot be proven

The implementation should pass this context through the typed operation layer
instead of requiring each caller or backend to rediscover it. If a click opens a
new subpage, triggers a soft navigation, replaces a frame, changes focus, or
hands control to a human, the next action should be based on a fresh or validated
observation rather than inherited assumptions.

This is the main quality guardrail: do not let convenience APIs erase the state
that makes the environment reliable for agents.

## Implemented State Machine Relationship Map

The initial runtime slice has several related state machines. They should be
read together, not as isolated enums.

```text
Tab ownership and backend capability
  -> observe preflight and section availability
  -> TabObservation.lifecycle = fresh | invalid | discarded
  -> action preflight validates ownership, capability, observation, pointer
  -> action execution updates pointer and invalidates consumed observations
  -> next observe reports the new pointer, ownership, and lifecycle context
```

### Observe Request State

The observe request state machine tracks the request lifecycle:

```text
requested
  -> preflight
  -> reading_backend
  -> composing_snapshot
  -> succeeded | partial | blocked | failed | cancelled
```

`observe()` may run while the tab is human-controlled because observation is
read-only product context. It must still report ownership and commandability so
action preflight can block later side effects.

### Observation Lifecycle State

The observation lifecycle tracks whether a previously returned observation may
still be used:

```text
fresh
  -> invalid(stale | expired | consumed)
  -> discarded
```

`observe()` creates `fresh` lifecycle records. Action preflight may invalidate a
record as `stale` or `expired`. Successful observation-scoped actions invalidate
the record as `consumed`. Once invalid, the same observation id must fail before
browser side effects.

### Action Runtime State

The action runtime state machine consumes the other state machines:

```text
planned
  -> preflight
  -> running
  -> waiting_for_effect
  -> reconciling
  -> succeeded

preflight -> blocked
running | waiting_for_effect | reconciling -> failed | cancelled
```

Preflight is where product safety belongs. It must reject non-commandable tabs,
unsupported action substrate methods, missing or invalid observations, stale
observation evidence, and stale pointer state before dispatching browser input.
Only after preflight succeeds may Locator, DOM-CUA, or Coordinate CUA reach the
backend substrate.

### Pointer State

The pointer state is shared at browser-runtime scope and is observed through
tabs:

```text
unknown or absent
  -> idle(agent, visible)
  -> stale(unknown, hidden)
```

Coordinate actions set a known pointer. DOM-CUA actions set it from the resolved
action point. Locator actions mark any known pointer stale when no action point
is reported. Human takeover and resume mark all shared pointer entries stale.
Coordinate pointer actions must either be based on a fresh observation or block
when the pointer is stale.

### Ownership And Commandability

Tab ownership is derived from host tab metadata:

```text
commandable tab -> claimed_by_agent
claimRequired non-commandable tab -> human_controlled
other non-commandable tab -> unclaimed
```

Ownership is observable context. Commandability is an action preflight gate.
This separation matters: agents may inspect a human-controlled page, but they
must not mutate it until the host resumes or claims command authority.

### Capability State

Backend capability state is a substrate signal:

```text
supported method -> action may pass capability preflight
unsupported method -> action blocks before side effects
unknown method -> action may try legacy-compatible paths
```

When a backend provides an explicit `supported_methods` matrix, absent methods
are treated as unsupported for environment-native action preflight. This keeps
`observe().actionFamilies` and `tab.step()` consistent: an action family cannot
be advertised as usable while its exact action method would still fall through
to transport.

### Cross-Layer Lifecycle Contract

The SDK action and observe state machines sit above several lower lifecycle
machines. These lower machines are not implementation trivia; they are the
events that decide whether an agent may trust old state.

The contract is:

```text
Runtime descriptor / setup
  -> Native host / extension transport
  -> Browser session and turn lifecycle
  -> Tab ownership lifecycle
  -> Observe lifecycle
  -> Action lifecycle
  -> Finalize / cleanup lifecycle
  -> Host registry diagnostics
  -> SDK-facing result and next observe
```

Each layer must preserve the same product invariant: an agent may act only on
state that is current, owned, commandable, and supported by the substrate. If
any layer cannot prove continuity, the SDK-facing state must become `stale`,
`blocked`, `partial`, `failed`, `yielded`, or `repair_required`. It must not
silently continue with stale observation ids, stale DOM-CUA node ids, stale
coordinates, stale tab ownership, or stale runtime descriptors.

The lifecycle responsibilities are:

- Runtime descriptor / setup publishes the local WebExtension runtime endpoint
  and drops it when the native loop stops. SDK discovery must treat a dropped
  descriptor as loss of substrate continuity.
- Native host / extension transport owns connection, hello, heartbeat,
  reconnect, version mismatch, stop, and cleanup states. Pending requests,
  hello-pending, and reconnect-pending states block extension reload and should
  surface as substrate health context, not as page-action semantics.
- Browser session / turn lifecycle owns `open`, `yielded`, `finalizing`,
  `ended`, `ended_partial`, and `failed` turns. A yielded or finalizing turn
  cannot accept mutating actions.
- Tab ownership lifecycle owns whether a tab is agent-owned, claimable, owned
  by another session, handoff, deliverable, removed, or replaced. Observation may
  still read safe context, but action preflight must block non-commandable tabs.
- Observe lifecycle owns freshness of planning input. It scopes DOM-CUA node ids
  and coordinate evidence to the observation that produced them.
- Action lifecycle owns preflight, execution, effect wait, reconciliation, and
  typed result. It consumes or invalidates observations after state-changing
  actions.
- Finalize / cleanup lifecycle owns close, release, handoff, deliverable, and
  failure summaries. It marks SDK pointer continuity stale because browser
  control has crossed a cleanup boundary.
- Host registry lifecycle owns stale tabs, deliverables, active tab repair,
  stale file chooser/download handles, and bounded diagnostics. It preserves
  deliverables and diagnostics locally so resume and `deliverables()` have
  enough context.
- Extension update lifecycle waits for idle when browser control, native
  requests, native hello/reconnect, overlays, debugger locks, or active session
  tabs are present. Reload may happen only after those blockers are gone or a
  deliberate recovery path is chosen.
- SDK-facing lifecycle returns session id, turn id, tab id, ownership,
  observation id, pointer state, invalidated observations, and state traces so
  the model does not need to infer hidden runtime state.

These machines should fail closed together. For example, a click that opens a
new subpage invalidates the old observation; a human takeover marks pointer
state stale and makes owned tabs non-commandable; a resume keeps the tab
recoverable but requires revalidation; finalize marks cursor continuity stale
and preserves deliverables; native reconnect or pending extension update
prevents reload from racing the agent's active turn.

## Current Architectural Problem

Open Browser Use currently has the right building blocks, but some product
semantics leak through backend boundaries.

Before this implementation slice:

- Locator operations are supported by both CDP and WebExtension backends.
- Coordinate CUA is supported by both CDP and WebExtension backends.
- DOM-CUA is implemented only in the WebExtension backend capability matrix.
- WebExtension DOM-CUA already uses CDP-style commands such as
  `Page.getLayoutMetrics`, `DOM.getDocument`, `DOM.scrollIntoViewIfNeeded`,
  `DOM.getContentQuads`, and `DOM.getBoxModel`.
- DOM-CUA actions then resolve `node_id` into a viewport point and dispatch
  Coordinate CUA.

That means DOM-CUA was not conceptually WebExtension-only; it was WebExtension-only
because the implementation lived in the WebExtension backend instead of a shared
typed operation layer. The implementation now treats CDP and WebExtension as
CDP-bearing substrates and routes DOM-CUA read/action through shared host runtime
logic where the required CDP DOM and Coordinate CUA operations exist.

The target architecture should be:

```text
Agent JavaScript
  -> SDK facade
    -> observe/action typed operation layer
      -> shared DOM/locator/coordinate runtimes
        -> CDP-bearing backend substrate
          -> WebExtension via chrome.debugger
          -> CDP via DevTools WebSocket
          -> future in-app browser backend via its CDP-like target
```

Backend kind should describe transport and environment capabilities. It should
not determine whether the agent has a Locator, DOM-CUA, or Coordinate CUA mental
model unless the backend truly lacks the required substrate capability.

## Product-Level Operation Paths

The agent-facing page operation layer should have three primary paths.

### Locator

Locator is the semantic selector path.

Examples:

```ts
await tab.getByRole("button", { name: "Submit" }).click();
await tab.locator("input[name=email]").fill("a@example.com");
```

Runtime shape:

```text
selector intent
  -> Playwright selector / injected runtime
  -> actionability and action point
  -> Coordinate CUA or typed DOM operation
  -> action result
```

Locator should be the preferred path when the page has stable structure and the
agent can express the target semantically.

### DOM-CUA

DOM-CUA is the visible DOM affordance path.

Examples:

```ts
const dom = await tab.dom_cua.get_visible_dom({ format: "compact_text" });
await tab.dom_cua.click("12345");
```

Runtime shape:

```text
visible DOM snapshot
  -> interesting node extraction
  -> observation-scoped node_id
  -> backendNodeId validation
  -> action point resolution
  -> Coordinate CUA
  -> action result
```

DOM-CUA should be backend-shared wherever the backend can execute the needed CDP
DOM commands. It should not remain WebExtension-only unless the selected backend
cannot provide DOM document, geometry, and input dispatch primitives.

### Coordinate CUA

Coordinate CUA is the direct human-like input path.

Examples:

```ts
await tab.cua.move(120, 300);
await tab.cua.click(120, 300);
await tab.cua.drag({ x: 100, y: 100 }, { x: 300, y: 300 });
```

Runtime shape:

```text
viewport coordinate intent
  -> pointer preflight
  -> CDP Input.* dispatch
  -> pointer state update
  -> action result
```

Coordinate CUA should remain the lowest-level recommended action path. Raw CDP is
still available as an explicit escape hatch, but it should not be the normal
agent-facing action abstraction.

## Action Selection Policy

The three action paths should form an action ladder, not an unordered toolbox.
The SDK can expose all three, but the environment should guide agents toward the
most stable path that is currently valid.

Default selection policy:

1. Prefer Locator when the target can be expressed semantically and the selector
   is actionability-checked.
2. Prefer DOM-CUA when the target is visible and actionable but semantic
   selectors are unavailable, ambiguous, or likely to be unstable.
3. Use Coordinate CUA when the task requires human-like pointing, visual
   alignment, canvas interaction, drag gestures, or another affordance that
   cannot be represented safely by Locator or DOM-CUA.
4. Use raw CDP only as a policy-gated diagnostic or compatibility escape hatch.

This keeps the product taste aligned with the agent-environment thesis: the
agent should be helped toward robust, inspectable actions first, and should fall
back to more human-like or lower-level actions only when the environment proves
that the higher-level path is unavailable or unsafe.

## Observe First

`observe` should be implemented before the action layer is broadened. Without a
first-class observation object, every action path invents its own partial view of
state.

The initial API can be:

```ts
const observation = await tab.observe({
  mode: "compact" | "actionable" | "visual",
});
```

The first version should return:

- `observationId`
- `createdAt`
- tab id, URL, title, load state
- supported action families and capability summary
- ownership and commandability
- lifecycle and human takeover state
- viewport and scroll metadata
- pointer state
- focused element summary when available
- visible text summary
- DOM-CUA affordances when available
- locator-friendly hints when available
- optional screenshot resource in visual mode
- diagnostics and advisories
- diagnostic backend metadata when useful for debugging

Observation output must be compact by default. It should summarize rather than
dump the page.

## Observe State Machine

`observe()` should have its own request state machine. Observation is the
agent's planning input, so failures and partial results must be explicit rather
than hidden behind empty strings or missing affordances.

```text
requested
  -> preflight

preflight
  -> blocked
  -> reading_backend
  -> failed
  -> cancelled

reading_backend
  -> composing_snapshot
  -> partial
  -> failed
  -> cancelled

composing_snapshot
  -> succeeded
  -> partial
  -> blocked
  -> failed
  -> cancelled
```

`requested`, `preflight`, `reading_backend`, and `composing_snapshot` are
transient states. `succeeded`, `partial`, `blocked`, `failed`, and `cancelled`
are terminal request outcomes.

Preflight checks should include:

- tab existence
- substrate session health
- tab ownership and read permission
- current lifecycle state
- page load state
- current-origin, history, screenshot, or sensitive-surface policy
- requested observe mode and required capability

`partial` is a valid result, not an exceptional state. For example:

- text and lifecycle metadata may succeed while screenshot capture is blocked
- visible text may succeed while DOM-CUA affordance extraction fails
- tab metadata may succeed while page execution context is temporarily gone
- ownership may be readable while the tab is not commandable

The result should report which sections are present and which failed:

```ts
type ObservationResult = {
  observationId: string;
  status: "succeeded" | "partial" | "blocked" | "failed" | "cancelled";
  createdAt: number;
  lifecycle: ObservationLifecycle;
  sections: {
    tab?: SectionStatus;
    lifecycle?: SectionStatus;
    viewport?: SectionStatus;
    pointer?: SectionStatus;
    focus?: SectionStatus;
    text?: SectionStatus;
    domCua?: SectionStatus;
    screenshot?: SectionStatus;
    diagnostics?: SectionStatus;
  };
  data?: Observation;
  error?: {
    code: string;
    message: string;
    data?: unknown;
  };
};

type SectionStatus = {
  status: "present" | "omitted" | "blocked" | "failed";
  reason?: string;
};
```

This gives agents a reliable contract: they can plan with present sections,
request a narrower observe mode, or choose a safer action path when a section is
blocked or invalid.

## Observation And Affordance State

Observations need an explicit lifecycle.

```text
creating
  -> fresh

fresh
  -> invalid
  -> discarded

invalid
  -> discarded
```

Lifecycle meanings:

- `creating`: the observe request is still reading and composing state.
- `fresh`: the observation reflects the current tab state and can be used for
  planning and observation-scoped affordance actions.
- `invalid`: the observation must not be used for observation-scoped actions.
  The reason explains whether it became stale, expired, or consumed.
- `discarded`: the runtime or caller intentionally dropped the observation.

An observation becomes `invalid` with reason `stale` after:

- navigation
- same-document route change, such as SPA `pushState` or hash-route changes
- reload
- main-frame document replacement
- child-frame navigation when the observation included that frame
- DOM mutation that affects the target node or geometry
- modal, dropdown, or dialog state change
- scroll or viewport change when geometry matters
- focus change when the planned action depends on focused input state
- human takeover
- resume after takeover unless validated
- timeout when the timeout is caused by an observed state change or uncertainty
- any action that reports `invalidatesObservation: true`

An observation becomes `invalid` with reason `expired` when it is too old to use
even if no explicit state change was observed.

An observation should become `invalid` with reason `consumed` after an
environment-native action uses an observation-scoped affordance and the action
can change page state, geometry, focus, or pointer position. Read-only actions
may keep the observation fresh.

Each observation should carry lifecycle metadata:

```ts
type ObservationLifecycle = {
  state: "creating" | "fresh" | "invalid" | "discarded";
  createdAt: number;
  expiresAt: number;
  pageStateHash?: string;
  tabRevision?: string;
  frameTreeRevision?: string;
  documentRevision?: string;
  routeRevision?: string;
  viewportRevision?: string;
  pointerRevision?: string;
  focusRevision?: string;
  domCuaRevision?: string;
  modalRevision?: string;
  invalidatedAt?: number;
  invalidity?: {
    reason: "stale" | "expired" | "consumed";
    detail?: string;
  };
  consumedByActionId?: string;
};
```

The important rule is that an observation is not just tied to time. It is tied
to the page state that produced it. A click may move the browser to a new
subpage, trigger a soft navigation, open a modal, change the frame tree, or
replace large parts of the DOM without a full reload. In those cases, old text,
node ids, bounds, and actionability hints can actively mislead the agent.

For action preflight, the runtime should compare the referenced observation's
page-state metadata with the current tab state:

```ts
type ObservationValidity = {
  usable: boolean;
  mode: "exact" | "semantic_only" | "invalid";
  invalidityReason?: "stale" | "expired" | "consumed";
  reason?: string;
  changed:
    | "none"
    | "navigation"
    | "soft_navigation"
    | "document"
    | "frame_tree"
    | "dom"
    | "geometry"
    | "focus"
    | "modal"
    | "human_takeover"
    | "unknown";
};
```

Validity should be strict for DOM-CUA node ids and Coordinate CUA bounds. If the
page state changed, those references should fail closed and require a fresh
`observe()`. Locator-derived semantic hints may degrade to `semantic_only` when
the selector is still meaningful, but observation-scoped node ids and coordinates
must not be reused across page-state changes.

Affordance identifiers should be scoped to an observation:

```ts
type AffordanceRef = {
  observationId: string;
  nodeId?: string;
  locator?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  source: "dom-cua" | "locator" | "visual" | "browser";
  validity: "current_observation_only";
};
```

The runtime should reject invalid affordance references with a structured error
instead of trying to execute an action against a silently invalid page state.

## Action Layer Abstraction

The action layer should expose environment-native operations without breaking
existing Playwright-shaped APIs.

Keep low-level methods backward-compatible:

- `locator.click()` can continue returning `void`.
- `tab.cua.click()` can continue returning `void`.
- `tab.dom_cua.click()` can still be awaited and ignored by existing callers; it
  may return substrate metadata such as the resolved action point for
  environment-native result reconciliation.

Add a new environment-native action surface:

```ts
const result = await tab.step({
  kind: "dom_cua.click",
  observationId,
  nodeId,
});
```

or:

```ts
const result = await tab.act.click({
  source: "dom-cua",
  observationId,
  nodeId,
});
```

The exact SDK shape can be decided later. The invariant is that this layer
returns an action result.

All three primary action paths should normalize into one internal action shape:

```ts
type EnvAction = {
  actionId: string;
  kind: string;
  target:
    | { source: "locator"; selector: string }
    | { source: "dom-cua"; observationId: string; nodeId: string }
    | { source: "coordinate"; x: number; y: number };
  policy: {
    mayNavigate?: boolean;
    mayDownload?: boolean;
    mayOpenFileChooser?: boolean;
    requiresHumanHandoff?: boolean;
  };
};
```

This keeps the SDK mental model stable even while the backend transport changes.
The backend adapter should receive a typed action plus substrate context, not a
product-specific branch such as "DOM-CUA only works on WebExtension."

## Action State Machine

Every environment-native action should move through a common state machine.

```text
planned
  -> preflight

preflight
  -> blocked
  -> running
  -> failed
  -> cancelled

running
  -> waiting_for_effect
  -> failed
  -> cancelled

waiting_for_effect
  -> reconciling
  -> failed
  -> cancelled

reconciling
  -> succeeded
  -> failed
  -> cancelled
```

`planned`, `preflight`, `running`, `waiting_for_effect`, and `reconciling` are
transient states. `succeeded`, `blocked`, `failed`, and `cancelled` are terminal
action outcomes. A blocked action must fail before side effects. A failed action
may have partial side effects, so its result must include enough diagnostic and
state-delta information for the agent to choose the next step.

Preflight checks should include:

- required substrate capability
- session id and turn id
- tab ownership and commandability
- human takeover boundary
- current-origin or target-url policy
- upload, download, history, raw-CDP, or permission policy
- observation validity when the action references an observation
- pointer state validity for coordinate actions

The action result should include:

```ts
type ActionResult = {
  actionId: string;
  kind: string;
  status: "succeeded" | "failed" | "blocked" | "cancelled";
  effect:
    | "navigation"
    | "dom_changed"
    | "pointer_moved"
    | "input_dispatched"
    | "download_started"
    | "filechooser_opened"
    | "dialog_blocked"
    | "no_visible_change"
    | "unknown";
  before?: ObservationSummary;
  after?: ObservationSummary;
  pointer?: AgentPointerState;
  invalidatedObservations?: string[];
  handles?: unknown[];
  diagnostics?: unknown[];
  advisories?: string[];
  error?: {
    code: string;
    message: string;
    data?: unknown;
  };
};
```

The first implementation does not need a full `after` observation for every
action. It can return a small after-summary and let callers request a full
`observe()` when needed.

## Pointer State Machine

The pointer should become a first-class environment state, not only a visual
overlay memory.

```ts
type AgentPointerState = {
  sessionId: string;
  turnId: string;
  tabId: string;
  x: number;
  y: number;
  coordinateSpace: "visualViewport" | "layoutViewport";
  viewportRevision?: string;
  phase: "idle" | "moving" | "pressed" | "dragging" | "released" | "stale";
  buttonsDown: Array<"left" | "right" | "middle">;
  modifiers: string[];
  source: "agent" | "human" | "unknown";
  visible: boolean;
  updatedAt: number;
  staleReason?: string;
};
```

Pointer transitions:

```text
idle
  -> moving
  -> idle

idle
  -> pressed
  -> dragging
  -> released
  -> idle

any
  -> stale
```

The pointer becomes stale after:

- human takeover
- resume with changed viewport or page geometry
- tab navigation or reload
- tab replacement
- content script reinjection without successful reassertion
- drag or press failure where release could not be proven
- any Locator action that may move or affect the cursor without reporting the
  resulting action point

During `yieldControl()`, the runtime should release or mark stale any non-idle
pointer state. During `resumeControl()`, the runtime should rehydrate the visual
cursor only if the pointer state is still valid. Otherwise it should report
`pointer.staleReason` and require a fresh observation before coordinate actions.

## Ownership And Commandability State Machine

Human takeover and resume need a page-level state machine that action preflight
can trust.

```text
unclaimed
  -> claimed_by_agent

claimed_by_agent
  -> yielding_to_human
  -> released
  -> lost

yielding_to_human
  -> human_controlled
  -> lost

human_controlled
  -> resuming_agent
  -> lost

resuming_agent
  -> claimed_by_agent
  -> lost
```

State meanings:

- `unclaimed`: the tab exists but this runtime turn does not own command
  authority.
- `claimed_by_agent`: actions may execute after normal preflight.
- `yielding_to_human`: the runtime is releasing locks, pointer state, and
  overlays.
- `human_controlled`: the runtime must observe but not mutate without a new
  claim.
- `resuming_agent`: the runtime is checking whether tab, URL, viewport, document,
  focus, and pointer state are still compatible with the prior turn.
- `released`: the agent intentionally ended control.
- `lost`: the tab, substrate session, extension connection, or command authority
  disappeared unexpectedly.

`observe()` should always report ownership and commandability. Actions should
fail at preflight while the tab is `unclaimed`, `yielding_to_human`,
`human_controlled`, `resuming_agent`, `released`, or `lost`.

Resume should not pretend continuity when the environment changed. It should
return a resume summary:

```ts
type ResumeSummary = {
  commandable: boolean;
  sameTab: boolean;
  sameUrl: boolean;
  sameDocument?: boolean;
  viewportCompatible: boolean;
  focusedElementChanged?: boolean;
  pointerUsable: boolean;
  invalidatedObservations: string[];
  reason?: string;
};
```

If the summary is not fully compatible, the next agent step should be a fresh
`observe()` rather than continuing from old affordance ids or cursor state.

## Backend Substrate Contract

The shared typed operation layer needs a smaller backend interface than the
current high-level backend split.

This section is implementation-facing. The agent-facing SDK should expose
capabilities, affordances, blocked reasons, and diagnostics. It should not ask
the agent to branch on backend kind for normal planning. Backend kind belongs in
debug diagnostics, not in the primary observation contract.

Required substrate capabilities:

```rust
trait BrowserCommandSubstrate {
    async fn execute_cdp_with_context(...);
    async fn dispatch_coordinate_cua_with_context(...);
    async fn current_url_for_policy(...);
    fn capabilities(...);
}
```

Optional extension-environment capabilities:

- cursor overlay
- input lock
- human takeover UI
- tab group presentation
- virtual clipboard
- profile history
- extension update idle state

DOM-CUA should depend on the required substrate capabilities, not on the
WebExtension backend type.

## Shared DOM-CUA Runtime

The WebExtension DOM-CUA implementation is lifted into a shared runtime module
for the DOM/geometry/action path.

Implemented module:

```text
crates/obu-host/src/ops/dom_cua_runtime.rs
```

Shared responsibilities:

- get viewport layout metrics
- get DOM document
- collect visible and interesting nodes
- exclude OBU overlay nodes
- render compact/debug/text formats
- create observation-scoped node ids
- cache current visible DOM snapshot by session/tab/observation
- validate observation-scoped node ids against the matching observation snapshot
- scroll node into view
- resolve node to action point through content quads or box model
- call Coordinate CUA for click, double click, scroll, type, and keypress

Backend-specific responsibilities:

- how CDP commands are transported
- how coordinate input is dispatched
- whether cursor overlay and input lock are available
- whether media download helpers require extension-only APIs

## Capability Matrix Target

Target state:

| Action path | CDP | WebExtension | Notes |
| --- | --- | --- | --- |
| Locator | supported | supported | Shared Playwright-shaped runtime over CDP commands |
| Coordinate CUA | supported | supported | Shared CDP Input.* semantics; WebExtension adds overlay/input lock |
| DOM-CUA read/action | supported | supported | Shared DOM-CUA runtime over CDP DOM.* and Coordinate CUA |
| DOM-CUA media download | maybe unsupported initially | supported | Keep separate if extension APIs are still required |
| Raw CDP | supported | supported | Explicit escape hatch, policy-gated |

`wire/methods.json` should eventually advertise DOM-CUA as implemented for CDP
and WebExtension once the shared runtime and tests are in place.

## Implementation Order

### Phase 0: Pin Current Behavior

- Add or update docs describing the current operation paths and backend support.
- Add tests proving CDP currently rejects DOM-CUA with
  `unsupported_backend_capability`.
- Add tests proving WebExtension DOM-CUA still works.

### Phase 1: Add Minimal `observe`

- Add SDK `tab.observe({ mode })`.
- Return tab metadata, lifecycle state, capability summary, ownership and
  commandability, pointer state stub, visible text, and optional DOM-CUA summary
  where supported.
- Add observe request states, section status, partial results, observation ids,
  and observation lifecycle metadata.
- Include page-state metadata such as tab, frame tree, document, route,
  viewport, pointer, focus, and modal revisions where available.

### Phase 2: Extract Shared DOM-CUA Runtime

- Move DOM-CUA collection, rendering, node validation, and action-point
  resolution out of `WebExtensionBackend`.
- Keep WebExtension behavior unchanged through the shared runtime.
- Add shared unit tests around snapshot filtering, node ids, and geometry.

### Phase 3: Enable DOM-CUA On CDP

- Implement the shared DOM-CUA substrate for `CdpBackend`.
- Update capability matrix for the DOM-CUA methods that now work on CDP.
- Keep media download helpers separate if they still need WebExtension-only
  behavior.

### Phase 4: Add Environment-Native Action Results

- Introduce `tab.step(...)` or `tab.act.*` with `ActionResult`.
- Preserve existing low-level method return values.
- Implement state delta for the three page operation paths.

### Phase 5: Add Pointer State

- Track pointer state in session/tab state, not only overlay state.
- Update pointer state from Locator, DOM-CUA, Coordinate CUA, and raw
  `Input.dispatchMouseEvent`.
- Mark pointer stale across takeover, resume, navigation, viewport changes, and
  unproven drag release.

### Phase 6: Integrate Observe And Action

- Actions that reference an observation must validate observation lifecycle and
  page-state compatibility.
- Actions should report which observations they invalidated.
- `observe()` should return pointer state and action affordances.
- Human takeover/resume should return whether the previous pointer and
  affordances are still usable.

### Phase 7: Update Product Strategy Doc

- After `observe`, shared action abstraction, and state-machine boundaries are
  documented here, update `docs/agent-environment-product-logic-and-optimization.md`
  to reference this architecture rather than repeating low-level implementation
  detail.

## Acceptance Criteria

- The three primary page action paths are documented and capability-gated.
- The action selection policy prefers Locator, then DOM-CUA, then Coordinate CUA,
  with raw CDP as a policy-gated escape hatch.
- `observe()` exists as the first-class planning state API, with request states,
  section status, partial result semantics, and lifecycle metadata.
- Observation validity is tied to page state, not only elapsed time.
- DOM-CUA implementation is shared between CDP and WebExtension wherever the CDP
  substrate is sufficient.
- Unsupported paths fail before side effects with structured capability errors.
- Observation-scoped affordance ids cannot be used silently after they become
  invalid.
- Pointer state is explicit and survives or invalidates correctly across
  takeover and resume.
- Observation, action, pointer, and ownership state transitions are represented
  in code and covered by focused tests.
- Action and observe results preserve the context needed to validate continuity
  across navigation, soft navigation, frame changes, focus changes, and human
  takeover.
- Backend adapters do not duplicate or redefine product-level action semantics
  when shared typed operations can own the behavior.
- Low-level Playwright-shaped APIs remain backward-compatible.
- Environment-native action APIs return structured action results.

## Non-Goals

- Do not replace the `js` MCP entrypoint with many low-level MCP tools.
- Do not make raw CDP the normal agent-facing action API.
- Do not remove WebExtension-specific environment advantages such as cursor
  overlay, input lock, tab groups, virtual clipboard, or profile history.
- Do not upload traces, observations, screenshots, or metrics by default.
