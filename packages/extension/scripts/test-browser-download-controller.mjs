import assert from "node:assert/strict";

import { BrowserDownloadController } from "../dist/browser_download_controller.js";

{
  const harness = createHarness({
    historyRows: [
      { id: "1", url: "https://example.test/a", title: "A", lastVisitTime: 10, visitCount: 2, typedCount: 1 },
      { id: "2", title: "No URL" },
      { id: "3", url: "", title: "Empty URL" },
    ],
  });

  const items = await harness.controller.getUserHistory({
    query: "example",
    limit: 999.9,
    from: 100,
    to: 200,
  });

  assert.deepEqual(harness.calls.historySearch, [{
    text: "example",
    maxResults: 500,
    startTime: 100,
    endTime: 200,
  }]);
  assert.deepEqual(items, [{
    id: "1",
    url: "https://example.test/a",
    title: "A",
    lastVisitTime: 10,
    visitCount: 2,
    typedCount: 1,
  }]);
}

{
  const harness = createHarness({
    downloadsById: new Map([
      [10, { id: 10, url: "https://example.test/download", filename: "/tmp/second.csv", state: "complete" }],
    ]),
  });

  harness.controller.handleCdpEvent("session-a", 4, "Page.downloadWillBegin", {
    url: "https://example.test/download",
    suggestedFilename: "first.csv",
  });
  harness.controller.handleCdpEvent("session-b", 5, "Page.downloadWillBegin", {
    url: "https://example.test/download",
    suggestedFilename: "nested/second.csv",
  });

  assert.deepEqual(harness.controller.pendingOwnerCounts(), { byUrl: 1, byId: 0 });

  harness.controller.handleDownloadCreated({
    id: 10,
    url: "https://example.test/download",
    filename: "/Users/me/Downloads/second.csv",
  });

  assert.deepEqual(harness.controller.pendingOwnerCounts(), { byUrl: 1, byId: 1 });
  assert.equal(harness.calls.notifications.at(-1).method, "onDownloadChange");
  assert.deepEqual(harness.calls.notifications.at(-1).params, {
    session_id: "session-b",
    source: { tabId: 5 },
    id: "10",
    status: "started",
    filename: "/Users/me/Downloads/second.csv",
    url: "https://example.test/download",
  });

  await harness.controller.handleDownloadChanged({ id: 10, state: { current: "complete" } });

  assert.deepEqual(harness.controller.pendingOwnerCounts(), { byUrl: 1, byId: 0 });
  assert.equal(harness.calls.downloadSearch.length, 1);
  assert.deepEqual(harness.calls.notifications.at(-1).params, {
    session_id: "session-b",
    source: { tabId: 5 },
    id: "10",
    status: "complete",
    filename: "/tmp/second.csv",
    url: "https://example.test/download",
    error: undefined,
  });

  await harness.controller.handleDownloadChanged({ id: 10, state: { current: "complete" } });
  assert.equal(harness.calls.notifications.length, 2, "terminal state removes the id owner");
}

{
  const harness = createHarness({
    downloadsById: new Map([
      [11, {
        id: 11,
        url: "https://example.test/fail",
        filename: "/tmp/fail.csv",
        state: "interrupted",
        error: "USER_CANCELED",
      }],
    ]),
  });

  harness.controller.handleCdpEvent("session-a", 4, "Page.downloadWillBegin", {
    url: "https://example.test/fail",
  });
  harness.controller.handleDownloadCreated({ id: 11, url: "https://example.test/fail", filename: "/tmp/fail.csv" });
  await harness.controller.handleDownloadChanged({ id: 11, state: { current: "interrupted" } });

  assert.equal(harness.calls.logs.at(-1).level, "warn");
  assert.deepEqual(harness.calls.notifications.at(-1).params, {
    session_id: "session-a",
    source: { tabId: 4 },
    id: "11",
    status: "failed",
    filename: "/tmp/fail.csv",
    url: "https://example.test/fail",
    error: "USER_CANCELED",
  });
  assert.deepEqual(harness.controller.pendingOwnerCounts(), { byUrl: 0, byId: 0 });
}

{
  const harness = createHarness();

  harness.controller.handleCdpEvent("session-a", 8, "Runtime.consoleAPICalled", {
    url: "https://example.test/ignored",
  });
  assert.deepEqual(harness.controller.pendingOwnerCounts(), { byUrl: 0, byId: 0 });

  harness.controller.handleCdpEvent("session-a", 8, "Page.downloadWillBegin", {
    url: "https://example.test/owned-id",
  });
  harness.controller.handleCdpEvent("session-b", 9, "Page.downloadWillBegin", {
    url: "https://example.test/kept",
  });
  harness.controller.handleCdpEvent("session-a", 8, "Page.downloadWillBegin", {
    url: "https://example.test/queued",
  });
  harness.controller.handleDownloadCreated({
    id: 12,
    url: "https://example.test/owned-id",
    filename: "/tmp/owned-id.csv",
  });

  assert.deepEqual(harness.controller.pendingOwnerCounts(), { byUrl: 2, byId: 1 });

  harness.controller.removeDownloadOwnersForTab(8);

  assert.deepEqual(harness.controller.pendingOwnerCounts(), { byUrl: 1, byId: 0 });
}

function createHarness(overrides = {}) {
  const calls = {
    historySearch: [],
    downloadSearch: [],
    notifications: [],
    logs: [],
  };
  const downloadsById = overrides.downloadsById ?? new Map();
  const controller = new BrowserDownloadController({
    historySearch: async (query) => {
      calls.historySearch.push(query);
      return overrides.historyRows ?? [];
    },
    downloadSearch: async (query) => {
      calls.downloadSearch.push(query);
      return query.id === undefined ? [] : [downloadsById.get(query.id)].filter(Boolean);
    },
    sendNotification: (method, params) => {
      calls.notifications.push({ method, params });
    },
    appendDebugLog: (level, event, data) => {
      calls.logs.push({ level, event, data });
    },
  });
  return { controller, calls };
}
