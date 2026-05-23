import { afterEach, describe, expect, it } from "vitest";
import { Browser } from "../src/browser.js";
import { BrowserTabs } from "../src/browser_tabs.js";
import { UserTabRef } from "../src/browser_user.js";
import { display } from "../src/display.js";
import { Download } from "../src/download.js";
import { FileChooser } from "../src/file-chooser.js";
import { Guards, METHOD_CLASSIFICATION } from "../src/guards.js";
import { Image } from "../src/image.js";
import { Locator } from "../src/locator.js";
import { Tab } from "../src/tab.js";
import { ObuError, ERR_DISALLOWED } from "../src/errors.js";
import * as M from "../src/wire/methods.js";
import type { Transport } from "../src/wire/transport.js";

const meta = { session_id: "session", turn_id: "turn" };

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];
  responses = new Map<string, unknown>();
  requestLifecycle: unknown[] = [];

  constructor() {
    this.responses.set(M.GET_TABS, [
      {
        tab_id: "tab-a",
        target_id: "target-a",
        url: "https://a.test/",
        title: "A",
        origin: "agent",
        status: "deliverable",
        active: true,
        logicalActive: true,
        windowId: 3,
        groupId: 4,
        pinned: false,
      },
      { id: "tab-b" },
    ]);
    this.responses.set(M.GET_CURRENT_TAB, {
      tab_id: "tab-a",
      url: "https://a.test/",
      title: "A",
      origin: "agent",
      status: "active",
      commandable: true,
      logicalActive: true,
    });
    this.responses.set(M.GET_SELECTED_TAB, {
      tab_id: "selected-user",
      url: "https://selected.test/",
      title: "Selected",
      origin: "user",
      status: "active",
      commandable: false,
      claimRequired: true,
    });
    this.responses.set(M.CREATE_TAB, {
      id: "created-tab",
      url: "https://new.test/",
      title: "New",
      origin: "agent",
      status: "active",
    });
    this.responses.set(M.TAB_URL, "https://example.test/");
    this.responses.set(M.TAB_TITLE, "Example");
    this.responses.set(M.TAB_SCREENSHOT, { data: "base64png", mime_type: "image/png" });
    this.responses.set(M.TAB_CONTENT_EXPORT, { data: "html64", data_base64: "html64", mime_type: "text/html" });
    this.responses.set(M.TAB_EVALUATE, {
      result: { value: { __obu_evaluate_value: { title: "Example" } } },
    });
    this.responses.set(M.TAB_SNAPSHOT_TEXT, {
      result: { value: { __obu_evaluate_value: { title: "Example" } } },
    });
    this.responses.set(M.BROWSER_TABS_CONTENT, {
      results: [
        { url: "https://a.test/", finalUrl: "https://a.test/", status: "ok", text: "A" },
        { url: "https://b.test/", status: "error", errorCode: "fetch_failed", errorMessage: "boom" },
      ],
    });
    this.responses.set(M.BROWSER_VIEWPORT_SET, {
      width: 640,
      height: 480,
      deviceScaleFactor: 2,
      mobile: false,
      tabId: 1,
    });
    this.responses.set(M.BROWSER_VIEWPORT_RESET, { reset: true, tabId: 1 });
    this.responses.set(M.BROWSER_VISIBILITY_SET, {
      visible: true,
      focused: true,
      windowId: 1,
      state: "normal",
    });
    this.responses.set(M.BROWSER_VISIBILITY_GET, {
      visible: true,
      focused: true,
      windowId: 1,
      state: "normal",
    });
    this.responses.set(M.PLAYWRIGHT_DOM_SNAPSHOT, {
      domSnapshot: "role: document\n  button: Save",
      source: "playwright_dom_snapshot",
    });
    this.responses.set(M.PLAYWRIGHT_LOCATOR_IS_VISIBLE, true);
    this.responses.set(M.PLAYWRIGHT_LOCATOR_COUNT, 2);
    this.responses.set(M.PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE, "button");
    this.responses.set(M.PLAYWRIGHT_LOCATOR_READ_ALL, [
      {
        attributes: { "data-kind": "primary", role: "button" },
        inner_text: "Save",
        text_content: " Save ",
      },
      {
        attributes: { "data-kind": "secondary", role: "button" },
        inner_text: "Cancel",
        text_content: " Cancel ",
      },
    ]);
    this.responses.set(M.PLAYWRIGHT_LOCATOR_BOUNDING_BOX, { x: 1, y: 2, width: 3, height: 4 });
    this.responses.set(M.PLAYWRIGHT_SCREENSHOT, { data: "cropped64" });
    this.responses.set(M.PLAYWRIGHT_ELEMENT_INFO, {
      node_id: "7",
      backendNodeId: 7,
      nodeName: "BUTTON",
      point: { x: 10, y: 20 },
    });
    this.responses.set(M.PLAYWRIGHT_ELEMENT_SCREENSHOT, { data: "element64", mime_type: "image/png" });
    this.responses.set(M.PLAYWRIGHT_DOWNLOAD_PATH, { path: "/tmp/download.txt" });
    this.responses.set(M.FINALIZE_TABS, {
      status: "ok",
      actions: [],
      closedTabIds: [],
      releasedTabIds: [],
      keptTabs: [],
      deliverableTabs: [],
      finalTabs: { handoff: [], deliverable: [], activeTabId: null },
      failures: [],
      diagnostics: { reconciledFromChrome: true, reconciliationSource: "chrome.tabs" },
    });
  }

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    return (this.responses.has(method) ? this.responses.get(method) : null) as T;
  }

  diagnostics(): { request_lifecycle: unknown[] } {
    return { request_lifecycle: this.requestLifecycle };
  }
}

class NavigationFakeTransport extends FakeTransport {
  constructor(private readonly urls: string[]) {
    super();
  }

  override async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    if (method === M.TAB_URL) {
      this.calls.push({ method, params, timeout });
      const fallback = this.urls[this.urls.length - 1] ?? "about:blank";
      return (this.urls.shift() ?? fallback) as T;
    }
    return await super.sendRequest<T>(method, params, timeout);
  }
}

function setRequestMeta(): () => void {
  const global = globalThis as { obuRepl?: { requestMeta?: unknown } };
  const original = global.obuRepl;
  global.obuRepl = {
    requestMeta: {
      "x-obu-turn-metadata": meta,
    },
  };
  return () => {
    global.obuRepl = original;
  };
}

function asTransport(transport: FakeTransport): Transport {
  return transport as unknown as Transport;
}

