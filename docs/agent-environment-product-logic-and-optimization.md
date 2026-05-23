# Agent Environment Product Logic And Optimization

Date: 2026-05-23

## Product Thesis

Open Browser Use should be understood less as a browser automation library and
more as an interactive browser environment for agents.

The closest mental model is a reinforcement-learning-style environment:

1. The agent receives an observation of the browser state.
2. The agent chooses an action.
3. The environment applies the action.
4. The environment returns the next state and execution feedback.
5. The agent uses the feedback to plan the next action.

Open Browser Use should not define reward inside the browser tool layer. Reward
or task success should remain external and pluggable: it can come from the user,
the harness agent, an evaluator, a test assertion, or a benchmark. The product
should provide the state-action-feedback loop; the caller should define what
"good" means for a specific task.

A concise positioning statement:

> Open Browser Use is an RL-style browser environment for inference-time agents.
> It exposes browser state, action affordances, execution feedback, and
> recoverable control boundaries, while leaving reward and evaluation pluggable.

This framing matters because the core product is not "can the agent click a
button?" The core product is "can the agent reliably understand the browser
environment, choose a valid next action, recover from failures, and complete a
task with low token cost and low human intervention?"

## Why This Is Different From Browser Automation

Traditional browser automation libraries optimize for deterministic API calls:

- `click(selector)`
- `fill(selector, value)`
- `screenshot()`
- `evaluate(fn)`

Those APIs are useful, but they are not sufficient for an agent. An agent needs a
model-friendly environment contract:

- What is visible now?
- What can be acted on now?
- Which actions are valid, blocked, risky, or unavailable?
- What changed after the previous action?
- Did the action move the task forward, do nothing, or hit a boundary?
- Is the browser still owned by the agent, or has control moved to the user?
- If setup or runtime state is broken, what is the next repair action?

This means the highest-leverage product work is not adding more low-level browser
commands. It is making the browser environment more legible, more recoverable,
and more evaluable for agents.

## Current Product Logic

Open Browser Use already has the right foundation for this direction.

The current product shape is:

- MCP exposes a compact JavaScript execution surface through `obu mcp stdio`.
- The trusted SDK installs a global `agent` inside the Node runtime.
- The SDK connects to the local host through the native-pipe bridge.
- The host routes browser commands through capability checks, local policy,
  session and turn ownership, and backend dispatch.
- Browser control can use either a CDP backend or the Chromium WebExtension
  backend.
- The WebExtension path preserves the user's browser profile, visible browser
  state, tab groups, and human takeover.
- `browser_status`, setup diagnostics, product errors, and repair hints make
  environment readiness observable before the agent attempts browser work.
- Screenshots and large payloads can spill to MCP resources instead of consuming
  the whole context window.

The important design choice is that browser side effects are not just SDK method
calls. They pass through local lifecycle machinery, host policy, session and turn
ownership, extension control boundaries, and structured diagnostics. That is the
correct direction for an agent environment.

The next step is to make the state-action-feedback contract more explicit and
more model-native.

## Environment Contract

The product should converge on this contract:

1. Observations are compact, truthful, and task-relevant.
2. Action affordances are explicit.
3. Action preconditions are checked before side effects.
4. Every browser-affecting transition has one authority.
5. Each action returns structured feedback about what changed.
6. Failures include enough information for the agent to choose a next action.
7. Human takeover is represented as external controller ownership, not prompt
   guidance.
8. Reset, repair, and resume paths are executable and diagnostic.
9. Episode traces are available for debugging, evaluation, and improvement.
10. Reward and success evaluation stay pluggable above the browser layer.

## Optimization Priorities

### 1. Add A Unified Observation API

Current observations are spread across text snapshots, DOM-CUA, locators,
screenshots, diagnostics, tab metadata, and capability data. Agents must decide
which one to call and how to combine them.

Add a first-class API such as:

```ts
await tab.observe({
  mode: "compact" | "actionable" | "visual",
});
```

The result should combine the browser state that an agent needs for planning:

- Observation id or version.
- URL, title, load state, and navigation state.
- Ownership and commandability.
- Visible text summary.
- Focused element.
- Scroll position and viewport metadata.
- Dialog, permission, download, or file chooser state.
- Relevant lifecycle diagnostics.
- Optional screenshot resource.
- Optional actionable DOM summary.

