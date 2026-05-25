import assert from "node:assert/strict";

import { BrowserDebuggerController } from "../dist/browser_debugger_controller.js";

{
  const harness = createHarness();

  await harness.controller.attachDebugger(baseParams());

  assert.equal(harness.session.attachedTabIds.has(4), true);
  assert.deepEqual(harness.calls.attach, [4]);
  assert.equal(harness.calls.logs.at(-1).event, "debugger.attach.requested");

  await harness.controller.attachDebugger(baseParams());
  assert.deepEqual(harness.calls.attach, [4], "attach is idempotent while session bookkeeping is attached");

  await harness.controller.detachDebugger(baseParams());
  assert.equal(harness.session.attachedTabIds.has(4), false);
  assert.deepEqual(harness.calls.detach, [4]);
  assert.equal(harness.calls.logs.at(-1).event, "debugger.detach.requested");
}

{
  const harness = createHarness();

  const result = await harness.controller.executeCdp({
    ...baseParams(),
    method: "Input.dispatchMouseEvent",
    commandParams: { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1 },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(harness.calls.attach, [4]);
  assert.deepEqual(harness.calls.activate, [[4, { x: 1, y: 2, sequence: 3 }]]);
  assert.deepEqual(harness.calls.inputBypass, [[4, "cdp-mouse", ["pointer"]]]);
  assert.deepEqual(harness.calls.debuggerCommands, [[4, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 10,
    y: 20,
    button: "left",
    clickCount: 1,
  }]]);
  assert.deepEqual(harness.calls.cursorEvents.map((row) => [row[0], row[1].kind]), [[4, "release"], [4, "click"]]);
  assert.deepEqual(harness.row.lastCursor, { x: 10, y: 20 });
  assert.equal(harness.calls.persist, 1);
  assert.equal(harness.calls.logs.at(-1).event, "cdp.execute");
}

{
  const harness = createHarness();

  await harness.controller.executeCdp({
    ...baseParams(),
    method: "Page.captureScreenshot",
    commandParams: { format: "png" },
    suppressAgentOverlayForCapture: true,
  });

  assert.deepEqual(harness.calls.captureSuppressed, [4]);
  assert.deepEqual(harness.calls.debuggerCommands, [[4, "Page.captureScreenshot", { format: "png" }]]);
}

// A top-level command carries no OOPIF child sessionId.
{
  const harness = createHarness();

  await harness.controller.executeCdp({
    ...baseParams(),
    method: "DOM.getDocument",
    commandParams: { depth: -1 },
  });

  assert.deepEqual(harness.calls.debuggerCommandSessions, [undefined]);
}

// A `target.sessionId` routes the command to the flattened OOPIF child session.
{
  const harness = createHarness();

  await harness.controller.executeCdp({
    ...baseParams(),
    target: { tabId: 4, sessionId: "OOPIF-CHILD" },
    method: "DOM.getContentQuads",
    commandParams: { backendNodeId: 900 },
  });

  assert.deepEqual(harness.calls.debuggerCommands, [[4, "DOM.getContentQuads", { backendNodeId: 900 }]]);
  assert.deepEqual(
    harness.calls.debuggerCommandSessions,
    ["OOPIF-CHILD"],
    "executeCdp must forward target.sessionId to sendDebuggerCommand",
  );
}

{
  const harness = createHarness({
    moveMouseResult: { visible: true, arrived: true, sequence: 44 },
  });

  const result = await harness.controller.moveMouse({ ...baseParams(), x: 30, y: 40 });

  assert.deepEqual(result, { visible: true, arrived: true, sequence: 44 });
  assert.deepEqual(harness.calls.moveMouse, [[4, 30, 40]]);
  assert.deepEqual(harness.row.lastCursor, { x: 30, y: 40, sequence: 44 });
  assert.equal(harness.calls.persist, 1);
  assert.equal(harness.calls.logs.at(-1).event, "cursor.move");
}

{
  const harness = createHarness({ moveMouseResult: { visible: false } });

  await harness.controller.moveMouse({ ...baseParams(), x: 30, y: 40 });

  assert.deepEqual(harness.row.lastCursor, { x: 1, y: 2, sequence: 3 });
  assert.equal(harness.calls.persist, 0);
}

function baseParams() {
  return { session_id: "session-a", turn_id: "turn-1", tabId: 4 };
}

function createHarness(overrides = {}) {
  const row = { tabId: 4, origin: "agent", status: "active", lastCursor: { x: 1, y: 2, sequence: 3 } };
  const session = {
    currentTurnId: "",
    lifecycle: { kind: "active" },
    turnLifecycle: { kind: "idle" },
    tabs: new Map([[4, row]]),
    finalizedTabs: new Map(),
    attachedTabIds: new Set(overrides.attached ?? []),
  };
  const calls = {
    attach: [],
    detach: [],
    debuggerCommands: [],
    debuggerCommandSessions: [],
    activate: [],
    inputBypass: [],
    cursorEvents: [],
    captureSuppressed: [],
    moveMouse: [],
    persist: 0,
    logs: [],
  };
  const controller = new BrowserDebuggerController({
    sessionFor: () => session,
    requireSessionTab: (_sessionParams, tabId) => {
      const found = session.tabs.get(tabId);
      if (!found) throw new Error(`tab ${tabId} is not owned`);
      return found;
    },
    attachDebugger: async (tabId) => {
      calls.attach.push(tabId);
    },
    detachDebugger: async (tabId) => {
      calls.detach.push(tabId);
    },
    sendDebuggerCommand: async (tabId, method, commandParams, sessionId) => {
      calls.debuggerCommands.push([tabId, method, commandParams]);
      calls.debuggerCommandSessions.push(sessionId);
      return { ok: true };
    },
    activateOverlay: async (tabId, _sessionParams, savedCursor) => {
      calls.activate.push([tabId, savedCursor]);
    },
    allowCdpInput: async (tabId, _sessionParams, bypass) => {
      calls.inputBypass.push([tabId, bypass.reason, bypass.eventFamilies]);
    },
    sendCursorEvent: async (tabId, _sessionParams, event) => {
      calls.cursorEvents.push([tabId, event]);
    },
    withCaptureSuppressed: async (tabId, operation) => {
      calls.captureSuppressed.push(tabId);
      return await operation();
    },
    moveMouse: async (tabId, _sessionParams, x, y) => {
      calls.moveMouse.push([tabId, x, y]);
      return overrides.moveMouseResult ?? { visible: true, arrived: true, sequence: 1 };
    },
    persistSessionState: async () => {
      calls.persist += 1;
    },
    appendDebugLog: (level, event, data) => {
      calls.logs.push({ level, event, data });
    },
  });
  return { controller, session, row, calls };
}
