import type {
  VerificationTarget,
  VerifyCheck,
  VerifyLayer,
  VerifyNextAction,
  VerifyReport,
  VerifyResult,
} from "./verify.js";

const layerOrder: VerifyLayer[] = [
  "target_support",
  "cli_install",
  "native_host",
  "browser_profile",
  "browser_extension",
  "extension_runtime",
  "runtime_descriptor",
  "agent_mcp",
  "agent_instruction",
  "mcp_runtime",
  "agent_runtime",
];

const resultPriority: Record<Exclude<VerifyResult, "ready">, number> = {
  needs_manual_action: 1,
  needs_repair: 2,
  needs_browser_popup: 3,
};

export function computeVerifyReadiness(
  verificationTarget: VerificationTarget,
  checks: VerifyCheck[],
): VerifyReport["readiness"] {
  const cliBlocked = checks.some((check) => check.status === "fail" && check.blocks?.includes("cli"));
  const agentRuntimeBlocked = checks.some((check) => check.status === "fail" && check.blocks?.includes("agent_runtime"));
  return {
    cli: cliBlocked ? "blocked" : "ready",
    agentRuntime: verificationTarget === "cli" ? "not_checked" : cliBlocked ? "not_checked" : agentRuntimeBlocked ? "blocked" : "ready",
  };
}

export function selectVerifyResultAndAction(
  verificationTarget: VerificationTarget,
  readiness: VerifyReport["readiness"],
  checks: VerifyCheck[],
): { result: VerifyResult; nextAction: VerifyNextAction | null } {
  const eligible = readiness.cli !== "ready"
    ? checks.filter((check) => check.status === "fail" && check.blocks?.includes("cli"))
    : verificationTarget === "agent_runtime" && readiness.agentRuntime !== "ready"
      ? checks.filter((check) => check.status === "fail" && check.blocks?.includes("agent_runtime"))
      : [];
  if (eligible.length === 0) return { result: "ready", nextAction: null };
  const candidates = eligible.flatMap((check) => check.actionCandidate ? [{ check, candidate: check.actionCandidate }] : []);
  if (candidates.length === 0) {
    return {
      result: "needs_manual_action",
      nextAction: {
        kind: "unsupported",
        message: "Verification found a blocking state without an automated next action.",
      },
    };
  }
  candidates.sort((left, right) => {
    const resultDelta = resultPriority[left.candidate.result] - resultPriority[right.candidate.result];
    if (resultDelta !== 0) return resultDelta;
    const actionDelta = left.candidate.priority - right.candidate.priority;
    if (actionDelta !== 0) return actionDelta;
    return layerOrder.indexOf(left.check.layer) - layerOrder.indexOf(right.check.layer);
  });
  const selected = candidates[0]!.candidate;
  const { result, priority, ...nextAction } = selected;
  return { result, nextAction };
}