The goal is not to dump the page. The goal is to produce a compact planning
state.

### 2. Make Action Affordances Explicit

A browser environment should tell the agent what can be done next. The
observation should include affordances such as:

- Clickable elements.
- Fillable fields.
- Selectable controls.
- Checked or unchecked toggles.
- Menus and listboxes.
- Scrollable regions.
- Navigation actions.
- Blocked actions that require claim, user permission, human takeover, or dialog
  resolution.

Each affordance should include stable identifiers for the current observation,
visible labels, roles, bounding boxes when available, and a recommended action
shape. Affordance identifiers are not globally durable. They should carry the
`observationId`, source, and validity conditions, and they should expire after
navigation, DOM mutation, modal or dropdown changes, scroll changes when
geometry matters, timeout, or any action that reports a state change. This
reduces invalid selectors, repeated DOM probing, and blind visual clicking
without pretending that browser state is static.

### 3. Return State Delta From Actions

Many browser automation APIs return `void` after an action. That forces the agent
to spend another observation call just to discover what happened.

Low-level Playwright-shaped primitives should remain backward-compatible.
Environment-native action surfaces should return transition feedback. That can
be a new `tab.step(...)` API, `tab.act.*` helpers, or an explicit option such as
`observeAfter: true`, rather than changing every existing `click()` or `fill()`
return value.

```ts
{
  ok: true,
  effect: "navigation" | "dom_changed" | "download_started" | "dialog_blocked" | "no_visible_change",
  before: {
    url: "https://example.com/form"
  },
  after: {
    url: "https://example.com/success",
    title: "Success"
  },
  handles: [],
  advisories: []
}
```

This is the environment equivalent of `step(action) -> observation, info`.
Open Browser Use does not need to return reward, but it should return enough
transition information for an agent or harness to judge progress.

### 4. Keep Traces Local And Private

Episode traces are sensitive because they can include URLs, visible page text,
screenshots, form state, filenames, downloads, and user workflow details. Open
Browser Use should never upload traces, screenshots, metrics, or telemetry by
default. Traces should stay on the user's machine.

The trace contract should be:

- Local-only storage by default.
- Explicit user or harness action for any export.
- Clear retention and deletion APIs.
- Bounded artifact sizes.
- Redaction of secrets, passwords, tokens, and form values where possible.
- No cookie, password, local storage, or session storage capture as part of
  normal trace recording.
- Metrics derived locally from episodes and product errors.
- Aggregate reporting only when an external harness explicitly chooses to export
  data outside OBU.

This keeps trajectory recording useful for debugging and evaluation without
turning the browser runtime into a telemetry product.

### 5. Introduce Episode And Trajectory Recording

Agents need inspectable traces. A task should be representable as an episode:

```ts
const episode = await browser.startEpisode({ goal: "Book a meeting" });
```

The episode should record:

- Initial observation.
- Each action.
- Preconditions and policy decisions.
- Action result and state delta.
- Errors and product error codes.
- Screenshots or resource artifacts.
- Human takeover and resume events.
- Final state and deliverables.

This creates product leverage in several directions:

- Debug failed tasks.
- Reproduce bugs.
- Compare agent strategies.
- Build benchmark corpora.
- Generate local eval data.
- Improve documentation with real traces.

### 6. Add Pluggable Evaluation Hooks

Reward should stay outside OBU, but OBU should make evaluation easy.

Possible shape:

```ts
await episode.evaluate({
  assertions: [
    { type: "url_contains", value: "/success" },
    { type: "text_visible", value: "Order confirmed" }
  ]
});
```

Evaluation should support simple deterministic assertions first:

- URL matches.
- Text visible.
- Element visible or hidden.
- Download produced.
- File chooser completed.
- URL, title, load state, lifecycle idle, or another explicitly supported
  navigation state matched.
- Backend-advertised network tracking matched, if that capability exists.
- Tab marked as deliverable.

Later, custom evaluators can be layered on top by harnesses. The browser runtime
should expose the trace and final state; the harness can decide whether the task
succeeded.

### 7. Add Agent-Native High-Level Actions

The SDK should keep Playwright-shaped primitives, but the model-friendly path
should be shorter than hand-written low-level automation.

Useful high-level actions:

