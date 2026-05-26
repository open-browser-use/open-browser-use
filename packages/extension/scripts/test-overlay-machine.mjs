import assert from "node:assert/strict";

import {
  parseCursorArrival,
  planContentScriptPreparation,
  planCursorArrival,
  planOverlayActivation,
  planOverlayReleaseRequest,
  planOverlayReleaseResult,
  planOverlayReplacement,
} from "../dist/lifecycle/overlay_machine.js";

const savedCursor = { x: 10, y: 20, sequence: 3 };
assert.deepEqual(planOverlayActivation({
  sessionId: "session",
  turnId: "turn",
  savedCursor,
  rehydrateCursor: true,
}), {
  state: {
    sessionId: "session",
    turnId: "turn",
    lockInputs: true,
    lastCursor: savedCursor,
  },
  sendSavedCursor: true,
});

const previous = {
  sessionId: "old-session",
  turnId: "old-turn",
  lockInputs: true,
  lastCursor: { x: 1, y: 2, sequence: 9 },
};
assert.deepEqual(planOverlayActivation({
  previous,
  sessionId: "session",
  turnId: "turn",
  savedCursor,
  rehydrateCursor: false,
}), {
  state: {
    sessionId: "session",
    turnId: "turn",
    lockInputs: true,
    lastCursor: previous.lastCursor,
  },
  sendSavedCursor: false,
});

assert.deepEqual(planOverlayReplacement(undefined), { kind: "drop" });
assert.deepEqual(planOverlayReplacement(previous), { kind: "replace", state: previous });

const releasePlan = planOverlayReleaseRequest({ kind: "active", takeover: previous });
assert.deepEqual(releasePlan, {
  kind: "send_hide",
  next: { kind: "release_pending", takeover: previous },
});
assert.deepEqual(planOverlayReleaseRequest(undefined), { kind: "noop" });
assert.deepEqual(planOverlayReleaseResult(releasePlan.next, false), releasePlan.next);
const failedReleasePlan = planOverlayReleaseRequest(releasePlan.next);
assert.deepEqual(failedReleasePlan, {
  kind: "send_hide",
  next: { kind: "release_failed", takeover: previous, failures: 1 },
});
assert.deepEqual(planOverlayReleaseResult(failedReleasePlan.next, false), failedReleasePlan.next);
assert.deepEqual(planOverlayReleaseResult(releasePlan.next, true), undefined);
assert.deepEqual(planOverlayReleaseResult({ kind: "active", takeover: previous }, true), {
  kind: "active",
  takeover: previous,
});

assert.deepEqual(parseCursorArrival(null), undefined);
assert.deepEqual(parseCursorArrival({ sequence: "1" }), undefined);
assert.deepEqual(parseCursorArrival({ sequence: 1, sessionId: "s", turnId: "t" }), {
  sequence: 1,
  sessionId: "s",
  turnId: "t",
});

assert.deepEqual(planCursorArrival(undefined, { sessionId: "s", turnId: "t" }), { kind: "ignore" });
assert.deepEqual(planCursorArrival({ sequence: 1, sessionId: "s", turnId: "bad" }, {
  sessionId: "s",
  turnId: "t",
}), { kind: "ignore" });
assert.deepEqual(planCursorArrival({ sequence: 1, sessionId: "s", turnId: "t" }, {
  sessionId: "s",
  turnId: "t",
}), { kind: "arrived", sequence: 1 });

assert.deepEqual(planContentScriptPreparation({
  pingSucceeded: true,
  preparationPending: false,
}), { kind: "ready" });
assert.deepEqual(planContentScriptPreparation({
  pingSucceeded: false,
  preparationPending: true,
}), { kind: "await_pending" });
assert.deepEqual(planContentScriptPreparation({
  pingSucceeded: false,
  preparationPending: false,
}), { kind: "inject" });

{
  // Finding 21: overlay release must be bounded
  const { releaseFailedOverlayState, planOverlayReleaseRequest, OVERLAY_RELEASE_MAX_RETRIES } = await import("../dist/lifecycle/overlay_machine.js");
  const takeover = { sessionId: "s", turnId: "t", lockInputs: true };
  // verify constant is exported
  assert.equal(typeof OVERLAY_RELEASE_MAX_RETRIES, "number");
  // a release_failed state at MAX retries must move to release_abandoned on next plan
  const state = releaseFailedOverlayState(takeover, OVERLAY_RELEASE_MAX_RETRIES);
  const plan = planOverlayReleaseRequest(state);
  assert.equal(plan.kind, "release_abandoned", "after MAX retries release must reach a terminal repair state");
  assert.equal(plan.next.kind, "release_abandoned");
  assert.equal(plan.next.failures, OVERLAY_RELEASE_MAX_RETRIES);

  // a release_abandoned state planned again must be noop
  const abandonedPlan = planOverlayReleaseRequest(plan.next);
  assert.equal(abandonedPlan.kind, "noop");

  // release_failed below the cap still sends hide
  const stillTrying = planOverlayReleaseRequest(releaseFailedOverlayState(takeover, OVERLAY_RELEASE_MAX_RETRIES - 1));
  assert.equal(stillTrying.kind, "send_hide");
  assert.equal(stillTrying.next.kind, "release_failed");
  assert.equal(stillTrying.next.failures, OVERLAY_RELEASE_MAX_RETRIES);
}
