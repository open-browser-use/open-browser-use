import assert from "node:assert/strict";

import { OverlayCoordinator } from "../dist/overlay_coordinator.js";

const calls = {
  messages: [],
};
let failNextHide = false;

globalThis.chrome = {
  tabs: {
    async get(tabId) {
      return { id: tabId, windowId: 1, active: true };
    },
    async sendMessage() {
      return { ok: true };
    },
  },
  windows: {
    async get(windowId) {
      return { id: windowId, state: "normal", type: "normal" };
    },
  },
  scripting: {
    async executeScript(injection) {
      const message = injection.args?.[1];
      calls.messages.push({ tabId: injection.target.tabId, message });
      if (message?.type === "OBU_CURSOR_HIDE" && failNextHide) {
        failNextHide = false;
        return [{ result: false }];
      }
      return [{ result: true }];
    },
  },
};

const triggers = [];
const coordinator = new OverlayCoordinator((trigger) => {
  triggers.push(trigger);
});

await coordinator.activate(1, { session_id: "session", turn_id: "turn" });
assert.deepEqual(coordinator.activeTabIds(), [1]);
assert.equal(coordinator.hasPendingActivity(), false);

await coordinator.hide(1);
assert.deepEqual(coordinator.activeTabIds(), []);
assert.equal(coordinator.hasPendingActivity(), false);
assert.ok(triggers.includes("cursor_waiters_rejected"));

await coordinator.activate(2, { session_id: "session", turn_id: "turn" });
failNextHide = true;
await coordinator.hide(2);
assert.deepEqual(coordinator.activeTabIds(), [2]);
assert.equal(coordinator.hasPendingActivity(), true);
assert.deepEqual(coordinator.releaseDiagnostics(), [{
  tabId: 2,
  state: "release_pending",
  sessionId: "session",
  turnId: "turn",
}]);

const messageCountBeforeRetry = calls.messages.length;
await coordinator.syncForeground();
const retryMessages = calls.messages.slice(messageCountBeforeRetry);
assert.ok(retryMessages.some((call) =>
  call.tabId === 2 &&
  call.message.type === "OBU_CURSOR_HIDE"
));
assert.equal(retryMessages.some((call) => call.message.type === "OBU_TAKEOVER_STATE"), false);
assert.deepEqual(coordinator.activeTabIds(), []);
assert.equal(coordinator.hasPendingActivity(), false);
assert.deepEqual(coordinator.releaseDiagnostics(), []);

await coordinator.activate(3, { session_id: "session", turn_id: "turn" });
failNextHide = true;
await coordinator.hide(3);
assert.equal(coordinator.hasPendingActivity(), true);
coordinator.forget(3);
assert.deepEqual(coordinator.activeTabIds(), []);
assert.equal(coordinator.hasPendingActivity(), false);

await coordinator.activate(4, { session_id: "session", turn_id: "turn" });
failNextHide = true;
await coordinator.hide(4);
failNextHide = true;
await coordinator.syncForeground();
assert.deepEqual(coordinator.releaseDiagnostics(), [{
  tabId: 4,
  state: "release_failed",
  failures: 1,
  sessionId: "session",
  turnId: "turn",
}]);
assert.equal(coordinator.hasPendingActivity(), true);

// Finding 21: release_abandoned must NOT count as pending activity
{
  const { releaseFailedOverlayState, OVERLAY_RELEASE_MAX_RETRIES } = await import("../dist/lifecycle/overlay_machine.js");
  const coordinator2 = new OverlayCoordinator((trigger) => {});
  await coordinator2.activate(10, { session_id: "session", turn_id: "turn" });
  // exhaust retries: first call active→release_pending, then MAX calls release_pending/failed→release_failed,
  // then one final call with release_failed(MAX) triggers transition to release_abandoned
  for (let i = 0; i <= OVERLAY_RELEASE_MAX_RETRIES + 1; i++) {
    failNextHide = true;
    await coordinator2.hide(10);
  }
  // after MAX retries, the tab should be in release_abandoned state
  const diag = coordinator2.releaseDiagnostics();
  assert.ok(diag.some((d) => d.tabId === 10 && d.state === "release_abandoned"), "tab should be release_abandoned");
  // release_abandoned must NOT be pending
  assert.equal(coordinator2.hasPendingActivity(), false, "release_abandoned must not count as pending");
}

// audit §4.2: activate() during hide()'s await must NOT be clobbered by the resumed hide().
{
  const triggers2 = [];
  const coordinator3 = new OverlayCoordinator((trigger) => triggers2.push(trigger));
  // While the OBU_CURSOR_HIDE round-trip is in flight, simulate a concurrent
  // re-activation (e.g. moveMouse/claimUserTab) landing a fresh active takeover.
  let reactivateDuringHide = false;
  const originalExecuteScript = globalThis.chrome.scripting.executeScript;
  globalThis.chrome.scripting.executeScript = async (injection) => {
    const message = injection.args?.[1];
    if (message?.type === "OBU_CURSOR_HIDE" && reactivateDuringHide) {
      reactivateDuringHide = false;
      await coordinator3.activate(20, { session_id: "session-b", turn_id: "turn-b" });
    }
    return originalExecuteScript(injection);
  };
  try {
    await coordinator3.activate(20, { session_id: "session-a", turn_id: "turn-a" });
    reactivateDuringHide = true;
    await coordinator3.hide(20);
    // The concurrent activate() must survive: the tab is still tracked AND active.
    assert.deepEqual(coordinator3.activeTabIds(), [20], "concurrent activate() must not be dropped by hide()");
    assert.equal(coordinator3.hasPendingActivity(), false, "no dangling release_pending after the race");
    assert.deepEqual(coordinator3.releaseDiagnostics(), [], "active entry must not be left in a release state");
    assert.deepEqual(coordinator3.activeTakeoverSessionId(20), "session-b", "the freshly-activated takeover identity must be preserved");
  } finally {
    globalThis.chrome.scripting.executeScript = originalExecuteScript;
  }
}
