export type RuntimeDescriptorLifecycleState = "fresh" | "stale" | "invalid";

export type RuntimeDescriptorSetupLifecycleState = "missing" | "unreadable" | "invalid" | "no_descriptor";

export type RuntimeDescriptorSetupReasonCode =
  | "descriptor_dir_missing"
  | "descriptor_dir_unreadable"
  | "descriptor_dir_invalid"
  | "descriptor_dir_permissions"
  | "descriptor_missing";

export type RuntimeDescriptorLifecycleReasonCode =
  | "descriptor_file_invalid"
  | "descriptor_json_invalid"
  | "unsupported_schema_version"
  | "unsupported_descriptor_type"
  | "socket_path_missing"
  | "sdk_auth_token_missing"
  | "descriptor_socket_invalid"
  | "descriptor_process_not_alive"
  | "descriptor_probe_failed"
  | "descriptor_auth_rejected"
  | "descriptor_getinfo_failed"
  | "descriptor_getinfo_type_mismatch"
  | "descriptor_getinfo_name_mismatch"
  | "descriptor_browser_kind_mismatch"
  | "descriptor_extension_id_mismatch";

export type RuntimeDescriptorLifecycle =
  | {
    state: "fresh";
  }
  | {
    state: "stale" | "invalid";
    reason_code: RuntimeDescriptorLifecycleReasonCode;
  };

export type RuntimeDescriptorLifecycleSummary =
  | {
    state: "fresh";
  }
  | {
    state: "stale" | "invalid";
    reason_codes: RuntimeDescriptorLifecycleReasonCode[];
  };

export type RuntimeDescriptorLifecycleProductError =
  | "invalid_descriptor"
  | "stale_descriptor"
  | "browser_popup_boundary"
  | "extension_id_mismatch";

export type RuntimeDescriptorLifecycleNextAction = "needs_repair" | "needs_browser_popup";

export type RuntimeDescriptorSetupLifecycle = {
  state: RuntimeDescriptorSetupLifecycleState;
  reason_code: RuntimeDescriptorSetupReasonCode;
};

export type RuntimeDescriptorReasonOwner = "cli" | "node_repl" | "browser_popup";

export type RuntimeDescriptorReasonApplicability = {
  reason_code: RuntimeDescriptorLifecycleReasonCode | RuntimeDescriptorSetupReasonCode;
  owners: RuntimeDescriptorReasonOwner[];
  product_outcome: RuntimeDescriptorLifecycleProductError | "setup_missing";
};

export const runtimeDescriptorReasonApplicability: RuntimeDescriptorReasonApplicability[] = [
  { reason_code: "descriptor_file_invalid", owners: ["cli", "node_repl"], product_outcome: "invalid_descriptor" },
  { reason_code: "descriptor_json_invalid", owners: ["cli", "node_repl"], product_outcome: "invalid_descriptor" },
  { reason_code: "unsupported_schema_version", owners: ["cli", "node_repl"], product_outcome: "invalid_descriptor" },
  { reason_code: "unsupported_descriptor_type", owners: ["cli", "node_repl"], product_outcome: "invalid_descriptor" },
  { reason_code: "socket_path_missing", owners: ["cli", "node_repl"], product_outcome: "invalid_descriptor" },
  { reason_code: "sdk_auth_token_missing", owners: ["cli", "node_repl"], product_outcome: "invalid_descriptor" },
  { reason_code: "descriptor_socket_invalid", owners: ["cli", "node_repl"], product_outcome: "invalid_descriptor" },
  { reason_code: "descriptor_process_not_alive", owners: ["cli", "node_repl"], product_outcome: "stale_descriptor" },
  { reason_code: "descriptor_probe_failed", owners: ["cli", "node_repl"], product_outcome: "stale_descriptor" },
  { reason_code: "descriptor_auth_rejected", owners: ["cli"], product_outcome: "stale_descriptor" },
  { reason_code: "descriptor_getinfo_failed", owners: ["cli"], product_outcome: "stale_descriptor" },
  { reason_code: "descriptor_getinfo_type_mismatch", owners: ["cli"], product_outcome: "stale_descriptor" },
  { reason_code: "descriptor_getinfo_name_mismatch", owners: ["cli"], product_outcome: "stale_descriptor" },
  { reason_code: "descriptor_browser_kind_mismatch", owners: ["cli", "browser_popup"], product_outcome: "browser_popup_boundary" },
  { reason_code: "descriptor_extension_id_mismatch", owners: ["cli", "browser_popup"], product_outcome: "extension_id_mismatch" },
  { reason_code: "descriptor_dir_missing", owners: ["cli", "node_repl"], product_outcome: "setup_missing" },
  { reason_code: "descriptor_dir_unreadable", owners: ["cli", "node_repl"], product_outcome: "setup_missing" },
  { reason_code: "descriptor_dir_invalid", owners: ["cli", "node_repl"], product_outcome: "setup_missing" },
  { reason_code: "descriptor_dir_permissions", owners: ["cli"], product_outcome: "setup_missing" },
  { reason_code: "descriptor_missing", owners: ["cli", "node_repl"], product_outcome: "setup_missing" },
];

