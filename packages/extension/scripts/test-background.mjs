import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const extensionId = "fblnfcjnjklpgnmfnngcihbcgojnpadj";
const statusKey = "OBU_NATIVE_HOST_STATUS";
const sessionStateKey = "OBU_BROWSER_SESSION_STATE";
const debugLogKey = "OBU_DEBUG_LOG";

class EventTarget {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(...args) {
    return this.listeners.map((listener) => listener(...args));
  }
}

class FakePort {
  onMessage = new EventTarget();
  onDisconnect = new EventTarget();
  sent = [];
  disconnected = false;

  postMessage(message) {
    if (postMessageError) throw postMessageError;
    this.sent.push(message);
  }

  disconnect() {
    this.disconnected = true;
    this.onDisconnect.emit();
  }

  emit(message) {
    this.onMessage.emit(message);
  }
}

const ports = [];
const runtimeMessages = new EventTarget();
const alarmEvents = new EventTarget();
const debuggerEvents = new EventTarget();
const debuggerDetaches = new EventTarget();
const downloadCreates = new EventTarget();
const downloadChanges = new EventTarget();
const downloads = new Map();
const storageChanges = new EventTarget();
const storage = {};
let connectNativeError;
let postMessageError;
let suppressNextCursorArrival = false;
const calls = {
  alarmsClear: [],
  alarmsCreate: [],
  debuggerAttach: [],
  debuggerDetach: [],
  debuggerSendCommand: [],
  scriptingExecuteScript: [],
  tabGroupsUpdate: [],
  tabsCreate: [],
  tabsGroup: [],
  tabsRemove: [],
  tabsSendMessage: [],
  tabsUngroup: [],
};
let nextTabId = 1;
let nextGroupId = 10;
const contentScriptTabs = new Set();
const tabs = new Map([
  [99, { id: 99, windowId: 1, groupId: -1, url: "https://user.example/", title: "User", active: true, pinned: false }],
]);
const windows = new Map([
  [1, { id: 1, focused: true, state: "normal", type: "normal" }],
]);

globalThis.chrome = {
  runtime: {
    id: extensionId,
    lastError: undefined,
    getManifest: () => ({ version: "0.1.0" }),
    connectNative(name) {
      assert.equal(name, "dev.obu.host");
      if (connectNativeError) throw connectNativeError;
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    onMessage: runtimeMessages,
  },
  alarms: {
    async create(name, alarmInfo) {
      calls.alarmsCreate.push({ name, alarmInfo });
    },
    async clear(name) {
      calls.alarmsClear.push(name);
      return true;
    },
    onAlarm: alarmEvents,
  },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storage[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, storage[item]]));
        return { ...storage };
      },
      async set(values) {
        Object.assign(storage, values);
        const changes = Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, { oldValue: undefined, newValue: value }]),
        );
        storageChanges.emit(changes, "local");
      },
    },
    onChanged: storageChanges,
  },
  tabs: {
    async create(createProperties) {
      calls.tabsCreate.push(createProperties);
      const tab = {
        id: nextTabId++,
        windowId: 1,
        groupId: -1,
        url: createProperties.url,
        title: "Created",
        active: createProperties.active,
        pinned: false,
      };
      tabs.set(tab.id, tab);
      return tab;
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`unknown tab ${tabId}`);
      return tab;
    },
    async query() {
      return [...tabs.values()];
    },
    async group(options) {
      calls.tabsGroup.push(options);
      const groupId = options.groupId ?? nextGroupId++;
      for (const tabId of [].concat(options.tabIds)) {
        const tab = tabs.get(tabId);
        if (tab) tab.groupId = groupId;
      }
      return groupId;
    },
    async ungroup(tabIds) {
      calls.tabsUngroup.push(tabIds);
      for (const tabId of [].concat(tabIds)) {
        const tab = tabs.get(tabId);
        if (tab) tab.groupId = -1;
      }
    },
    async remove(tabId) {
      calls.tabsRemove.push(tabId);
      tabs.delete(tabId);
    },
    async sendMessage(tabId, message) {
      if (message?.type === "OBU_CONTENT_PING") {
        if (!contentScriptTabs.has(tabId)) throw new Error(`no content script in tab ${tabId}`);
        return { ok: true };
      }
      if (!contentScriptTabs.has(tabId)) throw new Error(`no content script in tab ${tabId}`);
      calls.tabsSendMessage.push({ tabId, message });
      if (message?.type === "OBU_CURSOR_MOVE") {
        if (suppressNextCursorArrival) {
          suppressNextCursorArrival = false;
          return {};
        }
        setTimeout(() => {
          runtimeMessages.emit({
            type: "OBU_CURSOR_ARRIVED",
            sequence: message.sequence,
            sessionId: message.sessionId,
            turnId: message.turnId,
          }, {}, () => {});
        }, 1);
      }
      return {};
    },
  },
  windows: {
    async get(windowId) {
      const windowInfo = windows.get(windowId);
      if (!windowInfo) throw new Error(`unknown window ${windowId}`);
      return windowInfo;
    },
  },
  scripting: {
    async executeScript(injection) {
      calls.scriptingExecuteScript.push(injection);
      if (injection.files?.includes("cursor.js")) {
        contentScriptTabs.add(injection.target.tabId);
        return [{}];
      }
      if (typeof injection.func === "function") {
        const message = injection.args?.[1];
        calls.tabsSendMessage.push({ tabId: injection.target.tabId, message });
        if (message?.type === "OBU_CURSOR_MOVE") {
          if (suppressNextCursorArrival) {
            suppressNextCursorArrival = false;
            return [{}];
          }
          setTimeout(() => {
            runtimeMessages.emit({
              type: "OBU_CURSOR_ARRIVED",
              sequence: message.sequence,
              sessionId: message.sessionId,
              turnId: message.turnId,
            }, {}, () => {});
          }, 1);
        }
      }
      return [{}];
    },
  },
  tabGroups: {
    async update(groupId, updateProperties) {
      calls.tabGroupsUpdate.push({ groupId, updateProperties });
    },
  },
  debugger: {
    onEvent: debuggerEvents,
    onDetach: debuggerDetaches,
    async attach(target, version) {
      calls.debuggerAttach.push({ target, version });
    },
    async detach(target) {
      calls.debuggerDetach.push(target);
    },
    async sendCommand(target, method, commandParams) {
      calls.debuggerSendCommand.push({ target, method, commandParams });
      if (method === "Runtime.neverResolve") return new Promise(() => {});
      return { ok: true };
    },
  },
  downloads: {
    async search(query) {
      if (Number.isInteger(query.id)) {
        const item = downloads.get(query.id);
        return item ? [{ ...item }] : [];
      }
      return [...downloads.values()].map((item) => ({ ...item }));
    },
    onCreated: downloadCreates,
    onChanged: downloadChanges,
  },
  history: {
    async search() {
      return [{ id: "h1", url: "https://example.com/", title: "Example", visitCount: 1 }];
    },
  },
};

