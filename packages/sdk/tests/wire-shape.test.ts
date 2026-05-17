import { afterEach, describe, expect, it } from "vitest";
import { Browser } from "../src/browser.js";
import { BrowserTabs } from "../src/browser_tabs.js";
import { display } from "../src/display.js";
import { Download } from "../src/download.js";
import { FileChooser } from "../src/file-chooser.js";
import { Guards, METHOD_CLASSIFICATION } from "../src/guards.js";
import { Locator } from "../src/locator.js";
import { Tab } from "../src/tab.js";
import { ObuError, ERR_DISALLOWED } from "../src/errors.js";
import * as M from "../src/wire/methods.js";
import type { Transport } from "../src/wire/transport.js";

const meta = { session_id: "session", turn_id: "turn" };

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];
  responses = new Map<string, unknown>();

  constructor() {
    this.responses.set(M.GET_TABS, [
      {
        tab_id: "tab-a",
        target_id: "target-a",
        url: "https://a.test/",
        title: "A",
        origin: "agent",
        status: "deliverable",
      },
      { id: "tab-b" },
    ]);
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
    this.responses.set(M.PLAYWRIGHT_LOCATOR_IS_VISIBLE, true);
    this.responses.set(M.PLAYWRIGHT_LOCATOR_COUNT, 2);
    this.responses.set(M.PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE, "button");
    this.responses.set(M.PLAYWRIGHT_LOCATOR_BOUNDING_BOX, { x: 1, y: 2, width: 3, height: 4 });
    this.responses.set(M.PLAYWRIGHT_SCREENSHOT, { data: "cropped64" });
    this.responses.set(M.PLAYWRIGHT_DOWNLOAD_PATH, { path: "/tmp/download.txt" });
  }

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    return (this.responses.has(method) ? this.responses.get(method) : null) as T;
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
      await expect(tab.screenshot({ timeout: 106 })).resolves.toEqual({ data_base64: "base64png", mime_type: "image/png" });
      await expect(tab.screenshot({
        type: "jpeg",
        quality: 60,
        fullPage: false,
        clip: { x: 1, y: 2, width: 300, height: 200, scale: 0.5 },
        timeout: 106,
      })).resolves.toEqual({ data_base64: "base64png", mime_type: "image/png" });
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
      const created = await tabs.create({ url: "https://new.test/" });
      const direct = tabs.get("manual-tab");

      expect(listed.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
      expect(listed[0].metadata).toMatchObject({
        target_id: "target-a",
        url: "https://a.test/",
        title: "A",
        origin: "agent",
        status: "deliverable",
      });
      expect(created.id).toBe("created-tab");
      expect(created.metadata).toMatchObject({
        url: "https://new.test/",
        title: "New",
        origin: "agent",
        status: "active",
      });
      expect(direct.id).toBe("manual-tab");
      expect(direct.metadata).toEqual({});
    } finally {
      restoreMeta();
    }

    expect(transport.calls).toEqual([
      { method: M.GET_TABS, params: { ...meta }, timeout: undefined },
      { method: M.CREATE_TAB, params: { url: "https://new.test/", ...meta }, timeout: undefined },
    ]);
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

  it("Browser delegates lifecycle naming, turn end, and finalization calls", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.CLEAR_LIFECYCLE_DIAGNOSTICS, {
      cleared: { stale_sessions: 1, stale_tabs: 2, stale_file_choosers: 0, stale_downloads: 0 },
      diagnostics: { lifecycle: { stale_sessions: 0, stale_tabs: 0 } },
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
      { method: M.GET_TABS, params: { ...meta }, timeout: undefined },
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
      await expect(button.screenshot({ timeout: 123 })).resolves.toEqual({ data_base64: "cropped64", mime_type: "image/png" });
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
        timeout: 1500,
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

  it("TabDev, TabContent, Download, and FileChooser preserve wire payload shape", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "tab-1");
    const download = new Download(asTransport(transport), "download-1");
    const chooser = new FileChooser(asTransport(transport), "chooser-1");

    try {
      await expect(tab.dev.cdp("Runtime.evaluate", { expression: "1 + 1" })).resolves.toBeNull();
      await expect(tab.content.export({ format: "html", timeout: 130 })).resolves.toEqual({
        data: "html64",
        data_base64: "html64",
        mime_type: "text/html",
      });
      await expect(download.path()).resolves.toBe("/tmp/download.txt");
      await chooser.setFiles("/tmp/upload.txt");
      await chooser.setFiles(["/tmp/a.txt", "/tmp/b.txt"]);
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
        timeout: undefined,
      },
      {
        method: M.TAB_CONTENT_EXPORT,
        params: { tab_id: "tab-1", format: "html", ...meta },
        timeout: 130,
      },
      {
        method: M.PLAYWRIGHT_DOWNLOAD_PATH,
        params: { download_id: "download-1", ...meta },
        timeout: undefined,
      },
      {
        method: M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
        params: { file_chooser_id: "chooser-1", paths: ["/tmp/upload.txt"], ...meta },
        timeout: undefined,
      },
      {
        method: M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
        params: { file_chooser_id: "chooser-1", paths: ["/tmp/a.txt", "/tmp/b.txt"], ...meta },
        timeout: undefined,
      },
    ]);
  });

  it("Tab model-safe helpers cap evaluate, emit screenshots, and snapshot text", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    transport.responses.set(M.EXECUTE_CDP, {
      result: { value: { __obu_evaluate_value: { title: "Example" } } },
    });
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
        method: M.EXECUTE_CDP,
        params: {
          tab_id: "tab-1",
          target: { tabId: "tab-1" },
          method: "Runtime.evaluate",
          commandParams: {
            expression: expect.stringContaining("max_json_bytes"),
            awaitPromise: true,
            returnByValue: true,
          },
          ...meta,
        },
        timeout: 140,
      },
      { method: M.TAB_SCREENSHOT, params: { tab_id: "tab-1", type: "jpeg", quality: 60, fullPage: false, ...meta }, timeout: 141 },
      {
        method: M.EXECUTE_CDP,
        params: {
          tab_id: "tab-1",
          target: { tabId: "tab-1" },
          method: "Runtime.evaluate",
          commandParams: {
            expression: expect.stringContaining("document.querySelectorAll"),
            awaitPromise: true,
            returnByValue: true,
          },
          ...meta,
        },
        timeout: 142,
      },
    ]);
  });

  it("snapshotText fails clearly when page summary exceeds the evaluate budget", async () => {
    const transport = new FakeTransport();
    transport.responses.set(M.EXECUTE_CDP, {
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
      await browser.finishTurn({
        keep: [{ tabId: "tab-keep", status: "deliverable" }],
        timeout: 210,
        turnTimeout: 211,
      });
      await expect(browser.ensureReady({ timeout: 212 })).resolves.toMatchObject({
        type: "webextension",
        name: "chrome",
        supportedMethods: [M.GET_INFO, M.TAB_SCREENSHOT],
        diagnostics: { lifecycle: { stale_tabs: 0 } },
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

  it("display forwards arbitrary values or fails clearly when runtime global is missing", () => {
    const value = { kind: "json", nested: ["image-shaped", { mime: "image/png" }] };
    const seen: unknown[] = [];
    (globalThis as { display?: (value: unknown) => unknown }).display = (next) => {
      seen.push(next);
      return "display-result";
    };

    expect(display(value)).toBe("display-result");
    expect(seen).toEqual([value]);

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
    transport.responses.set(M.DOM_CUA_GET_VISIBLE_DOM, { nodes: [] });
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
      await expect(tab.dom_cua.get_visible_dom({ timeout: 47 })).resolves.toEqual({ nodes: [] });
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
