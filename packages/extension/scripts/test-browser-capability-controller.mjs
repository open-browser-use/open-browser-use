import assert from "node:assert/strict";

import { BrowserCapabilityController } from "../dist/browser_capability_controller.js";

{
  const harness = createHarness();

  const result = await harness.controller.setViewport(sessionParams(), {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: true,
  });

  assert.deepEqual(result, { width: 1280, height: 720, deviceScaleFactor: 2, mobile: true, tabId: 4 });
  assert.deepEqual(harness.calls.requireCurrent, ["browser viewport set"]);
  assert.deepEqual(harness.calls.ensureDebugger, [["session-a", 4]]);
  assert.deepEqual(harness.calls.debuggerCommands, [[4, "Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: true,
  }]]);
  assert.equal(harness.calls.logs.at(-1).event, "browser.viewport.set");
}

{
  const harness = createHarness();

  const result = await harness.controller.resetViewport(sessionParams());

  assert.deepEqual(result, { reset: true, tabId: 4 });
  assert.deepEqual(harness.calls.requireCurrent, ["browser viewport reset"]);
  assert.deepEqual(harness.calls.debuggerCommands, [[4, "Emulation.clearDeviceMetricsOverride", {}]]);
}

{
  const harness = createHarness({
    windowUpdateResult: { id: 12, focused: false, state: "normal" },
  });

  const result = await harness.controller.setVisibility(sessionParams(), { visible: true, focused: false });

  assert.deepEqual(harness.calls.windowUpdates, [[12, { state: "normal", focused: false }]]);
  assert.deepEqual(result, { visible: true, focused: false, windowId: 12, state: "normal" });
  assert.equal(harness.calls.logs.at(-1).event, "browser.visibility.set");
}

{
  const harness = createHarness({
    windowUpdateResult: { id: 12, focused: false, state: "minimized" },
  });

  const result = await harness.controller.setVisibility(sessionParams(), { visible: false });

  assert.deepEqual(harness.calls.windowUpdates, [[12, { state: "minimized" }]]);
  assert.deepEqual(result, { visible: false, focused: false, windowId: 12, state: "minimized" });
}

{
  const harness = createHarness({
    windowGetResult: { id: 12, focused: true, state: "maximized" },
  });

  const result = await harness.controller.getVisibility(sessionParams());

  assert.deepEqual(harness.calls.requireCurrent, ["browser visibility get"]);
  assert.deepEqual(harness.calls.windowGets, [12]);
  assert.deepEqual(result, { visible: true, focused: true, windowId: 12, state: "maximized" });
}

{
  const harness = createHarness();

  await assert.rejects(
    () => harness.controller.setViewport(sessionParams(), { width: 0, height: 720 }),
    /width must be an integer between 1 and 16384/,
  );
}

function sessionParams() {
  return { session_id: "session-a", turn_id: "turn-1" };
}

function createHarness(overrides = {}) {
  const calls = {
    requireCurrent: [],
    ensureDebugger: [],
    debuggerCommands: [],
    windowUpdates: [],
    windowGets: [],
    logs: [],
  };
  const controller = new BrowserCapabilityController({
    requireCurrentSessionTabForBrowserCommand: async (_sessionParams, operation) => {
      calls.requireCurrent.push(operation);
      return { tabId: 4, tab: { id: 4, windowId: 12 } };
    },
    ensureDebuggerAttached: async (sessionId, tabId) => {
      calls.ensureDebugger.push([sessionId, tabId]);
    },
    sendDebuggerCommand: async (tabId, method, commandParams) => {
      calls.debuggerCommands.push([tabId, method, commandParams]);
      return {};
    },
    updateWindow: async (windowId, updateInfo) => {
      calls.windowUpdates.push([windowId, updateInfo]);
      return overrides.windowUpdateResult ?? { id: windowId, focused: true, state: updateInfo.state ?? "normal" };
    },
    getWindow: async (windowId) => {
      calls.windowGets.push(windowId);
      return overrides.windowGetResult ?? { id: windowId, focused: true, state: "normal" };
    },
    appendDebugLog: (level, event, data) => {
      calls.logs.push({ level, event, data });
    },
  });
  return { controller, calls };
}