await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?test=${Date.now()}`);

let port = await waitFor(() => ports[0]);
await waitFor(() => port.sent.find((message) => message.type === "hello"));
assert.equal(port.sent[0].type, "hello");
assert.equal(port.sent[0].extension_id, extensionId);
assert.equal(port.sent[0].browser_kind, "chrome");

port.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

let debugStatus = await popupMessage({ type: "GET_DEBUG_LOG_STATUS" });
assert.equal(debugStatus.enabled, false);
assert.deepEqual(debugStatus.entries, []);
debugStatus = await popupMessage({ type: "SET_DEBUG_LOG_ENABLED", enabled: true });
assert.equal(debugStatus.enabled, true);
assert.equal(debugStatus.maxEntries, 200);
assert.ok(debugStatus.entries.some((entry) => entry.event === "debug.enabled"));
await waitFor(() => storage[debugLogKey]?.entries?.some((entry) => entry.event === "debug.enabled"));
await hostRequest(port, "ping");
debugStatus = await popupMessage({ type: "GET_DEBUG_LOG_STATUS" });
assert.ok(debugStatus.entries.some((entry) => entry.event === "native.request" && entry.data?.method === "ping"));
assert.ok(debugStatus.entries.some((entry) => entry.event === "host.request.ok" && entry.data?.method === "ping"));
debugStatus = await popupMessage({ type: "CLEAR_DEBUG_LOGS" });
assert.equal(debugStatus.entries.length, 0);
debugStatus = await popupMessage({ type: "SET_DEBUG_LOG_ENABLED", enabled: false });
assert.equal(debugStatus.enabled, false);

port = await runNativeHostReconnectAfterConnectedCrash(port);

const missingSession = await hostRequest(port, "createTab", { url: "https://bad.example/" });
assert.match(missingSession.error.message, /Missing required browser session_id/);
assert.equal(calls.tabsCreate.length, 0);

const created = await hostRequest(port, "createTab", {
  session_id: "session",
  turn_id: "turn",
  url: "https://example.com/",
});
assert.equal(created.result.tab.tabId, 1);
assert.equal(calls.tabsCreate.length, 1);
assert.equal(calls.tabsGroup[0].tabIds, 1);

const unsafeTarget = await hostRequest(port, "executeCdp", {
  session_id: "session",
  turn_id: "turn",
  target: { targetId: "unsafe-target" },
  method: "Runtime.evaluate",
});
assert.match(unsafeTarget.error.message, /tabId must be an integer/);

const unowned = await hostRequest(port, "executeCdp", {
  session_id: "session",
  turn_id: "turn",
  target: { tabId: 99 },
  method: "Runtime.evaluate",
});
assert.match(unowned.error.message, /not owned by this open-browser-use session/);

const cdpTimeout = await hostRequest(port, "executeCdp", {
  session_id: "session",
  turn_id: "turn",
  target: { tabId: 1 },
  method: "Runtime.neverResolve",
  timeoutMs: 1,
});
assert.match(cdpTimeout.error.message, /executeCdp Runtime\.neverResolve timed out after 1ms/);

const staleResponseId = 4242;
const staleOldPort = port;
staleOldPort.emit({
  jsonrpc: "2.0",
  id: staleResponseId,
  method: "executeCdp",
  params: {
    session_id: "session",
    turn_id: "turn",
    target: { tabId: 1 },
    method: "Runtime.neverResolve",
    timeoutMs: 20,
  },
});
staleOldPort.disconnect();
await waitFor(() => storage[statusKey]?.state === "disconnected");
const staleReconnectPortCount = ports.length;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const staleNewPort = await waitFor(() => ports[staleReconnectPortCount]);
await waitFor(() => staleNewPort.sent.find((message) => message.type === "hello"));
staleNewPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(
  staleNewPort.sent.some((message) => message.jsonrpc === "2.0" && message.id === staleResponseId),
  false,
);
port = staleNewPort;

const cdp = await hostRequest(port, "executeCdp", {
  session_id: "session",
  turn_id: "turn",
  target: { tabId: 1 },
  method: "Runtime.evaluate",
  commandParams: { expression: "1 + 1" },
});
assert.deepEqual(cdp.result, { ok: true });
assert.equal(calls.debuggerAttach[0].target.tabId, 1);

debuggerDetaches.emit({ tabId: 1 });
const detachEvent = await waitFor(() =>
  port.sent.find((message) => message.method === "onCDPEvent" && message.params?.method === "Inspector.detached"),
);
assert.equal(detachEvent.params.session_id, "session");
assert.equal(detachEvent.params.source.tabId, 1);

const cdpAfterDetach = await hostRequest(port, "executeCdp", {
  session_id: "session",
  turn_id: "turn",
  target: { tabId: 1 },
  method: "Runtime.evaluate",
});
assert.deepEqual(cdpAfterDetach.result, { ok: true });
assert.equal(calls.debuggerAttach.length, 2);
assert.ok(calls.tabsSendMessage.some((call) =>
  call.tabId === 1 &&
  call.message.type === "OBU_TAKEOVER_STATE" &&
  call.message.active === true &&
  call.message.lockInputs === true &&
  call.message.sessionId === "session" &&
  call.message.turnId === "turn",
));
assert.ok(calls.scriptingExecuteScript.some((call) =>
  call.target.tabId === 1 &&
  call.target.allFrames === true &&
  call.injectImmediately === true &&
  call.files.includes("cursor.js"),
));

const moveMouseResult = await hostRequest(port, "moveMouse", {
  session_id: "session",
  turn_id: "turn",
  tabId: 1,
  x: 33,
  y: 44,
});
assert.equal(moveMouseResult.result.visible, true);
assert.equal(moveMouseResult.result.arrived, true);
assert.equal(typeof moveMouseResult.result.sequence, "number");
assert.ok(calls.tabsSendMessage.some((call) =>
  call.tabId === 1 &&
  call.message.type === "OBU_CURSOR_MOVE" &&
  call.message.x === 33 &&
  call.message.y === 44 &&
  call.message.sequence === moveMouseResult.result.sequence,
));

windows.get(1).state = "minimized";
const hiddenMoveMouseResult = await hostRequest(port, "moveMouse", {
  session_id: "session",
  turn_id: "turn",
  tabId: 1,
  x: 77,
  y: 88,
});
assert.equal(hiddenMoveMouseResult.result.visible, false);
assert.equal(calls.tabsSendMessage.some((call) =>
  call.tabId === 1 &&
  call.message.type === "OBU_CURSOR_MOVE" &&
  call.message.x === 77 &&
  call.message.y === 88,
), false);
windows.get(1).state = "normal";

suppressNextCursorArrival = true;
const strictArrivalStart = port.sent.length;
const strictArrivalPromise = hostRequest(port, "moveMouse", {
  session_id: "session",
  turn_id: "turn",
  tabId: 1,
  x: 55,
  y: 66,
});
const strictMoveCall = await waitFor(() =>
  calls.tabsSendMessage.find((call) =>
    call.tabId === 1 &&
    call.message.type === "OBU_CURSOR_MOVE" &&
    call.message.x === 55 &&
    call.message.y === 66,
  ),
);
runtimeMessages.emit({ type: "OBU_CURSOR_ARRIVED", sequence: strictMoveCall.message.sequence }, {}, () => {});
runtimeMessages.emit({
  type: "OBU_CURSOR_ARRIVED",
  sequence: strictMoveCall.message.sequence,
  sessionId: "other-session",
  turnId: "turn",
}, {}, () => {});
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(
  port.sent.slice(strictArrivalStart).some((message) => message.jsonrpc === "2.0" && !message.method),
  false,
);
runtimeMessages.emit({
  type: "OBU_CURSOR_ARRIVED",
  sequence: strictMoveCall.message.sequence,
  sessionId: "session",
  turnId: "turn",
}, {}, () => {});
const strictArrivalResult = await strictArrivalPromise;
assert.equal(strictArrivalResult.result.visible, true);
assert.equal(strictArrivalResult.result.arrived, true);

suppressNextCursorArrival = true;
const timedOutArrivalResult = await hostRequest(port, "moveMouse", {
  session_id: "session",
  turn_id: "turn",
  tabId: 1,
  x: 57,
  y: 68,
});
assert.equal(timedOutArrivalResult.result.visible, true);
assert.equal(timedOutArrivalResult.result.arrived, false);

await hostRequest(port, "executeCdp", {
  session_id: "session",
  turn_id: "turn",
  target: { tabId: 1 },
  method: "Input.dispatchMouseEvent",
  commandParams: { type: "mousePressed", x: 33, y: 44, button: "left", clickCount: 1 },
});
await hostRequest(port, "executeCdp", {
  session_id: "session",
  turn_id: "turn",
  target: { tabId: 1 },
  method: "Input.dispatchMouseEvent",
  commandParams: { type: "mouseReleased", x: 33, y: 44, button: "left", clickCount: 1 },
});
assert.ok(calls.tabsSendMessage.some((call) => call.message.type === "OBU_CURSOR_EVENT" && call.message.kind === "press"));
assert.ok(calls.tabsSendMessage.some((call) => call.message.type === "OBU_CURSOR_EVENT" && call.message.kind === "release"));
assert.ok(calls.tabsSendMessage.some((call) => call.message.type === "OBU_CURSOR_EVENT" && call.message.kind === "click"));
assert.ok(calls.tabsSendMessage.some((call) =>
  call.message.type === "OBU_INPUT_BYPASS" &&
  call.message.reason === "cdp-mouse" &&
  call.message.sessionId === "session" &&
  call.message.turnId === "turn",
));
const mousePressCommandIndex = calls.debuggerSendCommand.findIndex((call) =>
  call.method === "Input.dispatchMouseEvent" &&
  call.commandParams?.type === "mousePressed"
);
const mouseBypassIndex = calls.tabsSendMessage.findIndex((call) =>
  call.message.type === "OBU_INPUT_BYPASS" &&
  call.message.reason === "cdp-mouse"
);
assert.ok(mouseBypassIndex >= 0);
assert.ok(mousePressCommandIndex >= 0);

const hideCountBeforeTurnEnd = calls.tabsSendMessage.filter((call) => call.message.type === "OBU_CURSOR_HIDE").length;
await hostRequest(port, "turnEnded", {
  session_id: "session",
  turn_id: "turn",
});
assert.ok(calls.tabsSendMessage.filter((call) => call.message.type === "OBU_CURSOR_HIDE").length > hideCountBeforeTurnEnd);

debuggerEvents.emit({ tabId: 1 }, "Page.downloadWillBegin", {
  url: "https://example.com/file.txt",
  guid: "guid-1",
});
const cdpEvent = await waitFor(() =>
  port.sent.find((message) => message.method === "onCDPEvent" && message.params?.method === "Page.downloadWillBegin"),
);
assert.equal(cdpEvent.params.session_id, "session");
assert.equal(cdpEvent.params.source.tabId, 1);

downloads.set(5, {
  id: 5,
  url: "https://example.com/file.txt",
  filename: "file.txt",
  state: "in_progress",
});
downloadCreates.emit({ id: 5, url: "https://example.com/file.txt", filename: "file.txt" });
const downloadStarted = await waitFor(() =>
  port.sent.find((message) => message.method === "onDownloadChange" && message.params?.status === "started"),
);
assert.equal(downloadStarted.params.session_id, "session");
assert.equal(downloadStarted.params.id, "5");

downloads.set(5, {
  id: 5,
  url: "https://example.com/file.txt",
  filename: "/tmp/file.txt",
  state: "complete",
});
downloadChanges.emit({
  id: 5,
  state: { current: "complete" },
});
const downloadComplete = await waitFor(() =>
  port.sent.find((message) => message.method === "onDownloadChange" && message.params?.status === "complete"),
);
assert.equal(downloadComplete.params.filename, "/tmp/file.txt");

const releaseCreated = await hostRequest(port, "createTab", {
  session_id: "release-session",
  turn_id: "turn",
  url: "https://release.example/",
});
const releaseAgentTabId = releaseCreated.result.tab.tabId;
await hostRequest(port, "claimUserTab", {
  session_id: "release-session",
  turn_id: "turn",
  tabId: 99,
});
assert.notEqual(tabs.get(99).groupId, -1);
const released = await hostRequest(port, "finalizeTabs", {
  session_id: "release-session",
  turn_id: "turn",
  keep: [],
});
assert.deepEqual(released.result.closedTabIds, [releaseAgentTabId]);
assert.deepEqual(released.result.releasedTabIds, [99]);
assert.equal(tabs.has(releaseAgentTabId), false);
assert.equal(tabs.has(99), true);
assert.equal(tabs.get(99).groupId, -1);
assert.deepEqual(calls.tabsRemove.at(-1), releaseAgentTabId);
assert.deepEqual(calls.tabsUngroup.at(-1), 99);
const releaseTabs = await hostRequest(port, "getTabs", {
  session_id: "release-session",
  turn_id: "turn",
});
assert.deepEqual(releaseTabs.result.tabs, []);

const handoffCreated = await hostRequest(port, "createTab", {
  session_id: "keep-session",
  turn_id: "turn",
  url: "https://handoff.example/",
});
const deliverableCreated = await hostRequest(port, "createTab", {
  session_id: "keep-session",
  turn_id: "turn",
  url: "https://deliverable.example/",
});
const handoffTabId = handoffCreated.result.tab.tabId;
const deliverableTabId = deliverableCreated.result.tab.tabId;
const activeGroupId = tabs.get(handoffTabId).groupId;
const kept = await hostRequest(port, "finalizeTabs", {
  session_id: "keep-session",
  turn_id: "turn",
  keep: [
    { tabId: handoffTabId, status: "handoff" },
    { tabId: deliverableTabId, status: "deliverable" },
  ],
});
assert.deepEqual(kept.result.closedTabIds, []);
assert.deepEqual(kept.result.releasedTabIds, []);
assert.equal(kept.result.keptTabs.length, 2);
assert.equal(kept.result.deliverableTabs[0].tabId, deliverableTabId);
assert.equal(tabs.get(handoffTabId).groupId, activeGroupId);
assert.notEqual(tabs.get(deliverableTabId).groupId, activeGroupId);
const keptSessionTabs = await hostRequest(port, "getTabs", {
  session_id: "keep-session",
  turn_id: "turn",
});
assert.deepEqual(
  keptSessionTabs.result.tabs.map((tab) => [tab.tabId, tab.status]),
  [[handoffTabId, "handoff"]],
);
assert.deepEqual(
  keptSessionTabs.result.deliverableTabs.map((tab) => [tab.tabId, tab.status]),
  [[deliverableTabId, "deliverable"]],
);
const statusWithDeliverable = await popupMessage({ type: "GET_NATIVE_HOST_STATUS" });
assert.equal(statusWithDeliverable.deliverableTabs, 1);
const deliverableCdp = await hostRequest(port, "executeCdp", {
  session_id: "keep-session",
  turn_id: "turn",
  target: { tabId: deliverableTabId },
  method: "Runtime.evaluate",
});
assert.match(deliverableCdp.error.message, /not owned by this open-browser-use session/);
assert.deepEqual(
  sessionStateTabs("keep-session").map((tab) => [tab.tabId, tab.status]),
  [
    [handoffTabId, "handoff"],
    [deliverableTabId, "deliverable"],
  ],
);

const restartSessionPortCount = ports.length;
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-session-state=${Date.now()}`);
const restoredPort = await waitFor(() => ports[restartSessionPortCount]);
await waitFor(() => restoredPort.sent.find((message) => message.type === "hello"));
restoredPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");
const restoredSessionTabs = await hostRequest(restoredPort, "getTabs", {
  session_id: "keep-session",
  turn_id: "restored-turn",
});
assert.deepEqual(
  restoredSessionTabs.result.tabs.map((tab) => [tab.tabId, tab.status]),
  [[handoffTabId, "handoff"]],
);
assert.deepEqual(
  restoredSessionTabs.result.deliverableTabs.map((tab) => [tab.tabId, tab.status]),
  [[deliverableTabId, "deliverable"]],
);
const restoredDeliverableCdp = await hostRequest(restoredPort, "executeCdp", {
  session_id: "keep-session",
  turn_id: "restored-turn",
  target: { tabId: deliverableTabId },
  method: "Runtime.evaluate",
});
assert.match(restoredDeliverableCdp.error.message, /not owned by this open-browser-use session/);
const restoredClaim = await hostRequest(restoredPort, "claimUserTab", {
  session_id: "claim-session",
  turn_id: "claim-turn",
  tabId: deliverableTabId,
});
assert.equal(restoredClaim.result.tab.tabId, deliverableTabId);
assert.equal(restoredClaim.result.tab.status, "active");
assert.equal(restoredClaim.result.tab.origin, "user");
const claimedSessionTabs = await hostRequest(restoredPort, "getTabs", {
  session_id: "claim-session",
  turn_id: "claim-turn",
});
assert.deepEqual(
  claimedSessionTabs.result.tabs.map((tab) => [tab.tabId, tab.status]),
  [[deliverableTabId, "active"]],
);
const originalAfterClaimTabs = await hostRequest(restoredPort, "getTabs", {
  session_id: "keep-session",
  turn_id: "after-claim-turn",
});
assert.deepEqual(
  originalAfterClaimTabs.result.tabs.map((tab) => [tab.tabId, tab.status]),
  [[handoffTabId, "handoff"]],
);
assert.deepEqual(originalAfterClaimTabs.result.deliverableTabs, []);
const statusAfterDeliverableClaim = await popupMessageFromLatest({ type: "GET_NATIVE_HOST_STATUS" });
assert.equal(statusAfterDeliverableClaim.deliverableTabs, undefined);

