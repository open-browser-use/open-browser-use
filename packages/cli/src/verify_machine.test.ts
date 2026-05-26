import assert from "node:assert/strict";
import test from "node:test";

import { computeVerifyReadiness, selectVerifyResultAndAction } from "./verify_machine.js";
import type { ActionCandidate, VerifyCheck } from "./verify.js";

test("verify machine reports ready when no required layer is blocked", () => {
  const checks = [
    check({ id: "cli", status: "pass", layer: "cli_install" }),
    check({ id: "agent", status: "not_checked", layer: "agent_runtime" }),
  ];
  const readiness = computeVerifyReadiness("cli", checks);
  assert.deepEqual(readiness, { cli: "ready", agentRuntime: "not_checked" });
  assert.deepEqual(selectVerifyResultAndAction("cli", readiness, checks), {
    result: "ready",
    nextAction: null,
  });
});

test("verify machine prioritizes CLI blockers before agent-runtime blockers", () => {
  const checks = [
    check({
      id: "runtime",
      layer: "agent_runtime",
      status: "fail",
      blocks: ["agent_runtime"],
      actionCandidate: candidate("needs_manual_action", "restart_agent", 1),
    }),
    check({
      id: "native",
      layer: "native_host",
      status: "fail",
      blocks: ["cli"],
      actionCandidate: candidate("needs_repair", "run_repair", 99),
    }),
  ];
  const readiness = computeVerifyReadiness("agent_runtime", checks);
  assert.deepEqual(readiness, { cli: "blocked", agentRuntime: "not_checked" });
  assert.deepEqual(selectVerifyResultAndAction("agent_runtime", readiness, checks), {
    result: "needs_repair",
    nextAction: { kind: "run_repair", message: "run_repair" },
  });
});

test("verify machine uses result, action, then layer priority within eligible blockers", () => {
  const checks = [
    check({
      id: "popup",
      layer: "runtime_descriptor",
      status: "fail",
      blocks: ["cli"],
      actionCandidate: candidate("needs_browser_popup", "open_popup", 99),
    }),
    check({
      id: "extension",
      layer: "browser_extension",
      status: "fail",
      blocks: ["cli"],
      actionCandidate: candidate("needs_manual_action", "install_extension", 5),
    }),
    check({
      id: "profile",
      layer: "browser_profile",
      status: "fail",
      blocks: ["cli"],
      actionCandidate: candidate("needs_manual_action", "select_profile", 4),
    }),
  ];
  const readiness = computeVerifyReadiness("cli", checks);
  assert.deepEqual(selectVerifyResultAndAction("cli", readiness, checks), {
    result: "needs_manual_action",
    nextAction: { kind: "select_profile", message: "select_profile" },
  });
});

test("verify machine returns manual unsupported action for unclassified blockers", () => {
  const checks = [
    check({ id: "blocked", layer: "target_support", status: "fail", blocks: ["cli"] }),
  ];
  const readiness = computeVerifyReadiness("cli", checks);
  assert.deepEqual(selectVerifyResultAndAction("cli", readiness, checks), {
    result: "needs_manual_action",
    nextAction: {
      kind: "unsupported",
      message: "Verification found a blocking state without an automated next action.",
    },
  });
});

function check(overrides: Partial<VerifyCheck> & Pick<VerifyCheck, "id" | "layer" | "status">): VerifyCheck {
  return {
    message: overrides.id,
    target: {},
    evidence: { scope: "cli", provenance: "not_applicable", source: "test" },
    ...overrides,
  };
}

function candidate(
  result: ActionCandidate["result"],
  kind: ActionCandidate["kind"],
  priority: number,
): ActionCandidate {
  return {
    result,
    kind,
    priority,
    message: kind,
  };
}
