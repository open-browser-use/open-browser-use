import assert from "node:assert/strict";
import test from "node:test";

import { formatDoctorSummary, formatSetupSummary, formatUpdateExtensionSummary } from "./human-output.js";

test("doctor summary hides ordinary passing checks and keeps actionable recovery details", () => {
  const formatted = formatDoctorSummary({
    browser: "chrome",
    extensionChannel: "unpacked-dev",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionIdSource: "manifest-key",
    checks: [
      {
        id: "payload-node",
        label: "Node runtime",
        status: "pass",
        message: "/payload/node/bin/node",
      },
      {
        id: "native-host-manifest",
        label: "Native host manifest",
        status: "fail",
        message: "manifest not found",
        details: { repair: "Run `obu setup` to register the native host." },
      },
      {
        id: "profile-path",
        label: "Profile path",
        status: "warn",
        message: "profile root not found",
      },
      {
        id: "runtime-descriptor-probe",
        label: "Runtime descriptor probe",
        status: "pass",
        message: "chrome.json responded to getInfo",
        details: {
          resume_required: false,
          lifecycle: {
            stale_sessions: 0,
            stale_tabs: 0,
            stale_file_choosers: 0,
            stale_downloads: 0,
            deliverable_tabs: 1,
            deliverable_tab_summaries: [
              { tab_id: "8", session_id: "session", title: "Deliverable" },
            ],
          },
          deliverable_recovery: "run await browser.deliverables(), then call claim() on the tab to recover",
        },
      },
    ],
  }, "doctor", false);

  assert.match(formatted, /2 passed, 1 warning, 1 failed/);
  assert.doesNotMatch(formatted, /Node runtime/);
  assert.match(formatted, /FAIL Native host manifest: manifest not found/);
  assert.match(formatted, /repair: Run `obu setup`/);
  assert.match(formatted, /WARN Profile path: profile root not found/);
  assert.match(formatted, /PASS Runtime descriptor probe: chrome\.json responded to getInfo/);
  assert.match(formatted, /resume required: no/);
  assert.match(formatted, /deliverable tabs: 8:Deliverable \(session\)/);
  assert.match(formatted, /recover deliverables: .*browser\.deliverables\(\).*claim\(\)/);
  assert.match(formatted, /For full diagnostics, run: obu doctor --verbose/);
});

test("dry-run summaries still surface failures", () => {
  const setup = formatSetupSummary({
    schemaVersion: 1,
    generatedAt: "2026-05-18T00:00:00.000Z",
    obuVersion: "0.1.0",
    extensionChannel: "unpacked-dev",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionIdSource: "manifest-key",
    dryRun: true,
    result: "failed",
    steps: [
      { id: "native-host-chrome", status: "failed", message: "obu-host is not executable" },
    ],
    nextActions: [],
  });
  assert.match(setup, /Setup dry run: no changes made\./);
  assert.match(setup, /native-host-chrome: obu-host is not executable/);

  const update = formatUpdateExtensionSummary({
    schemaVersion: 1,
    command: "update-extension",
    dryRun: true,
    result: "failed",
    extensionCurrentDir: "/tmp/current",
    steps: [
      { id: "extension-source", status: "failed", message: "could not validate extension payload" },
    ],
    nextActions: [],
  });
  assert.match(update, /Extension update dry run: no changes made\./);
  assert.match(update, /extension-source: could not validate extension payload/);
});

test("setup summary counts manual follow-ups from step statuses", () => {
  const formatted = formatSetupSummary({
    schemaVersion: 1,
    generatedAt: "2026-05-18T00:00:00.000Z",
    obuVersion: "0.1.0",
    extensionChannel: "store",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
    extensionIdSource: "explicit-argument",
    dryRun: false,
    result: "manual_action_required",
    steps: [
      { id: "runtime-dir", status: "applied", message: "ensured runtime directory" },
      { id: "agent-continue", status: "manual_action_required", message: "configure continue manually" },
      { id: "agent-codex-cli", status: "manual_action_required", message: "configure codex-cli manually" },
    ],
    nextActions: [
      { kind: "command", value: "obu mcp-config --agent=continue --print" },
      { kind: "command", value: "obu mcp-config --agent=codex-cli --print" },
    ],
  });

  assert.match(formatted, /Setup needs 2 follow-up steps\./);
  assert.match(formatted, /Run:\n  obu mcp-config --agent=continue --print/);
  assert.match(formatted, /Run:\n  obu mcp-config --agent=codex-cli --print/);
});