tabs.delete(deliverableTabId);
const pruneSessionPortCount = ports.length;
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-session-prune=${Date.now()}`);
const prunedPort = await waitFor(() => ports[pruneSessionPortCount]);
await waitFor(() => prunedPort.sent.find((message) => message.type === "hello"));
prunedPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");
assert.deepEqual(
  sessionStateTabs("keep-session").map((tab) => [tab.tabId, tab.status]),
  [[handoffTabId, "handoff"]],
);
const prunedSessionTabs = await hostRequest(prunedPort, "getTabs", {
  session_id: "keep-session",
  turn_id: "pruned-turn",
});
assert.deepEqual(
  prunedSessionTabs.result.tabs.map((tab) => [tab.tabId, tab.status]),
  [[handoffTabId, "handoff"]],
);
assert.deepEqual(prunedSessionTabs.result.deliverableTabs, []);

const stopPromise = popupMessage({ type: "STOP_BROWSER_CONTROL" });
const stopRequest = await waitFor(() => port.sent.find((message) => message.method === "stopBrowserControl"));
port.emit({ jsonrpc: "2.0", id: stopRequest.id, result: null });
const stopped = await stopPromise;
assert.equal(stopped.state, "stopped");
assert.equal(port.disconnected, true);
assert.equal(storage[statusKey].state, "stopped");
assert.equal(calls.debuggerDetach[0].tabId, 1);

const resumePortIndex = ports.length;
const resumePromise = popupMessage({ type: "RESUME_BROWSER_CONTROL" });
const resumedPort = await waitFor(() => ports[resumePortIndex]);
await waitFor(() => resumedPort.sent.find((message) => message.type === "hello"));
resumedPort.emit({ type: "hello_ack", host_version: "0.1.0" });
const resumed = await resumePromise;
assert.equal(resumed.state, "connecting");
await waitFor(() => storage[statusKey]?.state === "connected");

await runPendingReconnectSurvivesServiceWorkerRestart();

const pendingErrorPortCount = ports.length;
const pendingErrorRetryAt = Date.now() + 5000;
storage[statusKey] = {
  state: "error",
  message: "native host exited with code 1",
  diagnosis: "native_host_crashed",
  retryDelayMs: 3000,
  nextRetryAt: pendingErrorRetryAt,
  updatedAt: Date.now(),
};
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-pending-error=${Date.now()}`);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(ports.length, pendingErrorPortCount);
assert.equal(storage[statusKey].state, "error");
assert.equal(storage[statusKey].diagnosis, "native_host_crashed");
assert.equal(storage[statusKey].retryDelayMs, 3000);
assert.equal(storage[statusKey].nextRetryAt, pendingErrorRetryAt);
assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
const pendingErrorStatus = await popupMessageFromLatest({ type: "GET_NATIVE_HOST_STATUS" });
assert.equal(pendingErrorStatus.state, "error");
assert.equal(pendingErrorStatus.diagnosis, "native_host_crashed");
assert.equal(ports.length, pendingErrorPortCount);
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const pendingErrorReconnectPort = await waitFor(() => ports[pendingErrorPortCount]);
await waitFor(() => pendingErrorReconnectPort.sent.find((message) => message.type === "hello"));
pendingErrorReconnectPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

