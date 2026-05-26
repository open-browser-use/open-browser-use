export type VerifySetupState =
  | { kind: "repairing" }
  | { kind: "checking_cli_install" }
  | { kind: "checking_target_support" }
  | { kind: "checking_native_host" }
  | { kind: "probing_runtime_descriptor" }
  | { kind: "resolving_profile" }
  | { kind: "checking_browser_extension" }
  | { kind: "checking_extension_runtime" }
  | { kind: "checking_agent_config" }
  | { kind: "probing_mcp_runtime" }
  | { kind: "probing_agent_runtime" }
  | { kind: "selecting_terminal_action" }
  | { kind: "done" };

export type VerifySetupEffect =
  | { type: "apply_repairs" }
  | { type: "check_cli_install" }
  | { type: "check_target_support" }
  | { type: "check_native_host" }
  | { type: "probe_runtime_descriptor" }
  | { type: "resolve_profile" }
  | { type: "check_browser_extension" }
  | { type: "check_extension_runtime" }
  | { type: "check_agent_config" }
  | { type: "probe_mcp_runtime" }
  | { type: "probe_agent_runtime" }
  | { type: "select_terminal_action" };

export type VerifySetupTransition = {
  from: VerifySetupState["kind"];
  effect: VerifySetupEffect;
  state: VerifySetupState;
};

export function initialVerifySetupState(input: {
  repairRequested: boolean;
  targetSupported: boolean;
}): VerifySetupState {
  if (input.repairRequested && input.targetSupported) return { kind: "repairing" };
  return { kind: "checking_cli_install" };
}

export function advanceVerifySetup(state: VerifySetupState): VerifySetupTransition | null {
  switch (state.kind) {
    case "repairing":
      return transition(state, { type: "apply_repairs" }, { kind: "checking_cli_install" });
    case "checking_cli_install":
      return transition(state, { type: "check_cli_install" }, { kind: "checking_target_support" });
    case "checking_target_support":
      return transition(state, { type: "check_target_support" }, { kind: "checking_native_host" });
    case "checking_native_host":
      return transition(state, { type: "check_native_host" }, { kind: "probing_runtime_descriptor" });
    case "probing_runtime_descriptor":
      return transition(state, { type: "probe_runtime_descriptor" }, { kind: "resolving_profile" });
    case "resolving_profile":
      return transition(state, { type: "resolve_profile" }, { kind: "checking_browser_extension" });
    case "checking_browser_extension":
      return transition(state, { type: "check_browser_extension" }, { kind: "checking_extension_runtime" });
    case "checking_extension_runtime":
      return transition(state, { type: "check_extension_runtime" }, { kind: "checking_agent_config" });
    case "checking_agent_config":
      return transition(state, { type: "check_agent_config" }, { kind: "probing_mcp_runtime" });
    case "probing_mcp_runtime":
      return transition(state, { type: "probe_mcp_runtime" }, { kind: "probing_agent_runtime" });
    case "probing_agent_runtime":
      return transition(state, { type: "probe_agent_runtime" }, { kind: "selecting_terminal_action" });
    case "selecting_terminal_action":
      return transition(state, { type: "select_terminal_action" }, { kind: "done" });
    case "done":
      return null;
  }
}

function transition(
  from: VerifySetupState,
  effect: VerifySetupEffect,
  state: VerifySetupState,
): VerifySetupTransition {
  return {
    from: from.kind,
    effect,
    state,
  };
}