- `tab.act.clickByText(...)`
- `tab.act.fillForm({ ... })`
- `tab.act.extractTable(...)`
- `tab.act.chooseFromMenu(...)`
- `tab.act.downloadAfterClick(...)`
- `tab.act.submitAndObserve(...)`

These should compose existing locator, DOM-CUA, policy, retry, timeout, and
observation behavior. The goal is not to hide the browser. The goal is to encode
common action patterns with better defaults and better feedback.

### 8. Provide Annotated Visual Observations

`screenshotForModel()` is already the right direction. The next improvement is
an annotated screenshot observation:

- Screenshot resource.
- Element bounding boxes.
- Element IDs.
- Roles and labels.
- Clickability and fillability.
- Mapping from visual region to action affordance.

This is especially important for visual QA, complex web apps, canvas-heavy
interfaces, and pages where DOM text alone does not explain the task state.

### 9. Support Resumable Long Tasks

Current browser work is usually expected to finish inside one MCP tool call.
That is acceptable for short tasks, but realistic browser workflows can exceed a
single timeout or require user intervention.

A long-task model should support:

- Task handles.
- Progress events.
- Resource streaming.
- Cancellation.
- Resume after timeout.
- Resume after human takeover.
- Final episode export.

This should come after the common one-call workflow is reliable, but it is
important for production-grade agent use.

### 10. Productize Effect Metrics

OBU should measure the environment properties that actually improve agent
success:

- Task success rate.
- Average actions per successful task.
- Invalid action rate.
- Repeated observation rate.
- Error recovery success rate.
- Human intervention frequency.
- Token cost per task.
- Time spent in setup or repair.
- Backend parity failures.
- Long-task timeout frequency.

These metrics should be derived locally from episodes and product errors, not
from ad hoc logs alone. OBU should not upload these metrics by default.

## What Not To Optimize First

Avoid adding many low-level MCP tools such as separate `click`, `type`, `scroll`,
and `screenshot` tools. The current `js` plus SDK model is better for reducing
MCP round trips and composing multi-step browser work.

Avoid treating Playwright parity as the main product goal. Playwright-shaped APIs
are useful compatibility affordances, but Open Browser Use should be optimized
for agent reasoning, not for being a Playwright clone.

Avoid embedding a fixed reward function in the browser runtime. Different tasks
need different success criteria, and the harness should own evaluation.

Avoid pushing policy into a remote service as a default. The local-first design,
host-side policy, and explicit user control boundaries are core product
advantages.

## Suggested Roadmap

### Phase 1: Planning State

- Add `tab.observe()`.
- Add actionable affordances to observation output.
- Normalize observation shape across text, DOM-CUA, screenshot, tab metadata,
  lifecycle diagnostics, and capability data.
- Keep output compact by default.

### Phase 2: Transition Feedback

- Add environment-native action surfaces that return structured action results.
- Include effect classification, before/after state, handles, and advisories.
- Preserve current low-level return compatibility.

### Phase 3: Episodes

- Add episode start, append, finish, and export APIs.
- Persist trace data locally for debugging without uploading it, leaking secrets,
  or storing unbounded page content.
- Connect episode artifacts to MCP resources.
- Add retention, deletion, redaction, and explicit export controls.

### Phase 4: Evaluation

- Add deterministic assertion evaluators.
- Let harnesses attach custom evaluators.
- Make evaluation output part of the episode summary.

### Phase 5: High-Level Agent Actions

- Add `tab.act.*` helpers for common browser tasks.
- Implement them using observation, affordances, retries, policy checks, and
  action feedback.
- Prefer helpers that reduce invalid actions and repeated page reads.

### Phase 6: Long Tasks

- Add resumable task handles.
- Support progress, cancellation, resume, and final episode export.
- Keep this behind the already-stable short-task contract.

## Definition Of Product Success

The product is working when an agent can use the browser as a routine work
surface:

1. It can check readiness without guessing.
2. It can obtain a compact and truthful observation.
3. It can see valid next actions.
4. It can execute an action and understand what changed.
5. It can recover from setup, policy, lifecycle, timeout, and ownership failures.
6. It can hand control to a human and resume cleanly.
7. It can produce an inspectable episode trace.
8. A harness can evaluate success without OBU hardcoding reward.

In this framing, Open Browser Use is not primarily a browser automation tool. It
is a browser environment runtime for agents.
