import assert from "node:assert/strict";
import test from "node:test";

import { formatVerifyReport, type VerifyReport } from "./verify.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

test("ready verify output is concise and names the terminal result", () => {
  const output = formatVerifyReport(baseReport());

  assert.deepEqual(output.split("\n"), [
    "Result: ready",
    "Target: cli",
    "Agent: codex-cli",
    `Browser: chrome unpacked-dev ${EXTENSION_ID}`,
    "Backend: 1 usable (webextension)",
    "Next: none",
  ]);
});

test("non-ready verify output leads with the result and the single next action", () => {
  const output = formatVerifyReport({
    ...baseReport(),
    result: "needs_repair",
    readiness: { cli: "blocked", agentRuntime: "not_checked" },
    productError: {
      code: "setup_missing",
      title: "Setup missing",
      summary: "Native host manifest is missing.",
      nextAction: null,
    },
    nextAction: {
      kind: "run_repair",
      message: "Repair the native-host manifest, then rerun verify.",
      command: "obu verify --agent=codex-cli --browser=chrome --channel=unpacked-dev --extension-id=abcdefghijklmnopabcdefghijklmnop --repair",
    },
  });

  assert.deepEqual(output.split("\n"), [
    "Result: needs_repair",
    "State: Setup missing (setup_missing).",
    "Next: Repair the native-host manifest, then rerun verify.",
    "Run:",
    "  obu verify --agent=codex-cli --browser=chrome --channel=unpacked-dev --extension-id=abcdefghijklmnopabcdefghijklmnop --repair",
  ]);
});

function baseReport(): VerifyReport {
  return {
    schemaVersion: 1,
    command: "verify",
    verificationTarget: "cli",
    result: "ready",
    readiness: {
      cli: "ready",
      agentRuntime: "not_checked",
    },
    agent: {
      id: "codex-cli",
      mcpConfig: {
        status: "pass",
        serverName: "open-browser-use",
        command: "/Users/example/.obu/bin/obu",
        args: ["mcp", "stdio"],
      },
      instructions: {
        status: "pass",
        path: "/Users/example/.codex/AGENTS.md",
      },
      runtimeStatus: {
        status: "not_checked",
        provenance: "not_applicable",
        reason: "agent runtime verification was not requested",
      },
    },
    browser: {
      kind: "chrome",
      channel: "unpacked-dev",
      extensionId: EXTENSION_ID,
      extensionIdSource: "explicit-argument",
      profile: {
        path: "/Users/example/Library/Application Support/Google/Chrome/Profile 2",
        suggestedPath: null,
        source: "explicit",
        runtimeBinding: "profile_verified",
        candidates: [],
      },
      extensionInstalled: "pass",
      extensionEnabled: "pass",
      nativeHost: "pass",
      runtimeDescriptor: "pass",
      resumeRequired: false,
      descriptor: {
        file: "/Users/example/.obu/runtime/webextension/chrome.json",
      },
    },
    mcpRuntime: {
      cli: {
        source: "direct_mcp_probe",
        provenance: "expected_obu_invocation",
        probeCommandSource: "expected_obu_invocation",
        mcpConfigured: true,
        mcpStarts: true,
        sdkBootstrap: "available",
        backendCount: 1,
        backends: [
          {
            type: "webextension",
            browser: "chrome",
            extensionId: EXTENSION_ID,
            extensionIdentity: {
              source: "descriptor_metadata",
              verified: true,
            },
          },
        ],
      },
      agentRuntime: {
        source: "not_checked",
        provenance: "not_applicable",
        probeCommandSource: "not_applicable",
        mcpConfigured: true,
        mcpStarts: null,
        sdkBootstrap: "not_checked",
        backendCount: null,
        backends: [],
        reason: "agent runtime verification was not requested",
      },
    },
    productError: null,
    nextAction: null,
    checks: [],
  };
}
