import { Guards } from "./guards.js";
import { withSessionMeta } from "./session-meta.js";
import { Tab } from "./tab.js";
import { tabFromWire, tabIdFromWire, tabMetadata, type TabWire } from "./tab_wire.js";
import { UserTabRef } from "./browser_user.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

const DEFAULT_CONTENT_URL_TIMEOUT_MS = 30_000;
const CONTENT_BATCH_TIMEOUT_BUFFER_MS = 1_000;

export type CreateTabOptions = {
  url?: string;
};

export type BrowserTabsContentOptions = {
  urls: string[];
  contentType?: "text" | "html" | "json";
  /** Per-URL fetch timeout. */
  timeout?: number;
  /** Whole RPC deadline. Defaults to enough time for every URL to produce a result. */
  requestTimeout?: number;
};

export type BrowserTabsContentResult = {
  results: BrowserTabsContentEntry[];
};

export type BrowserTabsContentEntry = {
  url: string;
  finalUrl?: string;
  status: "ok" | "error";
  httpStatus?: number;
  contentType?: string;
  text?: string;
  redirects?: string[];
  errorCode?: string;
  errorMessage?: string;
};

export class BrowserTabs {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
  ) {}

  async list(opts: { timeout?: number } = {}): Promise<Tab[]> {
    const rows = await this.transport.sendRequest<TabWire[]>(M.GET_TABS, withSessionMeta({}), opts.timeout);
    return rows.map((row) => this.fromWire(row));
  }

  async current(opts: { timeout?: number } = {}): Promise<Tab | undefined> {
    const row = await this.transport.sendRequest<TabWire | null>(
      M.GET_CURRENT_TAB,
      withSessionMeta({}),
      opts.timeout,
    );
    if (!row) return undefined;
    return this.fromWire(row, "getCurrentTab response missing tab_id");
  }

  async selected(opts: { timeout?: number } = {}): Promise<Tab | UserTabRef | undefined> {
    await this.guards.ensureCommandAllowed({ command: M.GET_SELECTED_TAB });
    const row = await this.transport.sendRequest<TabWire | null>(
      M.GET_SELECTED_TAB,
      withSessionMeta({}),
      opts.timeout,
    );
    if (!row) return undefined;
    const id = tabIdFromWire(row, "getSelectedTab response missing tab_id");
    const metadata = tabMetadata(row);
    if (row.commandable === false || row.claimRequired === true || row.claim_required === true) {
      return new UserTabRef(this.transport, this.guards, id, metadata);
    }
    return new Tab(this.transport, this.guards, id, metadata);
  }

  async create(urlOrOptions?: string | CreateTabOptions): Promise<Tab> {
    const url = normalizeCreateUrl(urlOrOptions);
    const params: Record<string, unknown> = { url };
    await this.guards.ensureCommandAllowed({ command: M.CREATE_TAB, ...params });
    const row = await this.transport.sendRequest<TabWire>(M.CREATE_TAB, withSessionMeta(params));
    return this.fromWire(row, "createTab response missing tab_id");
  }

  async content(opts: BrowserTabsContentOptions): Promise<BrowserTabsContentResult> {
    if (!opts || !Array.isArray(opts.urls)) {
      throw new TypeError("browser.tabs.content expected { urls: string[] }");
    }
    validateOptionalPositiveTimeout(opts.timeout, "timeout");
    validateOptionalPositiveTimeout(opts.requestTimeout, "requestTimeout");
    const allowedUrls: string[] = [];
    const allowedIndexes: number[] = [];
    const results: Array<BrowserTabsContentEntry | undefined> = Array.from({ length: opts.urls.length });
    for (const url of opts.urls) {
      if (typeof url !== "string" || url.length === 0) {
        throw new TypeError("browser.tabs.content urls must be non-empty strings");
      }
    }
    for (const [index, url] of opts.urls.entries()) {
      try {
        await this.guards.ensureCommandAllowed({ command: M.BROWSER_TABS_CONTENT, url });
        allowedUrls.push(url);
        allowedIndexes.push(index);
      } catch (error) {
        results[index] = contentGuardError(url, error);
      }
    }
    if (allowedUrls.length === 0) {
      return { results: completeContentResults(results, opts.urls) };
    }
    const params: Record<string, unknown> = { urls: allowedUrls };
    if (opts.contentType !== undefined) params.contentType = opts.contentType;
    if (opts.timeout !== undefined) params.timeout = opts.timeout;
    const response = await this.transport.sendRequest<BrowserTabsContentResult>(
      M.BROWSER_TABS_CONTENT,
      withSessionMeta(params),
      contentRequestTimeout(opts, allowedUrls.length),
    );
    for (const [resultIndex, result] of response.results.entries()) {
      const originalIndex = allowedIndexes[resultIndex];
      if (originalIndex !== undefined) results[originalIndex] = result;
    }
    return { results: completeContentResults(results, opts.urls) };
  }

  get(tabId: string): Tab {
    return new Tab(this.transport, this.guards, tabId);
  }

  private fromWire(row: TabWire, missingIdMessage = "getTabs response missing tab_id"): Tab {
    return tabFromWire(this.transport, this.guards, row, missingIdMessage);
  }
}

function normalizeCreateUrl(urlOrOptions: string | CreateTabOptions | undefined): string {
  if (urlOrOptions === undefined) return "about:blank";
  if (typeof urlOrOptions === "string") return urlOrOptions;
  if (typeof urlOrOptions === "object" && urlOrOptions !== null && !Array.isArray(urlOrOptions)) {
    if (urlOrOptions.url === undefined) return "about:blank";
    if (typeof urlOrOptions.url === "string") return urlOrOptions.url;
  }
  throw new TypeError("browser.tabs.create expected a URL string or { url: string }");
}

function contentRequestTimeout(opts: BrowserTabsContentOptions, urlCount: number): number {
  if (opts.requestTimeout !== undefined) return opts.requestTimeout;
  const perUrlTimeout = opts.timeout ?? DEFAULT_CONTENT_URL_TIMEOUT_MS;
  return perUrlTimeout * Math.max(1, urlCount) + CONTENT_BATCH_TIMEOUT_BUFFER_MS;
}

function validateOptionalPositiveTimeout(value: number | undefined, key: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`browser.tabs.content ${key} must be a positive number`);
  }
}

function contentGuardError(url: string, error: unknown): BrowserTabsContentEntry {
  const message = error instanceof Error ? error.message : String(error ?? "command disallowed");
  return {
    url,
    status: "error",
    errorCode: "disallowed_command",
    errorMessage: message,
  };
}

function completeContentResults(
  results: Array<BrowserTabsContentEntry | undefined>,
  urls: string[],
): BrowserTabsContentEntry[] {
  return results.map((result, index) => result ?? {
    url: urls[index] ?? "",
    status: "error",
    errorCode: "missing_result",
    errorMessage: `browser.tabs.content missing result for index ${index}`,
  });
}