describe("SDK wire-shape contracts", () => {
  afterEach(() => {
    delete (globalThis as { display?: unknown }).display;
    delete (globalThis as { nodeRepl?: unknown }).nodeRepl;
  });

  it("Tab delegates navigation, metadata, screenshot, and lifecycle calls with tab id and timeout", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "tab-1");

    try {
      await tab.goto("https://example.test/", { timeout: 100 });
      await tab.reload({ timeout: 101 });
      await tab.back({ timeout: 102 });
      await tab.forward({ timeout: 103 });
      await expect(tab.url({ timeout: 104 })).resolves.toBe("https://example.test/");
      await expect(tab.title({ timeout: 105 })).resolves.toBe("Example");
      const screenshot = await tab.screenshot({ timeout: 106 });
      expect(screenshot).toBeInstanceOf(Image);
      expect(screenshot).toMatchObject({ data_base64: "base64png", mime_type: "image/png" });
      expect(screenshot.toBase64()).toBe("base64png");
      await expect(tab.screenshot({
        type: "jpeg",
        quality: 60,
        fullPage: false,
        clip: { x: 1, y: 2, width: 300, height: 200, scale: 0.5 },
        timeout: 106,
      })).resolves.toMatchObject({ data_base64: "base64png", mime_type: "image/png" });
      await tab.attach({ timeout: 107 });
      await tab.detach({ timeout: 108 });
      await tab.close({ timeout: 109 });
      await tab.waitForURL("https://example.test/done", { timeout: 109 });
      await tab.waitForUrl("https://example.test/alias", { timeout: 110 });
      await tab.waitForLoadState("domcontentloaded", { timeout: 111 });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.TAB_GOTO, params: { tab_id: "tab-1", url: "https://example.test/", ...meta }, timeout: 100 },
      { method: M.TAB_RELOAD, params: { tab_id: "tab-1", ...meta }, timeout: 101 },
      { method: M.TAB_BACK, params: { tab_id: "tab-1", ...meta }, timeout: 102 },
      { method: M.TAB_FORWARD, params: { tab_id: "tab-1", ...meta }, timeout: 103 },
      { method: M.TAB_URL, params: { tab_id: "tab-1", ...meta }, timeout: 104 },
      { method: M.TAB_TITLE, params: { tab_id: "tab-1", ...meta }, timeout: 105 },
      { method: M.TAB_SCREENSHOT, params: { tab_id: "tab-1", ...meta }, timeout: 106 },
      {
        method: M.TAB_SCREENSHOT,
        params: {
          tab_id: "tab-1",
          type: "jpeg",
          quality: 60,
          fullPage: false,
          clip: { x: 1, y: 2, width: 300, height: 200, scale: 0.5 },
          ...meta,
        },
        timeout: 106,
      },
      { method: M.ATTACH, params: { tab_id: "tab-1", ...meta }, timeout: 107 },
      { method: M.DETACH, params: { tab_id: "tab-1", ...meta }, timeout: 108 },
      { method: M.TAB_CLOSE, params: { tab_id: "tab-1", ...meta }, timeout: 109 },
      { method: M.TAB_WAIT_FOR_URL, params: { tab_id: "tab-1", url: "https://example.test/done", ...meta }, timeout: 109 },
      { method: M.TAB_WAIT_FOR_URL, params: { tab_id: "tab-1", url: "https://example.test/alias", ...meta }, timeout: 110 },
      { method: M.TAB_WAIT_FOR_LOAD_STATE, params: { tab_id: "tab-1", state: "domcontentloaded", ...meta }, timeout: 111 },
    ]);
  });

  it("Tab.domSnapshot sends the public DOM snapshot method and returns the stable string shape", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "tab-a");

    try {
      await expect(tab.domSnapshot({ timeout: 444 })).resolves.toEqual({
        domSnapshot: "role: document\n  button: Save",
        source: "playwright_dom_snapshot",
      });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.PLAYWRIGHT_DOM_SNAPSHOT, params: { tab_id: "tab-a", ...meta }, timeout: 444 },
    ]);
  });

  it("Tab.playwright point inspection delegates to point-level wire methods", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const guardedCommands: Record<string, unknown>[] = [];
    const tab = new Tab(
      asTransport(transport),
      new Guards({ beforeCommand: (command) => guardedCommands.push(command) }),
      "tab-a",
    );

    try {
      await expect(tab.playwright.elementInfo({
        x: 10,
        y: 20,
        includeNonInteractable: true,
        timeout: 333,
      })).resolves.toMatchObject({
        node_id: "7",
        point: { x: 10, y: 20 },
      });
      const screenshot = await tab.playwright.elementScreenshot({ x: 30, y: 40, timeout: 334 });
      expect(screenshot).toBeInstanceOf(Image);
      expect(screenshot.toBase64()).toBe("element64");
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.PLAYWRIGHT_ELEMENT_INFO,
        params: {
          tab_id: "tab-a",
          x: 10,
          y: 20,
          includeNonInteractable: true,
          ...meta,
        },
        timeout: 333,
      },
      {
        method: M.PLAYWRIGHT_ELEMENT_SCREENSHOT,
        params: {
          tab_id: "tab-a",
          x: 30,
          y: 40,
          includeNonInteractable: undefined,
          ...meta,
        },
        timeout: 334,
      },
    ]);
    expect(guardedCommands).toEqual([
      {
        command: M.PLAYWRIGHT_ELEMENT_INFO,
        tab_id: "tab-a",
        x: 10,
        y: 20,
        includeNonInteractable: true,
      },
      {
        command: M.PLAYWRIGHT_ELEMENT_SCREENSHOT,
        tab_id: "tab-a",
        x: 30,
        y: 40,
        includeNonInteractable: undefined,
      },
    ]);
  });

  it("Tab waitForNavigation wraps an action and waits for changed URL plus load state", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new NavigationFakeTransport([
      "https://start.test/",
      "https://start.test/",
      "https://done.test/",
    ]);
    const tab = new Tab(asTransport(transport), new Guards(), "tab-1");

    try {
      await expect(
        tab.waitForNavigation(
          async () => {
            await tab.locator("#next").click({ timeout: 120 });
            return "clicked";
          },
          {
            url: /done\.test/,
            waitUntil: "domcontentloaded",
            timeout: 500,
            pollInterval: 0,
          },
        ),
      ).resolves.toBe("clicked");
    } finally {
      restoreMeta();
    }

    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_URL,
      M.PLAYWRIGHT_LOCATOR_CLICK,
      M.TAB_URL,
      M.TAB_WAIT_FOR_LOAD_STATE,
    ]);
    expect(transport.calls.at(-1)).toEqual({
      method: M.TAB_WAIT_FOR_LOAD_STATE,
      params: { tab_id: "tab-1", state: "domcontentloaded", ...meta },
      timeout: expect.any(Number),
    });
  });

  it("BrowserTabs delegates list and create and normalizes tab identifiers", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tabs = new BrowserTabs(asTransport(transport), new Guards());

    try {
      const listed = await tabs.list();
      const current = await tabs.current();
      const selected = await tabs.selected();
      const created = await tabs.create({ url: "https://new.test/" });
      const direct = tabs.get("manual-tab");

      expect(listed.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
      expect(listed[0].metadata).toMatchObject({
        target_id: "target-a",
        url: "https://a.test/",
        title: "A",
        origin: "agent",
        status: "deliverable",
        active: true,
        logicalActive: true,
        windowId: 3,
        groupId: 4,
        pinned: false,
      });
      expect(current?.id).toBe("tab-a");
      expect(current?.metadata).toMatchObject({ commandable: true, logicalActive: true });
      expect(selected).toBeInstanceOf(UserTabRef);
      expect(selected?.id).toBe("selected-user");
      expect(selected?.metadata).toMatchObject({
        claimRequired: true,
        commandable: false,
        url: "https://selected.test/",
      });
      expect(created.id).toBe("created-tab");
      expect(created.metadata).toMatchObject({
        url: "https://new.test/",
        title: "New",
        origin: "agent",
        status: "active",
      });
      expect(direct.id).toBe("manual-tab");
      expect(direct.metadata).toMatchObject({
        owned: false,
        commandable: false,
        claimRequired: true,
      });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.GET_TABS, params: { ...meta }, timeout: undefined },
      { method: M.GET_CURRENT_TAB, params: { ...meta }, timeout: undefined },
      { method: M.GET_SELECTED_TAB, params: { ...meta }, timeout: undefined },
      { method: M.CREATE_TAB, params: { url: "https://new.test/", ...meta }, timeout: undefined },
    ]);
  });

  it("BrowserTabs enforces current/selected ownership and malformed response boundaries", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tabs = new BrowserTabs(asTransport(transport), new Guards());

    try {
      transport.responses.set(M.GET_CURRENT_TAB, null);
      await expect(tabs.current()).resolves.toBeUndefined();

      transport.responses.set(M.GET_SELECTED_TAB, {
        tab_id: "selected-agent",
        url: "https://agent.test/",
        origin: "agent",
        status: "active",
        commandable: true,
        logical_active: true,
        window_id: 5,
        claim_required: false,
      });
      const commandableSelected = await tabs.selected();
      expect(commandableSelected).toBeInstanceOf(Tab);
      expect(commandableSelected?.id).toBe("selected-agent");
      expect(commandableSelected?.metadata).toMatchObject({
        commandable: true,
        logicalActive: true,
        windowId: 5,
        claimRequired: false,
      });

      transport.responses.set(M.GET_SELECTED_TAB, null);
      await expect(tabs.selected()).resolves.toBeUndefined();

      transport.responses.set(M.GET_CURRENT_TAB, { url: "https://missing-id.test/" });
      await expect(tabs.current()).rejects.toThrow("getCurrentTab response missing tab_id");

      transport.responses.set(M.GET_SELECTED_TAB, { url: "https://missing-id.test/" });
      await expect(tabs.selected()).rejects.toThrow("getSelectedTab response missing tab_id");
    } finally {
      restoreMeta();
    }
  });

  it("non-commandable tab handles fail locally before transport commands", async () => {
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "user-tab", {
      commandable: false,
      claimRequired: true,
      owned: false,
    });
    const direct = new BrowserTabs(asTransport(transport), new Guards()).get("manual-tab");

    await expect(tab.goto("https://example.test/")).rejects.toThrow(/not commandable/);
    await expect(tab.content.export()).rejects.toThrow(/not commandable/);
    await expect(tab.cua.click(1, 2)).rejects.toThrow(/not commandable/);
    await expect(tab.cua.get_visible_screenshot()).rejects.toThrow(/not commandable/);
    await expect(tab.dom_cua.get_visible_dom()).rejects.toThrow(/not commandable/);
    await expect(tab.dom_cua.click("node-1")).rejects.toThrow(/not commandable/);
    await expect(tab.dev.cdp("Runtime.evaluate", { expression: "1" })).rejects.toThrow(/not commandable/);
    await expect(tab.playwright.elementInfo({ x: 1, y: 2 })).rejects.toThrow(/not commandable/);
    await expect(tab.clipboard.readText()).rejects.toThrow(/not commandable/);
    await expect(tab.clipboard.writeText("text")).rejects.toThrow(/not commandable/);
    await expect(tab.locator("button").click()).rejects.toThrow(/not commandable/);
    await expect(direct.goto("https://example.test/")).rejects.toThrow(/not commandable/);
    expect(transport.calls).toEqual([]);
  });

  it("BrowserTabs creates about:blank by default and rejects malformed options", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tabs = new BrowserTabs(asTransport(transport), new Guards());

    try {
      await tabs.create();
      await expect(tabs.create({ url: 123 } as never)).rejects.toThrow(
        "browser.tabs.create expected a URL string or { url: string }",
      );
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.CREATE_TAB, params: { url: "about:blank", ...meta }, timeout: undefined },
    ]);
  });

  it("BrowserTabs.content validates URLs, preserves ordering, and returns partial results", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tabs = new BrowserTabs(asTransport(transport), new Guards());

    try {
      await expect(tabs.content({ urls: ["https://a.test/", "https://b.test/"], contentType: "html", timeout: 777 }))
        .resolves
        .toEqual({
          results: [
            { url: "https://a.test/", finalUrl: "https://a.test/", status: "ok", text: "A" },
            { url: "https://b.test/", status: "error", errorCode: "fetch_failed", errorMessage: "boom" },
          ],
        });
      await expect(tabs.content({ urls: [""] })).rejects.toThrow("urls must be non-empty strings");
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.BROWSER_TABS_CONTENT,
        params: { urls: ["https://a.test/", "https://b.test/"], contentType: "html", timeout: 777, ...meta },
        timeout: 2554,
      },
    ]);
  });

  it("BrowserTabs.content turns local guard denials into per-URL failures", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const guards = new Guards({
      checkNavigation(url) {
        if (url === "https://b.test/") throw new Error("blocked by test policy");
      },
    });
    const tabs = new BrowserTabs(asTransport(transport), guards);

    try {
      await expect(tabs.content({
        urls: ["https://a.test/", "https://b.test/"],
        timeout: 500,
        requestTimeout: 5000,
      })).resolves.toEqual({
        results: [
          { url: "https://a.test/", finalUrl: "https://a.test/", status: "ok", text: "A" },
          {
            url: "https://b.test/",
            status: "error",
            errorCode: "disallowed_command",
            errorMessage: "Error: blocked by test policy",
          },
        ],
      });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.BROWSER_TABS_CONTENT,
        params: { urls: ["https://a.test/"], timeout: 500, ...meta },
        timeout: 5000,
      },
    ]);
  });

  it("Browser delegates lifecycle naming, turn end, and finalization calls", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.CLEAR_LIFECYCLE_DIAGNOSTICS, {
      cleared: { stale_sessions: 1, stale_tabs: 2, stale_file_choosers: 0, stale_downloads: 0 },
      diagnostics: { lifecycle: { stale_sessions: 0, stale_tabs: 0 } },
    });
    transport.responses.set(M.RESUME_CONTROL, {
      tab: { tab_id: "tab-active", url: "https://example.com/", commandable: true },
    });
    const browser = new Browser(
      asTransport(transport),
      { type: "cdp", name: "cdp", capabilities: {} },
      { type: "cdp", name: "cdp", socketPath: "/tmp/cdp", metadata: {} },
      new Guards(),
    );

    try {
      await browser.name("Research");
      await browser.turnEnded({ timeout: 200 });
      await browser.yieldControl({ timeout: 199 });
      const resumed = await browser.resumeControl({ timeout: 198 });
      expect(resumed?.id).toBe("tab-active");
      expect(resumed?.metadata.commandable).toBe(true);
      await browser.finalizeTabs({
        keep: [
          { tabId: "tab-handoff", status: "handoff" },
          { tab: { id: "tab-deliverable" }, status: "deliverable" },
        ],
        timeout: 201,
      });
      await expect(browser.clearLifecycleDiagnostics({ timeout: 202 })).resolves.toEqual({
        cleared: { stale_sessions: 1, stale_tabs: 2, stale_file_choosers: 0, stale_downloads: 0 },
        diagnostics: { lifecycle: { stale_sessions: 0, stale_tabs: 0 } },
      });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.NAME_SESSION, params: { label: "Research", ...meta }, timeout: undefined },
      { method: M.TURN_ENDED, params: { ...meta }, timeout: 200 },
      { method: M.YIELD_CONTROL, params: { ...meta }, timeout: 199 },
      { method: M.RESUME_CONTROL, params: { ...meta }, timeout: 198 },
      {
        method: M.FINALIZE_TABS,
        params: {
          keep: [
            { tab_id: "tab-handoff", status: "handoff" },
            { tab_id: "tab-deliverable", status: "deliverable" },
          ],
          ...meta,
        },
        timeout: 201,
      },
      { method: M.CLEAR_LIFECYCLE_DIAGNOSTICS, params: { ...meta }, timeout: 202 },
    ]);
  });

  it("Browser resumeControl accepts wrapped, bare, and empty tab response shapes", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const browser = new Browser(
      asTransport(transport),
      { type: "webextension", name: "chrome", capabilities: {} },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      transport.responses.set(M.RESUME_CONTROL, {
        tab_id: "bare-active",
        url: "https://bare.test/",
        logical_active: true,
        commandable: true,
      });
      const bare = await browser.resumeControl({ timeout: 301 });
      expect(bare?.id).toBe("bare-active");
      expect(bare?.metadata).toMatchObject({
        url: "https://bare.test/",
        logicalActive: true,
        commandable: true,
      });

      transport.responses.set(M.RESUME_CONTROL, {
        tab: {
          tab_id: "wrapped-active",
          url: "https://wrapped.test/",
          logical_active: true,
          commandable: true,
        },
        repair: {
          status: "repair_required",
          nextActiveTabId: 7,
          diagnostics: [{ kind: "active_tab_removed", tabId: 3 }],
          cleanup: [{ tabId: 3, effects: ["remove_session_tab"] }],
        },
      });
      const repaired = await browser.resumeControlResult({ timeout: 302 });
      expect(repaired.status).toBe("resumed");
      expect(repaired.tab.id).toBe("wrapped-active");
      expect(repaired.repair).toEqual({
        status: "repair_required",
        nextActiveTabId: 7,
        diagnostics: [{ kind: "active_tab_removed", tabId: 3 }],
        cleanup: [{ tabId: 3, effects: ["remove_session_tab"] }],
      });

      transport.responses.set(M.RESUME_CONTROL, {
        tab: null,
        repair: {
          status: "blocked",
          reason: "no_active_tab",
          diagnostics: [{ kind: "active_tab_removed", tabId: 9 }],
          cleanup: [],
        },
      });
      await expect(browser.resumeControlResult({ timeout: 303 })).resolves.toEqual({
        status: "blocked",
        repair: {
          status: "blocked",
          reason: "no_active_tab",
          diagnostics: [{ kind: "active_tab_removed", tabId: 9 }],
          cleanup: [],
        },
      });

      transport.responses.set(M.RESUME_CONTROL, { tab: null });
      await expect(browser.resumeControl({ timeout: 304 })).resolves.toBeUndefined();

      transport.responses.set(M.RESUME_CONTROL, null);
      await expect(browser.resumeControl({ timeout: 305 })).resolves.toBeUndefined();

      transport.responses.set(M.RESUME_CONTROL, { tab: { url: "https://missing-id.test/" } });
      await expect(browser.resumeControl({ timeout: 306 })).rejects.toThrow(
        "resumeControl response missing tab_id",
      );
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.RESUME_CONTROL, params: { ...meta }, timeout: 301 },
      { method: M.RESUME_CONTROL, params: { ...meta }, timeout: 302 },
      { method: M.RESUME_CONTROL, params: { ...meta }, timeout: 303 },
      { method: M.RESUME_CONTROL, params: { ...meta }, timeout: 304 },
      { method: M.RESUME_CONTROL, params: { ...meta }, timeout: 305 },
      { method: M.RESUME_CONTROL, params: { ...meta }, timeout: 306 },
    ]);
  });

  it("Browser.finalizeTabs exposes structured partial diagnostics and successful results", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.FINALIZE_TABS, {
      status: "partial",
      actions: [
        {
          tabId: 7,
          origin: "agent",
          desiredStatus: "handoff",
          outcome: "failed",
          errorCode: "failed_to_finalize",
          errorMessage: "synthetic failure",
        },
        {
          tabId: 8,
          origin: "agent",
          desiredStatus: "deliverable",
          outcome: "kept_deliverable",
        },
      ],
      closedTabIds: [9],
      releasedTabIds: [],
      keptTabs: [{ id: "8", status: "deliverable", url: "https://deliverable.test/" }],
      deliverableTabs: [{ id: "8", status: "deliverable", url: "https://deliverable.test/" }],
      finalTabs: {
        handoff: [],
        deliverable: [{ id: "8", status: "deliverable", url: "https://deliverable.test/" }],
        activeTabId: null,
      },
      failures: [
        {
          tabId: 7,
          desiredStatus: "handoff",
          outcome: "failed",
          errorCode: "failed_to_finalize",
          errorMessage: "synthetic failure",
        },
      ],
      diagnostics: { reconciledFromChrome: true, reconciliationSource: "chrome.tabs" },
    });
    const browser = new Browser(
      asTransport(transport),
      { type: "webextension", name: "chrome", capabilities: {} },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      const result = await browser.finalizeTabs({
        keep: [
          { tabId: 7, status: "handoff" },
          { tabId: 8, status: "deliverable" },
        ],
      });

      expect(result.status).toBe("partial");
      if (result.status === "fatal") throw new Error("expected partial finalize result");
      expect(result.closedTabIds).toEqual(["9"]);
      expect(result.deliverableTabs[0]?.id).toBe("8");
      expect(result.finalTabs.deliverable[0]?.id).toBe("8");
      expect(result.actions.map((action) => [action.tabId, action.desiredStatus, action.outcome])).toEqual([
        ["7", "handoff", "failed"],
        ["8", "deliverable", "kept_deliverable"],
      ]);
      expect(result.failures).toEqual([
        {
          tabId: "7",
          desiredStatus: "handoff",
          outcome: "failed",
          errorCode: "failed_to_finalize",
          errorMessage: "synthetic failure",
        },
      ]);
      expect(result.diagnostics).toEqual({ reconciledFromChrome: true, reconciliationSource: "chrome.tabs" });
    } finally {
      restoreMeta();
    }
  });

  it("Browser.finalizeTabs normalizes legacy wire aliases to the strict public shape", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.FINALIZE_TABS, {
      status: "ok",
      actions: [
        {
          tab_id: "target-7",
          origin: "agent",
          desired_status: "handoff",
          outcome: "kept_handoff",
        },
      ],
      closed_tab_ids: ["closed-target"],
      released_tab_ids: ["released-target"],
      kept_tabs: [{ id: "target-7", status: "handoff", url: "https://handoff.test/" }],
      deliverable_tabs: [],
      final_tabs: {
        handoff: [{ id: "target-7", status: "handoff", url: "https://handoff.test/" }],
        deliverable: [],
        active_tab_id: "target-7",
      },
      failures: [],
      diagnostics: { reconciled_from_chrome: true, reconciliation_source: "chrome.tabs" },
    });
    const browser = new Browser(
      asTransport(transport),
      { type: "webextension", name: "chrome", capabilities: {} },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      await expect(browser.finalizeTabs()).resolves.toEqual({
        status: "ok",
        actions: [
          {
            tabId: "target-7",
            origin: "agent",
            desiredStatus: "handoff",
            outcome: "kept_handoff",
          },
        ],
        closedTabIds: ["closed-target"],
        releasedTabIds: ["released-target"],
        keptTabs: [{ id: "target-7", status: "handoff", url: "https://handoff.test/" }],
        deliverableTabs: [],
        finalTabs: {
          handoff: [{ id: "target-7", status: "handoff", url: "https://handoff.test/" }],
          deliverable: [],
          activeTabId: "target-7",
        },
        failures: [],
        diagnostics: { reconciledFromChrome: true, reconciliationSource: "chrome.tabs" },
      });
    } finally {
      restoreMeta();
    }
  });

  it("Browser.finalizeTabs exposes fatal reconciliation results without success aliases", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.FINALIZE_TABS, {
      status: "partial",
      actions: [
        {
          tabId: 42,
          origin: "agent",
          desiredStatus: "close",
          outcome: "failed",
          errorCode: "close_failed",
          errorMessage: "could not close tab",
        },
      ],
      closedTabIds: [7],
      releasedTabIds: [],
      keptTabs: [],
      deliverableTabs: [],
      finalTabs: null,
      failures: [
        {
          outcome: "failed",
          errorCode: "finalize_reconciliation_failed",
          errorMessage: "chrome.tabs reconciliation failed",
        },
      ],
      errorCode: "finalize_reconciliation_failed",
      errorMessage: "chrome.tabs reconciliation failed",
      diagnostics: { reconciledFromChrome: false, reconciliationSource: "chrome.tabs" },
    });
    const browser = new Browser(
      asTransport(transport),
      { type: "webextension", name: "chrome", capabilities: {} },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      await expect(browser.finalizeTabs()).resolves.toEqual({
        status: "fatal",
        actions: [
          {
            tabId: "42",
            origin: "agent",
            desiredStatus: "close",
            outcome: "failed",
            errorCode: "close_failed",
            errorMessage: "could not close tab",
          },
        ],
        closedTabIds: ["7"],
        releasedTabIds: [],
        keptTabs: [],
        deliverableTabs: [],
        finalTabs: null,
        failures: [
          {
            outcome: "failed",
            errorCode: "finalize_reconciliation_failed",
            errorMessage: "chrome.tabs reconciliation failed",
          },
        ],
        errorCode: "finalize_reconciliation_failed",
        errorMessage: "chrome.tabs reconciliation failed",
        diagnostics: { reconciledFromChrome: false, reconciliationSource: "chrome.tabs" },
      });
    } finally {
      restoreMeta();
    }
  });

  it("Browser exposes backend method capabilities", () => {
    const transport = new FakeTransport();
    const browser = new Browser(
      asTransport(transport),
      {
        type: "cdp",
        name: "cdp",
        metadata: {
          diagnostics: {
            lifecycle: {
              stale_tabs: 2,
              deliverable_tabs: 1,
            },
          },
        },
        capabilities: {
          supported_methods: [M.GET_INFO, M.PLAYWRIGHT_LOCATOR_CLICK],
          unsupported_methods: [M.DOM_CUA_CLICK],
        },
      },
      { type: "cdp", name: "cdp", socketPath: "/tmp/cdp", metadata: {} },
      new Guards(),
    );

    expect(browser.supportedMethods).toEqual([M.GET_INFO, M.PLAYWRIGHT_LOCATOR_CLICK]);
    expect(browser.unsupportedMethods).toEqual([M.DOM_CUA_CLICK]);
    expect(browser.lifecycleDiagnostics).toEqual({ stale_tabs: 2, deliverable_tabs: 1 });
    expect(browser.supports(M.PLAYWRIGHT_LOCATOR_CLICK)).toBe(true);
    expect(browser.supports(M.DOM_CUA_CLICK)).toBe(false);
    expect(browser.supports(M.TAB_URL)).toBe(false);
  });

  it("Browser exposes non-sensitive profile metadata without raw profile paths", async () => {
    const transport = new FakeTransport();
    transport.responses.set(M.GET_INFO, {
      type: "webextension",
      name: "chrome",
      metadata: {
        profileIdHash: "profile-hash",
        profileIsLastUsed: true,
        profileOrdering: 1,
        profileRuntimeBinding: "webextension",
        diagnostics: {
          profilePathRedacted: "/Users/<redacted>/Library/Application Support/Chrome/Profile 1",
        },
        backend: {
          extension_id: "ext-id",
          browser_kind: "chrome",
        },
      },
      capabilities: {},
    });
    const browser = new Browser(
      asTransport(transport),
      {
        type: "webextension",
        name: "chrome",
        metadata: {
          profileIdHash: "profile-hash",
          profileRuntimeBinding: "webextension",
          diagnostics: {
            profilePathRedacted: "/Users/<redacted>/Library/Application Support/Chrome/Profile 1",
          },
          backend: { extension_id: "ext-id", browser_kind: "chrome" },
        },
        capabilities: {},
      },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    expect(browser.metadata.profileIdHash).toBe("profile-hash");
    expect(browser.profileMetadata).toEqual({
      profileIdHash: "profile-hash",
      profileRuntimeBinding: "webextension",
      diagnostics: {
        profilePathRedacted: "/Users/<redacted>/Library/Application Support/Chrome/Profile 1",
      },
    });
    expect(browser.metadata.profilePath).toBeUndefined();
    expect(browser.metadata.profileDisplayName).toBeUndefined();
    await expect(browser.ensureReady({ timeout: 501 })).resolves.toMatchObject({
      profileMetadata: {
        profileIdHash: "profile-hash",
        profileIsLastUsed: true,
        profileOrdering: 1,
        profileRuntimeBinding: "webextension",
      },
    });
  });

  it("Browser exposes viewport and visibility objects only when capabilities advertise them", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const withoutCapabilities = new Browser(
      asTransport(transport),
      {
        type: "webextension",
        name: "chrome",
        capabilities: {
          supported_methods: [
            M.BROWSER_VIEWPORT_SET,
            M.BROWSER_VIEWPORT_RESET,
            M.BROWSER_VISIBILITY_SET,
            M.BROWSER_VISIBILITY_GET,
          ],
          unsupported_methods: [],
        },
      },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );
    expect(withoutCapabilities.viewport).toBeUndefined();
    expect(withoutCapabilities.visibility).toBeUndefined();

    const browser = new Browser(
      asTransport(transport),
      {
        type: "webextension",
        name: "chrome",
        capabilities: {
          viewport: { set: true, reset: true },
          visibility: { set: true, get: true },
          experimentalFoo: { version: 1 },
          disabledFoo: false,
          supported_methods: [
            M.BROWSER_VIEWPORT_SET,
            M.BROWSER_VIEWPORT_RESET,
            M.BROWSER_VISIBILITY_SET,
            M.BROWSER_VISIBILITY_GET,
          ],
          unsupported_methods: [],
        },
      },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      expect(browser.viewport).toBeDefined();
      expect(browser.visibility).toBeDefined();
      expect(browser.capabilityRegistry.has("viewport")).toBe(true);
      expect(browser.capabilityRegistry.has("visibility")).toBe(true);
      expect(browser.capabilityRegistry.has("experimentalFoo")).toBe(true);
      expect(browser.capabilityRegistry.has("disabledFoo")).toBe(false);
      expect(browser.capabilityRegistry.get("viewport")).toBe(browser.viewport);
      expect(browser.capabilityRegistry.get("visibility")).toBe(browser.visibility);
      expect(browser.capabilityRegistry.get("experimentalFoo")).toEqual({
        name: "experimentalFoo",
        raw: { version: 1 },
        supported: true,
      });
      expect(browser.capabilityRegistry.list()).toEqual([
        { name: "disabledFoo", raw: false, supported: false },
        { name: "experimentalFoo", raw: { version: 1 }, supported: true },
        { name: "viewport", raw: { set: true, reset: true }, supported: true, instance: browser.viewport },
        { name: "visibility", raw: { set: true, get: true }, supported: true, instance: browser.visibility },
      ]);
      expect(() => browser.capabilityRegistry.get("missing")).toThrow("unsupported browser capability: missing");
      await expect(browser.viewport!.set({
        width: 640,
        height: 480,
        deviceScaleFactor: 2,
        mobile: false,
        timeout: 333,
      })).resolves.toEqual({
        width: 640,
        height: 480,
        deviceScaleFactor: 2,
        mobile: false,
        tabId: 1,
      });
      await expect(browser.viewport!.reset({ timeout: 334 })).resolves.toEqual({ reset: true, tabId: 1 });
      await expect(browser.visibility!.set({ visible: true, focused: true, timeout: 335 })).resolves.toEqual({
        visible: true,
        focused: true,
        windowId: 1,
        state: "normal",
      });
      await expect(browser.visibility!.get({ timeout: 336 })).resolves.toEqual({
        visible: true,
        focused: true,
        windowId: 1,
        state: "normal",
      });
      await expect(browser.viewport!.set({ width: 0, height: 480 })).rejects.toThrow("width must be an integer");
      await expect(browser.visibility!.set({ visible: "yes" as unknown as boolean })).rejects.toThrow(
        "visible must be a boolean",
      );
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.BROWSER_VIEWPORT_SET,
        params: { width: 640, height: 480, deviceScaleFactor: 2, mobile: false, ...meta },
        timeout: 333,
      },
      { method: M.BROWSER_VIEWPORT_RESET, params: { ...meta }, timeout: 334 },
      {
        method: M.BROWSER_VISIBILITY_SET,
        params: { visible: true, focused: true, ...meta },
        timeout: 335,
      },
      { method: M.BROWSER_VISIBILITY_GET, params: { ...meta }, timeout: 336 },
    ]);
    expect(METHOD_CLASSIFICATION[M.BROWSER_VIEWPORT_SET]).toBe("internal-lifecycle");
    expect(METHOD_CLASSIFICATION[M.BROWSER_VISIBILITY_GET]).toBe("internal-lifecycle");
    expect(METHOD_CLASSIFICATION[M.TAB_EVALUATE]).toBe("current-origin");
    expect(METHOD_CLASSIFICATION[M.TAB_SNAPSHOT_TEXT]).toBe("current-origin");
  });

  it("Browser deliverables refreshes lifecycle diagnostics and claims durable tabs", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.GET_INFO, {
      type: "webextension",
      name: "chrome",
      metadata: {
        diagnostics: {
          lifecycle: {
            deliverable_tab_summaries: [
              {
                tab_id: "deliverable-1",
                session_id: "old-session",
                url: "https://deliverable.test/",
                title: "Deliverable",
              },
            ],
          },
        },
      },
      capabilities: {},
    });
    transport.responses.set(M.CLAIM_USER_TAB, {
      tab_id: "deliverable-1",
      url: "https://deliverable.test/",
      title: "Deliverable",
    });
    const browser = new Browser(
      asTransport(transport),
      { type: "webextension", name: "chrome", metadata: {}, capabilities: {} },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      const deliverables = await browser.deliverables({ timeout: 250 });
      expect(deliverables).toHaveLength(1);
      expect(deliverables[0]).toMatchObject({
        tabId: "deliverable-1",
        tab_id: "deliverable-1",
        sessionId: "old-session",
        session_id: "old-session",
        url: "https://deliverable.test/",
        title: "Deliverable",
      });

      const claimed = await deliverables[0]!.claim();
      expect(claimed.id).toBe("deliverable-1");
      expect(claimed.metadata).toMatchObject({
        url: "https://deliverable.test/",
        title: "Deliverable",
      });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.GET_TABS, params: { ...meta }, timeout: 250 },
      { method: M.GET_INFO, params: {}, timeout: 250 },
      { method: M.CLAIM_USER_TAB, params: { tab_id: "deliverable-1", ...meta }, timeout: undefined },
    ]);
  });

  it("Locator and FrameLocator encode action, query, state, filtering, and nested selector shape", async () => {
    const restoreMeta = setRequestMeta();
    const guardedCommands: Record<string, unknown>[] = [];
    const transport = new FakeTransport();
    const tab = new Tab(
      asTransport(transport),
      new Guards({ beforeCommand: (command) => guardedCommands.push(command) }),
      "tab-1",
    );

    try {
      const button = tab
        .locator("#root")
        .getByRole("button", { name: "Save", exact: true })
        .filter({ hasText: /ready/, visible: true });
      await button.click({
        button: "left",
        modifiers: ["Control"],
        force: true,
        timeout: 120,
        waitForNavigation: { waitUntil: "domcontentloaded", timeout: 1500 },
      });
      await button.waitFor({ state: "hidden", timeout: 121 });
      await expect(button.isVisible()).resolves.toBe(true);
      await expect(button.count()).resolves.toBe(2);
      await expect(button.getAttribute("role")).resolves.toBe("button");
      await button.selectOption([{ value: "a" }, { label: "B" }]);
      await button.check({ timeout: 122 });
      const elementShot = await button.screenshot({ timeout: 123 });
      expect(elementShot).toBeInstanceOf(Image);
      expect(elementShot).toMatchObject({ data_base64: "cropped64", mime_type: "image/png" });
      expect(elementShot.toBase64()).toBe("cropped64");
      await tab.frameLocator("iframe").getByText("Inside").fill("text", { timeout: 124 });
    } finally {
      restoreMeta();
    }

    const selector = '#root >> internal:role=button[name="Save"s] >> internal:has-text=/ready/ >> visible=true';
    expect(guardedCommands[0]).toMatchObject({
      command: M.PLAYWRIGHT_LOCATOR_CLICK,
      tab_id: "tab-1",
      selector,
      timeout_ms: 120,
      button: "left",
      modifiers: ["Control"],
      force: true,
      wait_for_navigation: true,
      navigation_wait_until: "domcontentloaded",
      navigation_timeout_ms: 1500,
    });
    expect(guardedCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: M.PLAYWRIGHT_SCREENSHOT,
          tab_id: "tab-1",
          cropX: 1,
          cropY: 2,
          cropWidth: 3,
          cropHeight: 4,
        }),
      ]),
    );
    expect(transport.calls).toEqual([
      {
        method: M.PLAYWRIGHT_LOCATOR_CLICK,
        params: {
          command: M.PLAYWRIGHT_LOCATOR_CLICK,
          tab_id: "tab-1",
          selector,
          timeout_ms: 120,
          button: "left",
          modifiers: ["Control"],
          force: true,
          wait_for_navigation: true,
          navigation_wait_until: "domcontentloaded",
          navigation_timeout_ms: 1500,
          ...meta,
        },
        timeout: 1620,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_WAIT_FOR,
        params: {
          command: M.PLAYWRIGHT_LOCATOR_WAIT_FOR,
          tab_id: "tab-1",
          selector,
          timeout_ms: 121,
          state: "hidden",
          ...meta,
        },
        timeout: 121,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_IS_VISIBLE,
        params: { command: M.PLAYWRIGHT_LOCATOR_IS_VISIBLE, tab_id: "tab-1", selector, timeout_ms: 30_000, ...meta },
        timeout: 30_000,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_COUNT,
        params: { command: M.PLAYWRIGHT_LOCATOR_COUNT, tab_id: "tab-1", selector, timeout_ms: 30_000, ...meta },
        timeout: 30_000,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE,
        params: { command: M.PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE, tab_id: "tab-1", selector, timeout_ms: 30_000, name: "role", ...meta },
        timeout: 30_000,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_SELECT_OPTION,
        params: {
          command: M.PLAYWRIGHT_LOCATOR_SELECT_OPTION,
          tab_id: "tab-1",
          selector,
          timeout_ms: 30_000,
          selections: [{ value: "a" }, { label: "B" }],
          ...meta,
        },
        timeout: 30_000,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_SET_CHECKED,
        params: {
          command: M.PLAYWRIGHT_LOCATOR_SET_CHECKED,
          tab_id: "tab-1",
          selector,
          timeout_ms: 122,
          checked: true,
          ...meta,
        },
        timeout: 122,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_BOUNDING_BOX,
        params: { command: M.PLAYWRIGHT_LOCATOR_BOUNDING_BOX, tab_id: "tab-1", selector, timeout_ms: 30_000, ...meta },
        timeout: 30_000,
      },
      {
        method: M.PLAYWRIGHT_SCREENSHOT,
        params: { tab_id: "tab-1", cropX: 1, cropY: 2, cropWidth: 3, cropHeight: 4, ...meta },
        timeout: 123,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_FILL,
        params: {
          command: M.PLAYWRIGHT_LOCATOR_FILL,
          tab_id: "tab-1",
          selector: 'iframe >> internal:control=enter-frame >> internal:text="Inside"i',
          timeout_ms: 124,
          value: "text",
          replace: true,
          ...meta,
        },
        timeout: 124,
      },
    ]);
  });

  it("coordinate CUA navigation waits compose action and navigation request timeouts", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "tab-1");

    try {
      await tab.cua.click(10, 20, {
        button: "left",
        timeout: 200,
        waitForNavigation: { waitUntil: "load", timeout: 800 },
      });
      await tab.cua.dblclick(30, 40, {
        timeout: 300,
        waitForNavigation: true,
      });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.CUA_CLICK,
        params: {
          tab_id: "tab-1",
          x: 10,
          y: 20,
          button: "left",
          modifiers: undefined,
          wait_for_navigation: true,
          navigation_wait_until: "load",
          navigation_timeout_ms: 800,
          ...meta,
        },
        timeout: 1000,
      },
      {
        method: M.CUA_DBLCLICK,
        params: {
          tab_id: "tab-1",
          x: 30,
          y: 40,
          button: undefined,
          modifiers: undefined,
          wait_for_navigation: true,
          navigation_timeout_ms: 300,
          ...meta,
        },
        timeout: 600,
      },
    ]);
  });

  it("Locator.all batches first leaf reads through one read_all request and reuses the cache", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "tab-a");

    try {
      const items = await tab.locator(".item").all({ timeout: 555 });
      expect(items).toHaveLength(2);
      expect(await items[1]!.textContent()).toBe(" Cancel ");
      expect(await items[0]!.innerText()).toBe("Save");
      expect(await items[0]!.getAttribute("data-kind")).toBe("primary");
      expect(await items[0]!.getAttribute("role")).toBe("button");
      expect(await items[1]!.getAttribute("missing")).toBeNull();
      expect(() => items[0]!.and(tab.locator(".enabled"))).not.toThrow();
      expect(() => items[0]!.and(new Tab(asTransport(transport), new Guards(), "other-tab").locator(".enabled"))).toThrow(
        "Locators must belong to the same tab",
      );
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.PLAYWRIGHT_LOCATOR_COUNT,
        params: { command: M.PLAYWRIGHT_LOCATOR_COUNT, tab_id: "tab-a", selector: ".item", timeout_ms: 30_000, ...meta },
        timeout: 30_000,
      },
      {
        method: M.PLAYWRIGHT_LOCATOR_READ_ALL,
        params: { command: M.PLAYWRIGHT_LOCATOR_READ_ALL, tab_id: "tab-a", selector: ".item", timeout_ms: 555, ...meta },
        timeout: 555,
      },
    ]);
  });

  it("TabDev, TabContent, Download, and FileChooser preserve wire payload shape", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "tab-1");
    const download = new Download(asTransport(transport), "download-1");
    const chooser = new FileChooser(asTransport(transport), "chooser-1");

    try {
      await expect(tab.dev.cdp("Runtime.evaluate", { expression: "1 + 1" }, { timeout: 129 })).resolves.toBeNull();
      await expect(tab.content.export({ format: "html", timeout: 130 })).resolves.toEqual({
        data: "html64",
        data_base64: "html64",
        mime_type: "text/html",
      });
      await expect(download.path({ timeout: 131 })).resolves.toBe("/tmp/download.txt");
      await chooser.setFiles("/tmp/upload.txt", { timeout: 132 });
      await chooser.setFiles(["/tmp/a.txt", "/tmp/b.txt"], { timeout: 133 });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.EXECUTE_CDP,
        params: {
          tab_id: "tab-1",
          target: { tabId: "tab-1" },
          method: "Runtime.evaluate",
          commandParams: { expression: "1 + 1" },
          ...meta,
        },
        timeout: 129,
      },
      {
        method: M.TAB_CONTENT_EXPORT,
        params: { tab_id: "tab-1", format: "html", ...meta },
        timeout: 130,
      },
      {
        method: M.PLAYWRIGHT_DOWNLOAD_PATH,
        params: { download_id: "download-1", ...meta },
        timeout: 131,
      },
      {
        method: M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
        params: { file_chooser_id: "chooser-1", paths: ["/tmp/upload.txt"], ...meta },
        timeout: 132,
      },
      {
        method: M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
        params: { file_chooser_id: "chooser-1", paths: ["/tmp/a.txt", "/tmp/b.txt"], ...meta },
        timeout: 133,
      },
    ]);
  });

  it("Tab model-safe helpers cap evaluate, emit screenshots, and snapshot text", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const emitted: string[] = [];
    (globalThis as { nodeRepl?: { emitImage: (image: string) => Promise<void> } }).nodeRepl = {
      emitImage: async (image) => {
        emitted.push(image);
      },
    };
    const tab = new Tab(asTransport(transport), new Guards(), "tab-1");

    try {
      await expect(tab.evaluate("document.title", { timeout: 140, maxJsonBytes: 2000 })).resolves.toEqual({
        title: "Example",
      });
      await expect(tab.screenshotForModel({ artifactMode: "resource", timeout: 141 })).resolves.toMatchObject({
        kind: "resource",
        mime_type: "image/png",
      });
      await expect(tab.snapshotText({ timeout: 142, maxItems: 3, maxTextLength: 40 })).resolves.toEqual({
        title: "Example",
      });
    } finally {
      restoreMeta();
    }

    expect(emitted).toEqual(["data:image/png;base64,base64png"]);
    expect(transport.calls).toEqual([
      {
        method: M.TAB_EVALUATE,
        params: {
          tab_id: "tab-1",
          expression: expect.stringContaining("max_json_bytes"),
          awaitPromise: true,
          returnByValue: true,
          ...meta,
        },
        timeout: 140,
      },
      { method: M.TAB_SCREENSHOT, params: { tab_id: "tab-1", type: "jpeg", quality: 60, fullPage: false, ...meta }, timeout: 141 },
      {
        method: M.TAB_SNAPSHOT_TEXT,
        params: {
          tab_id: "tab-1",
          expression: expect.stringMatching(/obu-agent-overlay-root[\s\S]*document\.querySelectorAll[\s\S]*max_json_bytes/),
          awaitPromise: true,
          returnByValue: true,
          maxJsonBytes: 32 * 1024,
          ...meta,
        },
        timeout: 142,
      },
    ]);
  });

  it("snapshotText fails clearly when page summary exceeds the evaluate budget", async () => {
    const transport = new FakeTransport();
    transport.responses.set(M.TAB_SNAPSHOT_TEXT, {
      result: {
        value: {
          __obu_evaluate_summary: {
            kind: "truncated",
            type: "object",
            bytes: 50_000,
            reason: "max_json_bytes",
          },
        },
      },
    });
    const tab = new Tab(asTransport(transport), new Guards(), "tab-1");

    await expect(tab.snapshotText({ maxJsonBytes: 1 })).rejects.toThrow(
      "tab.snapshotText result exceeded maxJsonBytes",
    );
  });

  it("Browser finishTurn and ensureReady compose lifecycle and readiness calls", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.requestLifecycle = [{
      kind: "timed_out_pending_reconcile",
      requestId: 9,
      method: M.TAB_GOTO,
      timeoutMs: 100,
      defensiveOvershootMs: 5000,
      timedOutAt: 123,
      nextAction: "observe_reconcile",
    }];
    transport.responses.set(M.GET_INFO, {
      type: "webextension",
      name: "chrome",
      metadata: { diagnostics: { lifecycle: { stale_tabs: 0 } } },
      capabilities: {
        supported_methods: [M.GET_INFO, M.TAB_SCREENSHOT],
        unsupported_methods: [],
      },
    });
    const browser = new Browser(
      asTransport(transport),
      { type: "webextension", name: "chrome", metadata: {}, capabilities: {} },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      await expect(browser.finishTurn({
        keep: [{ tabId: "tab-keep", status: "deliverable" }],
        timeout: 210,
        turnTimeout: 211,
      })).resolves.toMatchObject({
        status: "ok",
        turnEnded: true,
      });
      await expect(browser.ensureReady({ timeout: 212 })).resolves.toMatchObject({
        type: "webextension",
        name: "chrome",
        supportedMethods: [M.GET_INFO, M.TAB_SCREENSHOT],
        diagnostics: {
          lifecycle: { stale_tabs: 0 },
          sdk_requests: [{
            kind: "timed_out_pending_reconcile",
            requestId: 9,
            method: M.TAB_GOTO,
            nextAction: "observe_reconcile",
          }],
        },
      });
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      {
        method: M.FINALIZE_TABS,
        params: { keep: [{ tab_id: "tab-keep", status: "deliverable" }], ...meta },
        timeout: 210,
      },
      { method: M.TURN_ENDED, params: { ...meta }, timeout: 211 },
      { method: M.GET_INFO, params: {}, timeout: 212 },
    ]);
  });

  it("Browser.finishTurn keeps the turn open after partial or fatal finalization unless explicitly opted in", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const browser = new Browser(
      asTransport(transport),
      { type: "webextension", name: "chrome", metadata: {}, capabilities: {} },
      { type: "webextension", name: "chrome", socketPath: "/tmp/webext", metadata: {} },
      new Guards(),
    );

    try {
      transport.responses.set(M.FINALIZE_TABS, {
        status: "partial",
        actions: [],
        closedTabIds: [],
        releasedTabIds: [],
        keptTabs: [],
        deliverableTabs: [],
        finalTabs: { handoff: [], deliverable: [], activeTabId: null },
        failures: [
          {
            tabId: "tab-1",
            desiredStatus: "close",
            outcome: "failed",
            errorCode: "close_failed",
            errorMessage: "close failed",
          },
        ],
        diagnostics: { reconciledFromChrome: true, reconciliationSource: "chrome.tabs" },
      });
      await expect(browser.finishTurn({ timeout: 210, turnTimeout: 211 })).resolves.toMatchObject({
        status: "partial",
        turnEnded: false,
      });
      expect(transport.calls).toEqual([
        { method: M.FINALIZE_TABS, params: { keep: [], ...meta }, timeout: 210 },
      ]);

      transport.calls = [];
      await expect(
        browser.finishTurn({ timeout: 210, turnTimeout: 211, endTurnOnPartial: true }),
      ).resolves.toMatchObject({
        status: "partial",
        turnEnded: true,
      });
      expect(transport.calls).toEqual([
        { method: M.FINALIZE_TABS, params: { keep: [], ...meta }, timeout: 210 },
        { method: M.TURN_ENDED, params: { ...meta }, timeout: 211 },
      ]);

      transport.calls = [];
      transport.responses.set(M.FINALIZE_TABS, {
        status: "fatal",
        actions: [],
        closedTabIds: [],
        releasedTabIds: [],
        keptTabs: [],
        deliverableTabs: [],
        finalTabs: null,
        failures: [
          {
            outcome: "failed",
            errorCode: "reconcile_failed",
            errorMessage: "reconcile failed",
          },
        ],
        errorCode: "reconcile_failed",
        errorMessage: "reconcile failed",
        diagnostics: { reconciledFromChrome: false },
      });
      await expect(
        browser.finishTurn({ timeout: 210, turnTimeout: 211, endTurnOnPartial: true }),
      ).resolves.toMatchObject({
        status: "fatal",
        turnEnded: false,
      });
      expect(transport.calls).toEqual([
        { method: M.FINALIZE_TABS, params: { keep: [], ...meta }, timeout: 210 },
      ]);
    } finally {
      restoreMeta();
    }
  });

  it("display forwards arbitrary values or fails clearly when runtime global is missing", () => {
    const value = { kind: "json", nested: ["image-shaped", { mime: "image/png" }] };
    const image = new Image("iVBORw0KGgo=", "image/png");
    const seen: unknown[] = [];
    (globalThis as { display?: (value: unknown) => unknown }).display = (next) => {
      seen.push(next);
      return "display-result";
    };

    expect(display(value)).toBe("display-result");
    expect(display(image)).toBe("display-result");
    expect(image.toBase64()).toBe("iVBORw0KGgo=");
    expect(JSON.stringify(image)).toBe(JSON.stringify({ data_base64: "iVBORw0KGgo=", mime_type: "image/png" }));
    expect(seen).toEqual([
      value,
      { __obuImage: true, mime_type: "image/png", data: "iVBORw0KGgo=" },
    ]);

    delete (globalThis as { display?: unknown }).display;
    expect(() => display("missing")).toThrow("global display() is not available");
  });

  it("Guards bypass always-allowed methods and propagate hook rejections as ObuError", async () => {
    const seen: Record<string, unknown>[] = [];
    const guards = new Guards({
      beforeCommand: (command) => {
        seen.push(command);
        if (command.command === "boom") throw new Error("blocked");
        if (command.command === "native") throw new ObuError(-123, "native block");
      },
    });

    await expect(guards.ensureCommandAllowed({ command: M.GET_TABS })).resolves.toBeUndefined();
    await expect(guards.ensureCommandAllowed({ command: M.PLAYWRIGHT_LOCATOR_CLICK })).resolves.toBeUndefined();
    await expect(guards.ensureCommandAllowed({ command: "boom" })).rejects.toMatchObject({
      code: ERR_DISALLOWED,
      message: expect.stringContaining("blocked"),
    });
    await expect(guards.ensureCommandAllowed({ command: "native" })).rejects.toMatchObject({
      code: -123,
      message: "native block",
    });
    expect(seen).toEqual([{ command: M.PLAYWRIGHT_LOCATOR_CLICK }, { command: "boom" }, { command: "native" }]);
  });

  it("classifies every inbound wire method for structured guards", () => {
    expect(Object.keys(METHOD_CLASSIFICATION).sort()).toEqual([...M.ALL_INBOUND_METHODS].sort());
  });

  it("default guards do not call a remote policy service", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: unknown[] = [];
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls.push(args);
      throw new Error("remote policy call is not allowed by default");
    }) as typeof fetch;
    try {
      const guards = new Guards();
      await guards.ensureCommandAllowed({ command: M.TAB_GOTO, url: "https://example.test/" });
      await guards.ensureCommandAllowed(
        { command: M.PLAYWRIGHT_LOCATOR_CLICK, tab_id: "tab-1" },
        { currentUrl: "https://example.test/" },
      );
      await guards.ensureCommandAllowed({ command: M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD, tab_id: "tab-1" });
      await guards.ensureCommandAllowed({ command: M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES, tab_id: "tab-1", paths: ["/tmp/a.txt"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toEqual([]);
  });

  it("structured guards block navigation before transport state changes", async () => {
    const transport = new FakeTransport();
    const tabs = new BrowserTabs(
      asTransport(transport),
      new Guards({
        checkNavigation: (url) => {
          if (url.includes("blocked.test")) throw new Error("navigation blocked");
        },
      }),
    );

    await expect(tabs.create("https://blocked.test/")).rejects.toMatchObject({
      code: ERR_DISALLOWED,
      message: expect.stringContaining("navigation blocked"),
    });
    expect(transport.calls).toEqual([]);
  });

  it("current-origin guards receive the resolved tab URL before locator actions", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const seen: unknown[] = [];
    const tab = new Tab(
      asTransport(transport),
      new Guards({
        checkCurrentOrigin: (tabId, url, command, context) => seen.push({ tabId, url, command, context }),
      }),
      "tab-1",
    );

    try {
      await tab.locator("#a").click({ timeout: 42 });
    } finally {
      restoreMeta();
    }

    expect(seen).toMatchObject([
      {
        tabId: "tab-1",
        url: "https://example.test/",
        command: M.PLAYWRIGHT_LOCATOR_CLICK,
        context: { classification: "current-origin" },
      },
    ]);
    expect(transport.calls[0]).toEqual({
      method: M.TAB_URL,
      params: { tab_id: "tab-1", ...meta },
      timeout: 42,
    });
    expect(transport.calls[1].method).toBe(M.PLAYWRIGHT_LOCATOR_CLICK);
  });

  it("tab-level guards cover target URL and current-origin commands", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const events: unknown[] = [];
    const tab = new Tab(
      asTransport(transport),
      new Guards({
        checkNavigation: (url, context) => events.push({ kind: "navigation", url, command: context.command }),
        checkCurrentOrigin: (tabId, url, command) => events.push({ kind: "current-origin", tabId, url, command }),
      }),
      "tab-1",
    );

    try {
      await tab.waitForURL("https://target.test/", { timeout: 42 });
      await tab.reload({ timeout: 42 });
      await tab.screenshot({ timeout: 42 });
      await tab.close({ timeout: 42 });
    } finally {
      restoreMeta();
    }

    expect(events).toEqual([
      { kind: "navigation", url: "https://target.test/", command: M.TAB_WAIT_FOR_URL },
      { kind: "current-origin", tabId: "tab-1", url: "https://example.test/", command: M.TAB_RELOAD },
      { kind: "current-origin", tabId: "tab-1", url: "https://example.test/", command: M.TAB_SCREENSHOT },
      { kind: "current-origin", tabId: "tab-1", url: "https://example.test/", command: M.TAB_CLOSE },
    ]);
    expect(transport.calls).toEqual([
      {
        method: M.TAB_WAIT_FOR_URL,
        params: { tab_id: "tab-1", url: "https://target.test/", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_RELOAD,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_SCREENSHOT,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_CLOSE,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
    ]);
  });

  it("tab url and title helpers apply current-origin guards", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const events: unknown[] = [];
    const tab = new Tab(
      asTransport(transport),
      new Guards({
        checkCurrentOrigin: (tabId, url, command) => events.push({ tabId, url, command }),
      }),
      "tab-1",
    );

    try {
      await expect(tab.url({ timeout: 42 })).resolves.toBe("https://example.test/");
      await expect(tab.title({ timeout: 43 })).resolves.toBe("Example");
    } finally {
      restoreMeta();
    }

    expect(events).toEqual([
      { tabId: "tab-1", url: "https://example.test/", command: M.TAB_URL },
      { tabId: "tab-1", url: "https://example.test/", command: M.TAB_TITLE },
    ]);
    expect(transport.calls).toEqual([
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 43,
      },
      {
        method: M.TAB_TITLE,
        params: { tab_id: "tab-1", ...meta },
        timeout: 43,
      },
    ]);
  });

  it("content and clipboard helpers resolve current-origin guard context before transport", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.TAB_CLIPBOARD_READ_TEXT, { text: "copied" });
    transport.responses.set(M.TAB_CLIPBOARD_READ, { items: [] });
    transport.responses.set(M.DOM_CUA_GET_VISIBLE_DOM, { nodes: [], text: "[1] <button> Save" });
    const events: unknown[] = [];
    const tab = new Tab(
      asTransport(transport),
      new Guards({
        checkCurrentOrigin: (tabId, url, command) => events.push({ tabId, url, command }),
      }),
      "tab-1",
    );

    try {
      await expect(tab.content.export({ format: "html", timeout: 42 })).resolves.toMatchObject({
        data_base64: "html64",
        mime_type: "text/html",
      });
      await expect(tab.clipboard.readText({ timeout: 43 })).resolves.toBe("copied");
      await tab.clipboard.writeText("next", { timeout: 44 });
      await expect(tab.clipboard.read({ timeout: 45 })).resolves.toEqual([]);
      await tab.clipboard.write([{ entries: [{ mimeType: "text/plain", text: "plain" }] }], { timeout: 46 });
      await expect(tab.dom_cua.get_visible_dom({ timeout: 47 })).resolves.toMatchObject({ nodes: [] });
      await expect(tab.dom_cua.get_visible_dom({ timeout: 48, format: "text" })).resolves.toBe("[1] <button> Save");
      await expect(tab.dom_cua.text({ timeout: 49 })).resolves.toBe("[1] <button> Save");
      await expect(tab.dom_cua.get_visible_dom({ timeout: 50, format: "debug_text" })).resolves.toBe("[1] <button> Save");
      await expect(tab.dom_cua.get_visible_dom({ timeout: 51, format: "compact_text" })).resolves.toBe("[1] <button> Save");
    } finally {
      restoreMeta();
    }

    expect(events).toEqual([
      { tabId: "tab-1", url: "https://example.test/", command: M.TAB_CONTENT_EXPORT },
      { tabId: "tab-1", url: "https://example.test/", command: M.TAB_CLIPBOARD_READ_TEXT },
      { tabId: "tab-1", url: "https://example.test/", command: M.TAB_CLIPBOARD_WRITE_TEXT },
      { tabId: "tab-1", url: "https://example.test/", command: M.TAB_CLIPBOARD_READ },
      { tabId: "tab-1", url: "https://example.test/", command: M.TAB_CLIPBOARD_WRITE },
      { tabId: "tab-1", url: "https://example.test/", command: M.DOM_CUA_GET_VISIBLE_DOM },
      { tabId: "tab-1", url: "https://example.test/", command: M.DOM_CUA_GET_VISIBLE_DOM },
      { tabId: "tab-1", url: "https://example.test/", command: M.DOM_CUA_GET_VISIBLE_DOM },
      { tabId: "tab-1", url: "https://example.test/", command: M.DOM_CUA_GET_VISIBLE_DOM },
      { tabId: "tab-1", url: "https://example.test/", command: M.DOM_CUA_GET_VISIBLE_DOM },
    ]);
    expect(transport.calls).toEqual([
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_CONTENT_EXPORT,
        params: { tab_id: "tab-1", format: "html", ...meta },
        timeout: 42,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 43,
      },
      {
        method: M.TAB_CLIPBOARD_READ_TEXT,
        params: { tab_id: "tab-1", ...meta },
        timeout: 43,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 44,
      },
      {
        method: M.TAB_CLIPBOARD_WRITE_TEXT,
        params: { tab_id: "tab-1", text: "next", ...meta },
        timeout: 44,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 45,
      },
      {
        method: M.TAB_CLIPBOARD_READ,
        params: { tab_id: "tab-1", ...meta },
        timeout: 45,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 46,
      },
      {
        method: M.TAB_CLIPBOARD_WRITE,
        params: {
          tab_id: "tab-1",
          items: [{ entries: [{ mime_type: "text/plain", text: "plain" }] }],
          ...meta,
        },
        timeout: 46,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 47,
      },
      {
        method: M.DOM_CUA_GET_VISIBLE_DOM,
        params: { tab_id: "tab-1", ...meta },
        timeout: 47,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 48,
      },
      {
        method: M.DOM_CUA_GET_VISIBLE_DOM,
        params: { tab_id: "tab-1", format: "text", ...meta },
        timeout: 48,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 49,
      },
      {
        method: M.DOM_CUA_GET_VISIBLE_DOM,
        params: { tab_id: "tab-1", format: "text", ...meta },
        timeout: 49,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 50,
      },
      {
        method: M.DOM_CUA_GET_VISIBLE_DOM,
        params: { tab_id: "tab-1", format: "debug_text", ...meta },
        timeout: 50,
      },
      {
        method: M.TAB_URL,
        params: { tab_id: "tab-1", ...meta },
        timeout: 51,
      },
      {
        method: M.DOM_CUA_GET_VISIBLE_DOM,
        params: { tab_id: "tab-1", format: "compact_text", ...meta },
        timeout: 51,
      },
    ]);
  });

  it("file-transfer and raw-CDP hooks are semantic and command-specific", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER, { file_chooser_id: "chooser-1" });
    transport.responses.set(M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD, { download_id: "download-1" });
    const events: unknown[] = [];
    const guards = new Guards({
      checkNavigation: (url, context) => events.push({ kind: "navigation", url, command: context.command }),
      checkUpload: (tabId, paths, context) => events.push({ kind: "upload", tabId, paths, url: context.url }),
      checkDownload: (tabId, url, context) => events.push({ kind: "download", tabId, url, command: context.command }),
      checkCurrentOrigin: (tabId, url, command) => events.push({ kind: "current-origin", tabId, url, command }),
      checkRawCdp: (tabId, method) => {
        events.push({ kind: "raw-cdp", tabId, method });
        if (method === "Page.navigate") throw new Error("raw cdp blocked");
      },
    });
    const tab = new Tab(asTransport(transport), guards, "tab-1");

    try {
      const chooser = (await tab.waitForEvent("filechooser")) as FileChooser;
      await chooser.setFiles(["/tmp/a.txt"]);
      const download = (await tab.waitForEvent("download")) as Download;
      await expect(download.path()).resolves.toBe("/tmp/download.txt");
      await tab.locator("#download-link").download_media({ timeout: 45 });
      await tab.dom_cua.download_media("node-1");
      await expect(tab.evaluate("1 + 1")).resolves.toEqual({ title: "Example" });
      await expect(tab.dev.cdp("Page.navigate", { url: "https://blocked.test/" })).rejects.toMatchObject({
        code: ERR_DISALLOWED,
        message: expect.stringContaining("raw cdp blocked"),
      });
    } finally {
      restoreMeta();
    }

    expect(events).toEqual([
      { kind: "current-origin", tabId: "tab-1", url: "https://example.test/", command: M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER },
      { kind: "upload", tabId: "tab-1", paths: ["/tmp/a.txt"], url: "https://example.test/" },
      { kind: "download", tabId: "tab-1", url: "https://example.test/", command: M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD },
      { kind: "download", tabId: "tab-1", url: "https://example.test/", command: M.PLAYWRIGHT_DOWNLOAD_PATH },
      { kind: "download", tabId: "tab-1", url: "https://example.test/", command: M.PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA },
      { kind: "download", tabId: "tab-1", url: "https://example.test/", command: M.DOM_CUA_DOWNLOAD_MEDIA },
      { kind: "current-origin", tabId: "tab-1", url: "https://example.test/", command: M.TAB_EVALUATE },
      { kind: "current-origin", tabId: "tab-1", url: "https://example.test/", command: M.EXECUTE_CDP },
      { kind: "navigation", url: "https://blocked.test/", command: M.EXECUTE_CDP },
      { kind: "raw-cdp", tabId: "tab-1", method: "Page.navigate" },
    ]);
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER,
      M.TAB_URL,
      M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
      M.TAB_URL,
      M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
      M.TAB_URL,
      M.PLAYWRIGHT_DOWNLOAD_PATH,
      M.TAB_URL,
      M.PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA,
      M.TAB_URL,
      M.DOM_CUA_DOWNLOAD_MEDIA,
      M.TAB_URL,
      M.TAB_EVALUATE,
      M.TAB_URL,
    ]);
    expect(transport.calls[3]).toEqual({
      method: M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
      params: { tab_id: "tab-1", file_chooser_id: "chooser-1", paths: ["/tmp/a.txt"], ...meta },
      timeout: undefined,
    });
    expect(transport.calls[7]).toEqual({
      method: M.PLAYWRIGHT_DOWNLOAD_PATH,
      params: { tab_id: "tab-1", download_id: "download-1", ...meta },
      timeout: undefined,
    });
  });

  it("Locator composition rejects incompatible nested locators before sending commands", async () => {
    const transport = new FakeTransport();
    const first = new Locator(asTransport(transport), new Guards(), "tab-1", "#a");
    const second = new Locator(asTransport(transport), new Guards(), "tab-2", "#b");

    expect(() => first.and(second)).toThrow("Locators must belong to the same tab");
    expect(() => first.filter({ has: second })).toThrow("Locators must belong to the same tab");
    expect(transport.calls).toEqual([]);
  });
});
