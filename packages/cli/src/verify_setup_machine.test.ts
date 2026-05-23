import assert from "node:assert/strict";
import test from "node:test";

import { advanceVerifySetup, initialVerifySetupState } from "./verify_setup_machine.js";

test("verify setup machine starts with repair only for supported repair targets", () => {
  assert.deepEqual(initialVerifySetupState({ repairRequested: true, targetSupported: true }), { kind: "repairing" });
  assert.deepEqual(initialVerifySetupState({ repairRequested: true, targetSupported: false }), { kind: "checking_cli_install" });
  assert.deepEqual(initialVerifySetupState({ repairRequested: false, targetSupported: true }), { kind: "checking_cli_install" });
});

test("verify setup machine defines the setup probe order", () => {
  const effects = collectEffects(initialVerifySetupState({ repairRequested: false, targetSupported: true }));
  assert.deepEqual(effects, [
    "check_cli_install",
    "check_target_support",
    "check_native_host",
    "probe_runtime_descriptor",
    "resolve_profile",
    "check_browser_extension",
    "check_extension_runtime",
    "check_agent_config",
    "probe_mcp_runtime",
    "probe_agent_runtime",
    "select_terminal_action",
  ]);
});

test("verify setup machine includes repair before deterministic probes", () => {
  const effects = collectEffects(initialVerifySetupState({ repairRequested: true, targetSupported: true }));
  assert.deepEqual(effects.slice(0, 3), [
    "apply_repairs",
    "check_cli_install",
    "check_target_support",
  ]);
  assert.equal(effects.at(-1), "select_terminal_action");
});

function collectEffects(state: ReturnType<typeof initialVerifySetupState>): string[] {
  const effects: string[] = [];
  let current = state;
  for (;;) {
    const transition = advanceVerifySetup(current);
    if (!transition) return effects;
    effects.push(transition.effect.type);
    current = transition.state;
  }
}
