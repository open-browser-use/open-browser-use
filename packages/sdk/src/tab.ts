import { Download } from "./download.js";
import { FileChooser } from "./file-chooser.js";
import { FrameLocator } from "./frame-locator.js";
import { Guards } from "./guards.js";
import { Locator } from "./locator.js";
import { TabClipboard } from "./tab-clipboard.js";
import { TabContent } from "./tab-content.js";
import { TabCua } from "./tab-cua.js";
import { TabDev } from "./tab-dev.js";
import { TabDomCua } from "./tab-dom-cua.js";
import { withSessionMeta } from "./session-meta.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_POLL_MS = 50;

export type TabNavigationWaitOptions = {
  url?: string | RegExp;
  waitUntil?: "domcontentloaded" | "load" | "networkidle";
  timeout?: number;
  pollInterval?: number;
};

export type TabMetadata = {
  target_id?: string;
  url?: string;
  title?: string;
  origin?: "agent" | "user";
  status?: "active" | "handoff" | "deliverable";
};

export class Tab {
  readonly clipboard: TabClipboard;
  readonly content: TabContent;
  readonly cua: TabCua;
  readonly dev: TabDev;
  readonly dom_cua: TabDomCua;
  readonly metadata: TabMetadata;

  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    public readonly id: string,
    metadata: TabMetadata = {},
  ) {
    this.clipboard = new TabClipboard(transport, guards, id);
    this.content = new TabContent(transport, guards, id);
    this.cua = new TabCua(transport, guards, id);
    this.dev = new TabDev(transport, guards, id);
    this.dom_cua = new TabDomCua(transport, guards, id);
    this.metadata = metadata;
  }

  locator(selector: string): Locator {
    return new Locator(this.transport, this.guards, this.id, selector);
  }

  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.transport, this.guards, this.id, selector);
  }

  getByRole(role: string, opts: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return this.locator("").getByRole(role, opts);
  }

  getByText(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.locator("").getByText(text, opts);
  }

  getByLabel(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.locator("").getByLabel(text, opts);
  }

  getByPlaceholder(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.locator("").getByPlaceholder(text, opts);
  }

  getByTestId(testId: string): Locator {
    return this.locator("").getByTestId(testId);
  }

  async goto(url: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.guards.ensureCommandAllowed({ command: M.TAB_GOTO, tab_id: this.id, url });
    await this.transport.sendRequest(M.TAB_GOTO, withSessionMeta({ tab_id: this.id, url }), opts.timeout);
  }

  async attach(opts: { timeout?: number } = {}): Promise<void> {
    await this.transport.sendRequest(M.ATTACH, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async detach(opts: { timeout?: number } = {}): Promise<void> {
    await this.transport.sendRequest(M.DETACH, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async reload(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_RELOAD, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_RELOAD, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async back(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_BACK, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_BACK, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async forward(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_FORWARD, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_FORWARD, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async waitForURL(url: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_WAIT_FOR_URL, { url }, opts.timeout);
    await this.transport.sendRequest(M.TAB_WAIT_FOR_URL, withSessionMeta({ tab_id: this.id, url }), opts.timeout);
  }

  async waitForUrl(url: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.waitForURL(url, opts);
  }

  async waitForLoadState(state = "load", opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_WAIT_FOR_LOAD_STATE, { state }, opts.timeout);
    await this.transport.sendRequest(M.TAB_WAIT_FOR_LOAD_STATE, withSessionMeta({ tab_id: this.id, state }), opts.timeout);
  }

  async waitForNavigation(opts?: TabNavigationWaitOptions): Promise<void>;
  async waitForNavigation<T>(action: () => T | Promise<T>, opts?: TabNavigationWaitOptions): Promise<T>;
  async waitForNavigation<T>(
    actionOrOpts?: (() => T | Promise<T>) | TabNavigationWaitOptions,
    opts: TabNavigationWaitOptions = {},
  ): Promise<T | void> {
    const action = typeof actionOrOpts === "function" ? actionOrOpts : undefined;
    const options: TabNavigationWaitOptions = action ? opts : ((actionOrOpts as TabNavigationWaitOptions | undefined) ?? {});
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    const startUrl = await this.url({ timeout: remainingMs(deadline) });
    let cancelled = false;
    const wait = this.#waitForNavigationFrom(startUrl, deadline, options, () => cancelled);

    if (!action) {
      await wait;
      return;
    }

    try {
      const result = await action();
      await wait;
      return result;
    } catch (error) {
      cancelled = true;
      wait.catch(() => {});
      throw error;
    }
  }

  async url(opts: { timeout?: number } = {}): Promise<string> {
    const currentUrl = await this.#currentUrlForGuard(opts.timeout);
    await this.guards.ensureCommandAllowed({ command: M.TAB_URL, tab_id: this.id }, { currentUrl });
    return currentUrl;
  }

  async title(opts: { timeout?: number } = {}): Promise<string> {
    await this.#ensureTabCommandAllowed(M.TAB_TITLE, {}, opts.timeout);
    return await this.transport.sendRequest<string>(M.TAB_TITLE, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async screenshot(opts: { timeout?: number } = {}): Promise<{ data_base64: string; mime_type: string }> {
    await this.#ensureTabCommandAllowed(M.TAB_SCREENSHOT, {}, opts.timeout);
    const row = await this.transport.sendRequest<{ data?: string; data_base64?: string; mime_type?: string }>(
      M.TAB_SCREENSHOT,
      withSessionMeta({ tab_id: this.id }),
      opts.timeout,
    );
    return {
      data_base64: row.data_base64 ?? row.data ?? "",
      mime_type: row.mime_type ?? "image/png",
    };
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.transport.sendRequest(M.PLAYWRIGHT_WAIT_FOR_TIMEOUT, withSessionMeta({ tab_id: this.id, timeout_ms: ms }), ms + 1000);
  }

  async close(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_CLOSE, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_CLOSE, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async #ensureTabCommandAllowed(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<void> {
    const command = { command: method, tab_id: this.id, ...params };
    const currentUrl = this.guards.needsCurrentUrl(method)
      ? await this.#currentUrlForGuard(timeout)
      : undefined;
    await this.guards.ensureCommandAllowed(command, { currentUrl });
  }

  async #currentUrlForGuard(timeout?: number): Promise<string> {
    return await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.id }), timeout);
  }

  async waitForEvent(event: "filechooser" | "download", opts: { timeout?: number } = {}): Promise<FileChooser | Download> {
    if (event === "filechooser") {
      const command = { command: M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER, tab_id: this.id };
      const currentUrl = this.guards.needsCurrentUrl(M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER)
        ? await this.#currentUrlForGuard(opts.timeout)
        : undefined;
      await this.guards.ensureCommandAllowed(command, { currentUrl });
      const row = await this.transport.sendRequest<{ file_chooser_id: string; id?: string }>(
        M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER,
        withSessionMeta({ tab_id: this.id }),
        opts.timeout,
      );
      return new FileChooser(this.transport, row.file_chooser_id ?? row.id ?? "", this.guards, this.id);
    }
    const currentUrl = this.guards.needsCurrentUrl(M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD)
      ? await this.#currentUrlForGuard(opts.timeout)
      : undefined;
    await this.guards.ensureCommandAllowed({ command: M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD, tab_id: this.id }, { currentUrl });
    const row = await this.transport.sendRequest<{ download_id: string; id?: string }>(
      M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
      withSessionMeta({ tab_id: this.id }),
      opts.timeout,
    );
    return new Download(this.transport, row.download_id ?? row.id ?? "", this.guards, this.id);
  }

  async #waitForNavigationFrom(
    startUrl: string,
    deadline: number,
    opts: TabNavigationWaitOptions,
    isCancelled: () => boolean,
  ): Promise<void> {
    const pollInterval = Math.max(0, opts.pollInterval ?? DEFAULT_NAVIGATION_POLL_MS);
    while (!isCancelled()) {
      const currentUrl = await this.url({ timeout: remainingMs(deadline) });
      if (currentUrl !== startUrl && navigationUrlMatches(currentUrl, opts.url)) {
        await this.waitForLoadState(opts.waitUntil ?? "load", { timeout: remainingMs(deadline) });
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`navigation timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms`);
      }
      await delay(Math.min(pollInterval, remaining));
    }
  }
}

function navigationUrlMatches(currentUrl: string, expected?: string | RegExp): boolean {
  if (expected === undefined) return true;
  return typeof expected === "string" ? currentUrl === expected : expected.test(currentUrl);
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
