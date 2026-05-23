import assert from "node:assert/strict";

import {
  finalizeAction,
  finalizeFailure,
  parseFinalizeKeep,
  planFinalizeTabs,
} from "../dist/lifecycle/finalize_tabs_machine.js";

const agentTab = { tabId: 1, origin: "agent", status: "active" };
const userTab = { tabId: 2, origin: "user", status: "active" };
const defaultPlan = planFinalizeTabs(new Map([
  [agentTab.tabId, agentTab],
  [userTab.tabId, userTab],
]), new Map());

assert.deepEqual(
  defaultPlan.steps.map((step) => [step.tabId, step.origin, step.desiredStatus, step.effect]),
  [
    [1, "agent", "close", "close_agent_tab"],
    [2, "user", "release", "release_user_tab"],
  ],
);
assert.equal(defaultPlan.steps[0].row, agentTab);

const keep = parseFinalizeKeep({
  keep: [
    { tabId: 1, status: "handoff" },
    { target: { tabId: 2 }, status: "deliverable" },
  ],
});
assert.deepEqual([...keep], [
  [1, "handoff"],
  [2, "deliverable"],
]);

const keepPlan = planFinalizeTabs(new Map([
  [agentTab.tabId, agentTab],
  [userTab.tabId, userTab],
]), keep);
assert.deepEqual(
  keepPlan.steps.map((step) => [step.tabId, step.desiredStatus, step.effect]),
  [
    [1, "handoff", "keep_handoff"],
    [2, "deliverable", "keep_deliverable"],
  ],
);

assert.throws(
  () => parseFinalizeKeep({ keep: [{ tabId: 1, status: "handoff" }, { tabId: 1, status: "deliverable" }] }),
  /duplicate tab 1/,
);
assert.throws(
  () => parseFinalizeKeep({ keep: [{ tabId: 1, status: "active" }] }),
  /status must be handoff or deliverable/,
);
assert.throws(
  () => parseFinalizeKeep({ keep: [1] }),
  /entries must be objects/,
);

assert.deepEqual(
  finalizeAction(1, "agent", "close", "closed"),
  { tabId: 1, origin: "agent", desiredStatus: "close", outcome: "closed" },
);

assert.deepEqual(
  finalizeFailure(1, "close", "failed", new Error("dialog_requires_decision: confirm required")),
  {
    tabId: 1,
    desiredStatus: "close",
    outcome: "failed",
    errorCode: "dialog_requires_decision",
    errorMessage: "dialog_requires_decision: confirm required",
  },
);

assert.deepEqual(
  finalizeFailure(2, "release", "failed", new Error("command denied by policy")),
  {
    tabId: 2,
    desiredStatus: "release",
    outcome: "failed",
    errorCode: "command_disallowed",
    errorMessage: "command denied by policy",
  },
);

assert.deepEqual(
  finalizeFailure(undefined, undefined, "failed", "reconcile blew up", "finalize_reconciliation_failed"),
  {
    outcome: "failed",
    errorCode: "finalize_reconciliation_failed",
    errorMessage: "reconcile blew up",
  },
);