const staleReasonCodes = new Set<RuntimeDescriptorLifecycleReasonCode>([
  "descriptor_process_not_alive",
  "descriptor_probe_failed",
  "descriptor_auth_rejected",
  "descriptor_getinfo_failed",
  "descriptor_getinfo_type_mismatch",
  "descriptor_getinfo_name_mismatch",
]);

export function planRuntimeDescriptorFresh(): RuntimeDescriptorLifecycle {
  return { state: "fresh" };
}

export function planRuntimeDescriptorSetupFailure(
  reasonCode: RuntimeDescriptorSetupReasonCode,
): RuntimeDescriptorSetupLifecycle {
  if (reasonCode === "descriptor_dir_unreadable") return { state: "unreadable", reason_code: reasonCode };
  if (reasonCode === "descriptor_dir_invalid" || reasonCode === "descriptor_dir_permissions") {
    return { state: "invalid", reason_code: reasonCode };
  }
  if (reasonCode === "descriptor_missing") return { state: "no_descriptor", reason_code: reasonCode };
  return { state: "missing", reason_code: reasonCode };
}

export function planRuntimeDescriptorFailure(
  reasonCode: RuntimeDescriptorLifecycleReasonCode,
): RuntimeDescriptorLifecycle {
  return {
    state: staleReasonCodes.has(reasonCode) ? "stale" : "invalid",
    reason_code: reasonCode,
  };
}

export function summarizeRuntimeDescriptorFailures(
  lifecycles: readonly RuntimeDescriptorLifecycle[],
): RuntimeDescriptorLifecycleSummary {
  const reasonCodes = lifecycles.flatMap((lifecycle) =>
    "reason_code" in lifecycle ? [lifecycle.reason_code] : []
  );
  const uniqueReasonCodes = [...new Set(reasonCodes)];
  if (uniqueReasonCodes.length === 0) return { state: "fresh" };
  return {
    state: uniqueReasonCodes.some((reasonCode) => !staleReasonCodes.has(reasonCode)) ? "invalid" : "stale",
    reason_codes: uniqueReasonCodes,
  };
}

export function runtimeDescriptorLifecycleProductError(
  lifecycle: RuntimeDescriptorLifecycle | RuntimeDescriptorLifecycleSummary,
): RuntimeDescriptorLifecycleProductError | undefined {
  if (lifecycle.state === "fresh") return undefined;
  const reasonCodes = "reason_code" in lifecycle ? [lifecycle.reason_code] : lifecycle.reason_codes;
  if (reasonCodes.includes("descriptor_extension_id_mismatch")) return "extension_id_mismatch";
  if (reasonCodes.includes("descriptor_browser_kind_mismatch")) return "browser_popup_boundary";
  return lifecycle.state === "stale" ? "stale_descriptor" : "invalid_descriptor";
}

export function runtimeDescriptorLifecycleNextAction(
  lifecycle: RuntimeDescriptorLifecycle | RuntimeDescriptorLifecycleSummary,
): RuntimeDescriptorLifecycleNextAction {
  if (lifecycle.state === "fresh") return "needs_browser_popup";
  const reasonCodes = "reason_code" in lifecycle ? [lifecycle.reason_code] : lifecycle.reason_codes;
  if (
    reasonCodes.includes("descriptor_extension_id_mismatch") ||
    reasonCodes.includes("descriptor_browser_kind_mismatch")
  ) {
    return "needs_browser_popup";
  }
  return "needs_repair";
}