const restartPortCount = ports.length;
storage[statusKey] = { state: "stopped", message: "Stopped by user", updatedAt: Date.now() };
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-stopped=${Date.now()}`);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(ports.length, restartPortCount);
assert.equal(storage[statusKey].state, "stopped");

storage[statusKey] = { state: "version_mismatch", message: "host too old", updatedAt: Date.now() };
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-version-mismatch=${Date.now()}`);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(ports.length, restartPortCount);
assert.equal(storage[statusKey].state, "version_mismatch");
assert.equal(storage[statusKey].diagnosis, "version_mismatch");
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(ports.length, restartPortCount);

const missingHostPortCount = ports.length;
connectNativeError = new Error("Specified native messaging host not found.");
storage[statusKey] = { state: "disconnected", updatedAt: Date.now(), retryDelayMs: 1000, nextRetryAt: Date.now() - 1 };
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-missing-host=${Date.now()}`);
await waitFor(() => storage[statusKey]?.state === "error");
assert.equal(storage[statusKey].diagnosis, "native_host_not_found");
assert.match(storage[statusKey].message, /specified native messaging host not found/i);
assert.equal(ports.length, missingHostPortCount);
assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
connectNativeError = undefined;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const missingHostRecoveryPort = await waitFor(() => ports[missingHostPortCount]);
await waitFor(() => missingHostRecoveryPort.sent.find((message) => message.type === "hello"));
missingHostRecoveryPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

const forbiddenPortCount = ports.length;
connectNativeError = new Error("Access to the specified native messaging host is forbidden.");
storage[statusKey] = { state: "disconnected", updatedAt: Date.now(), retryDelayMs: 1000, nextRetryAt: Date.now() - 1 };
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-forbidden-host=${Date.now()}`);
await waitFor(() => storage[statusKey]?.state === "error");
assert.equal(storage[statusKey].diagnosis, "native_host_forbidden");
assert.match(storage[statusKey].message, /access to the specified native messaging host is forbidden/i);
assert.equal(ports.length, forbiddenPortCount);
assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
connectNativeError = undefined;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const forbiddenRecoveryPort = await waitFor(() => ports[forbiddenPortCount]);
await waitFor(() => forbiddenRecoveryPort.sent.find((message) => message.type === "hello"));
forbiddenRecoveryPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

