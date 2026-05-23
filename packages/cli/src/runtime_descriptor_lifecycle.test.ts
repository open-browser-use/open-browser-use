import assert from "node:assert/strict";
import test from "node:test";

import {
  planRuntimeDescriptorFailure,
  planRuntimeDescriptorFresh,
  planRuntimeDescriptorSetupFailure,
  runtimeDescriptorLifecycleNextAction,
  runtimeDescriptorLifecycleProductError,
  runtimeDescriptorReasonApplicability,
  summarizeRuntimeDescriptorFailures,
} from "./runtime_descriptor_lifecycle.js";

test("runtime descriptor lifecycle planner classifies fresh descriptors", () => {
  assert.deepEqual(planRuntimeDescriptorFresh(), { state: "fresh" });
});

test("runtime descriptor setup lifecycle classifies setup boundary states", () => {
  assert.deepEqual(planRuntimeDescriptorSetupFailure("descriptor_dir_missing"), {
    state: "missing",
    reason_code: "descriptor_dir_missing",
  });
  assert.deepEqual(planRuntimeDescriptorSetupFailure("descriptor_dir_unreadable"), {
    state: "unreadable",
    reason_code: "descriptor_dir_unreadable",
  });
  assert.deepEqual(planRuntimeDescriptorSetupFailure("descriptor_dir_permissions"), {
    state: "invalid",
    reason_code: "descriptor_dir_permissions",
  });
  assert.deepEqual(planRuntimeDescriptorSetupFailure("descriptor_missing"), {
    state: "no_descriptor",
    reason_code: "descriptor_missing",
  });
});

test("runtime descriptor lifecycle planner separates invalid shape from stale runtime", () => {
  assert.deepEqual(planRuntimeDescriptorFailure("unsupported_schema_version"), {
    state: "invalid",
    reason_code: "unsupported_schema_version",
  });
  assert.deepEqual(planRuntimeDescriptorFailure("descriptor_json_invalid"), {
    state: "invalid",
    reason_code: "descriptor_json_invalid",
  });
  assert.deepEqual(planRuntimeDescriptorFailure("descriptor_process_not_alive"), {
    state: "stale",
    reason_code: "descriptor_process_not_alive",
  });
});

test("runtime descriptor lifecycle summary preserves stable reason codes", () => {
  assert.deepEqual(
    summarizeRuntimeDescriptorFailures([
      planRuntimeDescriptorFailure("descriptor_probe_failed"),
      planRuntimeDescriptorFailure("descriptor_probe_failed"),
      planRuntimeDescriptorFailure("descriptor_extension_id_mismatch"),
    ]),
    {
      state: "invalid",
      reason_codes: ["descriptor_probe_failed", "descriptor_extension_id_mismatch"],
    },
  );
});

test("runtime descriptor lifecycle derives public product errors and actions", () => {
  const invalid = summarizeRuntimeDescriptorFailures([
    planRuntimeDescriptorFailure("descriptor_json_invalid"),
  ]);
  assert.equal(runtimeDescriptorLifecycleProductError(invalid), "invalid_descriptor");
  assert.equal(runtimeDescriptorLifecycleNextAction(invalid), "needs_repair");

  const stale = summarizeRuntimeDescriptorFailures([
    planRuntimeDescriptorFailure("descriptor_probe_failed"),
  ]);
  assert.equal(runtimeDescriptorLifecycleProductError(stale), "stale_descriptor");
  assert.equal(runtimeDescriptorLifecycleNextAction(stale), "needs_repair");

  const mismatch = summarizeRuntimeDescriptorFailures([
    planRuntimeDescriptorFailure("descriptor_extension_id_mismatch"),
  ]);
  assert.equal(runtimeDescriptorLifecycleProductError(mismatch), "extension_id_mismatch");
  assert.equal(runtimeDescriptorLifecycleNextAction(mismatch), "needs_browser_popup");
});

test("runtime descriptor reason applicability documents CLI and Node parity", () => {
  const expectedReadReasons = [
    "descriptor_file_invalid",
    "descriptor_json_invalid",
    "unsupported_schema_version",
    "unsupported_descriptor_type",
    "socket_path_missing",
    "sdk_auth_token_missing",
    "descriptor_socket_invalid",
    "descriptor_process_not_alive",
    "descriptor_probe_failed",
    "descriptor_auth_rejected",
    "descriptor_getinfo_failed",
    "descriptor_getinfo_type_mismatch",
    "descriptor_getinfo_name_mismatch",
    "descriptor_browser_kind_mismatch",
    "descriptor_extension_id_mismatch",
  ];
  const expectedSetupReasons = [
    "descriptor_dir_missing",
    "descriptor_dir_unreadable",
    "descriptor_dir_invalid",
    "descriptor_dir_permissions",
    "descriptor_missing",
  ];
  const mapped = new Map(runtimeDescriptorReasonApplicability.map((row) => [row.reason_code, row]));
  assert.deepEqual([...mapped.keys()].sort(), [...expectedReadReasons, ...expectedSetupReasons].sort());
  for (const reason of [
    "descriptor_file_invalid",
    "descriptor_json_invalid",
    "unsupported_schema_version",
    "unsupported_descriptor_type",
    "socket_path_missing",
    "sdk_auth_token_missing",
    "descriptor_socket_invalid",
    "descriptor_process_not_alive",
    "descriptor_probe_failed",
    "descriptor_dir_missing",
    "descriptor_dir_unreadable",
    "descriptor_dir_invalid",
    "descriptor_missing",
  ] as const) {
    assert.equal(mapped.get(reason)?.owners.includes("node_repl"), true, `${reason} should have a Node REPL applicability entry`);
  }
  assert.deepEqual(mapped.get("descriptor_browser_kind_mismatch")?.owners, ["cli", "browser_popup"]);
  assert.deepEqual(mapped.get("descriptor_extension_id_mismatch")?.owners, ["cli", "browser_popup"]);
});