const unavailablePortCount = ports.length;
connectNativeError = new Error("browser refused native connection");
storage[statusKey] = { state: "disconnected", updatedAt: Date.now(), retryDelayMs: 1000, nextRetryAt: Date.now() - 1 };
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-unavailable-host=${Date.now()}`);
await waitFor(() => storage[statusKey]?.state === "error");
assert.equal(storage[statusKey].diagnosis, "native_host_unavailable");
assert.match(storage[statusKey].message, /browser refused native connection/i);
assert.equal(ports.length, unavailablePortCount);
assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
connectNativeError = undefined;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const unavailableRecoveryPort = await waitFor(() => ports[unavailablePortCount]);
await waitFor(() => unavailableRecoveryPort.sent.find((message) => message.type === "hello"));
unavailableRecoveryPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

const crashedPostMessagePortCount = ports.length;
postMessageError = new Error("native host process failed during startup");
storage[statusKey] = { state: "disconnected", updatedAt: Date.now(), retryDelayMs: 1000, nextRetryAt: Date.now() - 1 };
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-post-message-failure=${Date.now()}`);
await waitFor(() => storage[statusKey]?.state === "error");
assert.equal(storage[statusKey].diagnosis, "native_host_crashed");
assert.match(storage[statusKey].message, /native host process failed during startup/i);
assert.equal(ports.length, crashedPostMessagePortCount + 1);
assert.deepEqual(ports.at(-1).sent, []);
assert.equal(ports.at(-1).disconnected, true);
assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
postMessageError = undefined;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const crashedPostMessageRecoveryPort = await waitFor(() => ports[crashedPostMessagePortCount + 1]);
await waitFor(() => crashedPostMessageRecoveryPort.sent.find((message) => message.type === "hello"));
crashedPostMessageRecoveryPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

const helloTimeoutOriginalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  helloTimeoutOriginalSetTimeout(callback, delay === 5_000 ? 1 : delay, ...args);
const helloTimeoutPortCount = ports.length;
storage[statusKey] = { state: "disconnected", updatedAt: Date.now(), retryDelayMs: 1000, nextRetryAt: Date.now() - 1 };
try {
  await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-hello-timeout=${Date.now()}`);
  const helloTimeoutPort = await waitFor(() => ports[helloTimeoutPortCount]);
  await waitFor(() => helloTimeoutPort.sent.find((message) => message.type === "hello"));
  await waitFor(() => storage[statusKey]?.diagnosis === "native_host_hello_timeout");
  assert.equal(storage[statusKey].state, "error");
  assert.match(storage[statusKey].message, /native host hello timed out/i);
  assert.equal(helloTimeoutPort.disconnected, true);
  assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
} finally {
  globalThis.setTimeout = helloTimeoutOriginalSetTimeout;
}
const helloTimeoutRecoveryPortCount = ports.length;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const helloTimeoutRecoveryPort = await waitFor(() => ports[helloTimeoutRecoveryPortCount]);
await waitFor(() => helloTimeoutRecoveryPort.sent.find((message) => message.type === "hello"));
helloTimeoutRecoveryPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

const earlyDisconnectPortCount = ports.length;
storage[statusKey] = { state: "disconnected", updatedAt: Date.now(), retryDelayMs: 1000, nextRetryAt: Date.now() - 1 };
await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-early-disconnect=${Date.now()}`);
const earlyDisconnectPort = await waitFor(() => ports[earlyDisconnectPortCount]);
await waitFor(() => earlyDisconnectPort.sent.find((message) => message.type === "hello"));
earlyDisconnectPort.disconnect();
await waitFor(() => storage[statusKey]?.diagnosis === "native_host_crashed");
assert.equal(storage[statusKey].state, "error");
assert.match(storage[statusKey].message, /native host exited before hello_ack/i);
assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
const earlyDisconnectRecoveryPortCount = ports.length;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const earlyDisconnectRecoveryPort = await waitFor(() => ports[earlyDisconnectRecoveryPortCount]);
await waitFor(() => earlyDisconnectRecoveryPort.sent.find((message) => message.type === "hello"));
earlyDisconnectRecoveryPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  originalSetTimeout(callback, delay === 10_000 || delay === 5_000 ? 1 : delay, ...args);
const heartbeatPortCount = ports.length;
storage[statusKey] = { state: "disconnected", updatedAt: Date.now(), retryDelayMs: 1000, nextRetryAt: Date.now() - 1 };
try {
  await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-heartbeat-timeout=${Date.now()}`);
  const heartbeatPort = await waitFor(() => ports[heartbeatPortCount]);
  await waitFor(() => heartbeatPort.sent.find((message) => message.type === "hello"));
  heartbeatPort.emit({ type: "hello_ack", host_version: "0.1.0" });
  await waitFor(() => storage[statusKey]?.diagnosis === "native_host_heartbeat_timeout");
  assert.equal(storage[statusKey].state, "disconnected");
  assert.match(storage[statusKey].message, /native host heartbeat timed out/i);
  assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
} finally {
  globalThis.setTimeout = originalSetTimeout;
}
const heartbeatRecoveryPortCount = ports.length;
alarmEvents.emit({ name: "obu.reconnectNativeHost" });
const heartbeatRecoveryPort = await waitFor(() => ports[heartbeatRecoveryPortCount]);
await waitFor(() => heartbeatRecoveryPort.sent.find((message) => message.type === "hello"));
heartbeatRecoveryPort.emit({ type: "hello_ack", host_version: "0.1.0" });
await waitFor(() => storage[statusKey]?.state === "connected");

async function runNativeHostReconnectAfterConnectedCrash(connectedPort) {
  const beforeCrash = await hostRequest(connectedPort, "ping");
  assert.equal(beforeCrash.result, "pong");

  const crashedPort = connectedPort;
  const reconnectPortIndex = ports.length;
  crashedPort.disconnect();
  await waitFor(() => storage[statusKey]?.state === "disconnected");
  assert.equal(storage[statusKey].diagnosis, "native_host_disconnected");
  await waitFor(() => storage[statusKey]?.retryDelayMs === 1000);
  assert.equal(typeof storage[statusKey].nextRetryAt, "number");
  assert.ok(storage[statusKey].nextRetryAt >= Date.now());
  assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");
  assert.ok(calls.alarmsCreate.at(-1).alarmInfo.delayInMinutes > 0);

  alarmEvents.emit({ name: "unrelated" });
  assert.equal(ports.length, reconnectPortIndex);
  alarmEvents.emit({ name: "obu.reconnectNativeHost" });
  const reconnectedPort = await waitFor(() => ports[reconnectPortIndex]);
  await waitFor(() => reconnectedPort.sent.find((message) => message.type === "hello"));
  assert.ok(calls.alarmsClear.includes("obu.reconnectNativeHost"));
  reconnectedPort.emit({ type: "hello_ack", host_version: "0.1.0" });
  await waitFor(() => storage[statusKey]?.state === "connected");

  crashedPort.emit({ type: "version_mismatch", message: "stale old port" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(storage[statusKey].state, "connected");
  crashedPort.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(storage[statusKey].state, "connected");

  const afterReconnect = await hostRequest(reconnectedPort, "ping");
  assert.equal(afterReconnect.result, "pong");
  assert.equal(storage[statusKey].diagnosis, undefined);
  assert.equal(storage[statusKey].retryDelayMs, undefined);
  assert.equal(storage[statusKey].nextRetryAt, undefined);
  return reconnectedPort;
}

async function runPendingReconnectSurvivesServiceWorkerRestart() {
  const pendingReconnectPortCount = ports.length;
  const pendingRetryAt = Date.now() + 5000;
  storage[statusKey] = {
    state: "disconnected",
    message: "retry later",
    retryDelayMs: 2000,
    nextRetryAt: pendingRetryAt,
    updatedAt: Date.now(),
  };
  await import(`${pathToFileURL(path.join(packageRoot, "dist", "background.js")).href}?restart-pending-reconnect=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(ports.length, pendingReconnectPortCount);
  assert.equal(storage[statusKey].state, "disconnected");
  assert.equal(storage[statusKey].message, "retry later");
  assert.equal(storage[statusKey].retryDelayMs, 2000);
  assert.equal(storage[statusKey].nextRetryAt, pendingRetryAt);
  assert.equal(calls.alarmsCreate.at(-1).name, "obu.reconnectNativeHost");

  const pendingStatus = await popupMessageFromLatest({ type: "GET_NATIVE_HOST_STATUS" });
  assert.equal(pendingStatus.state, "disconnected");
  assert.equal(pendingStatus.message, "retry later");
  assert.equal(pendingStatus.retryDelayMs, 2000);
  assert.equal(pendingStatus.nextRetryAt, pendingRetryAt);
  assert.equal(ports.length, pendingReconnectPortCount);

  alarmEvents.emit({ name: "obu.reconnectNativeHost" });
  const pendingReconnectPort = await waitFor(() => ports[pendingReconnectPortCount]);
  await waitFor(() => pendingReconnectPort.sent.find((message) => message.type === "hello"));
  pendingReconnectPort.emit({ type: "hello_ack", host_version: "0.1.0" });
  await waitFor(() => storage[statusKey]?.state === "connected");
  assert.equal(storage[statusKey].message, undefined);
  assert.equal(storage[statusKey].diagnosis, undefined);
  assert.equal(storage[statusKey].retryDelayMs, undefined);
  assert.equal(storage[statusKey].nextRetryAt, undefined);
}

async function hostRequest(targetPort, method, params) {
  const id = 1000 + targetPort.sent.length;
  const start = targetPort.sent.length;
  targetPort.emit({ jsonrpc: "2.0", id, method, params });
  return waitFor(() =>
    targetPort.sent.slice(start).find((message) => message.jsonrpc === "2.0" && message.id === id && !message.method),
  );
}

async function popupMessage(message) {
  assert.ok(runtimeMessages.listeners[0]);
  return new Promise((resolve) => {
    const keepAlive = runtimeMessages.listeners[0](message, {}, resolve);
    assert.equal(keepAlive, true);
  });
}

async function popupMessageFromLatest(message) {
  const listener = runtimeMessages.listeners.at(-1);
  assert.ok(listener);
  return new Promise((resolve) => {
    const keepAlive = listener(message, {}, resolve);
    assert.equal(keepAlive, true);
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for background test predicate");
}

function sessionStateTabs(sessionId) {
  return storage[sessionStateKey]?.sessions?.find((session) => session.session_id === sessionId)?.tabs ?? [];
}
