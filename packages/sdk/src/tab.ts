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

export type ScreenshotOptions = {
  timeout?: number;
  type?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
  };
};

export type ArtifactMode = "inline" | "resource" | "auto";

export type ScreenshotForModelOptions = ScreenshotOptions & {
  artifactMode?: ArtifactMode;
  maxInlineBytes?: number;
};

export type ScreenshotForModelResult =
  | {
      kind: "resource";
      mime_type: string;
      bytes: number;
      summary: string;
    }
  | {
      kind: "inline";
      mime_type: string;
      data_base64: string;
      bytes: number;
      warning?: string;
    };

export type TabEvaluateOptions = {
  timeout?: number;
  maxJsonBytes?: number;
};

export type TabSnapshotTextOptions = TabEvaluateOptions & {
  maxItems?: number;
  maxTextLength?: number;
};

export type TabSnapshotTextResult = {
  url: string;
  title: string;
  headings: Array<{ level: number; text: string }>;
  buttons: string[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ label: string; type: string; name: string; placeholder: string }>;
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

  async screenshot(opts: ScreenshotOptions = {}): Promise<{ data_base64: string; mime_type: string }> {
    await this.#ensureTabCommandAllowed(M.TAB_SCREENSHOT, {}, opts.timeout);
    const row = await this.transport.sendRequest<{ data?: string; data_base64?: string; mime_type?: string }>(
      M.TAB_SCREENSHOT,
      withSessionMeta({ tab_id: this.id, ...screenshotParams(opts) }),
      opts.timeout,
    );
    return {
      data_base64: row.data_base64 ?? row.data ?? "",
      mime_type: row.mime_type ?? "image/png",
    };
  }

  async screenshotForModel(opts: ScreenshotForModelOptions = {}): Promise<ScreenshotForModelResult> {
    const artifactMode = opts.artifactMode ?? "auto";
    const maxInlineBytes = opts.maxInlineBytes ?? 32 * 1024;
    const shot = await this.screenshot({
      ...opts,
      type: opts.type ?? "jpeg",
      quality: opts.quality ?? 60,
      fullPage: opts.fullPage ?? false,
    });
    const bytes = estimatedBase64Bytes(shot.data_base64);
    const shouldEmit =
      artifactMode === "resource" || (artifactMode === "auto" && bytes > maxInlineBytes);
    if (shouldEmit) {
      const emitted = await emitMcpImage(shot);
      if (emitted) {
        return {
          kind: "resource",
          mime_type: shot.mime_type,
          bytes,
          summary: `${bytes} byte ${shot.mime_type} screenshot emitted as an MCP resource`,
        };
      }
    }
    return {
      kind: "inline",
      mime_type: shot.mime_type,
      data_base64: shot.data_base64,
      bytes,
      ...(shouldEmit
        ? { warning: "MCP image emission is unavailable; returned inline screenshot bytes" }
        : {}),
    };
  }

  async evaluate<T = unknown>(
    expressionOrFn: string | (() => T | Promise<T>),
    opts: TabEvaluateOptions = {},
  ): Promise<T | unknown> {
    const maxJsonBytes = opts.maxJsonBytes ?? 64 * 1024;
    const response = await this.dev.cdp<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression: boundedEvaluateExpression(expressionOrFn, maxJsonBytes),
        awaitPromise: true,
        returnByValue: true,
      },
      optionalTimeout(opts.timeout),
    );
    if (response?.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? "tab.evaluate failed",
      );
    }
    const value = response?.result?.value;
    if (isRecord(value) && "__obu_evaluate_value" in value) {
      return value.__obu_evaluate_value as T;
    }
    if (isRecord(value) && "__obu_evaluate_summary" in value) {
      return value.__obu_evaluate_summary;
    }
    return value as T;
  }

  async snapshotText(opts: TabSnapshotTextOptions = {}): Promise<TabSnapshotTextResult> {
    const maxItems = positiveInt(opts.maxItems, 20);
    const maxTextLength = positiveInt(opts.maxTextLength, 120);
    const result = await this.evaluate<TabSnapshotTextResult>(
      snapshotTextExpression(maxItems, maxTextLength),
      evaluateOptions(opts.timeout, opts.maxJsonBytes ?? 32 * 1024),
    );
    if (isTruncatedEvaluateSummary(result)) {
      throw new Error(
        "tab.snapshotText result exceeded maxJsonBytes; reduce maxItems/maxTextLength or increase maxJsonBytes",
      );
    }
    return result as TabSnapshotTextResult;
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

function screenshotParams(opts: ScreenshotOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (opts.type !== undefined) params.type = opts.type;
  if (opts.quality !== undefined) params.quality = opts.quality;
  if (opts.fullPage !== undefined) params.fullPage = opts.fullPage;
  if (opts.clip !== undefined) params.clip = opts.clip;
  return params;
}

function estimatedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

async function emitMcpImage(shot: { data_base64: string; mime_type: string }): Promise<boolean> {
  const nodeRepl = (globalThis as {
    nodeRepl?: { emitImage?: (image: string) => Promise<void> | void };
  }).nodeRepl;
  if (typeof nodeRepl?.emitImage !== "function") {
    return false;
  }
  await nodeRepl.emitImage(`data:${shot.mime_type};base64,${shot.data_base64}`);
  return true;
}

function boundedEvaluateExpression(
  expressionOrFn: string | (() => unknown),
  maxJsonBytes: number,
): string {
  const source = typeof expressionOrFn === "function"
    ? `(${expressionOrFn})()`
    : `(${expressionOrFn})`;
  return `
(async () => {
  const __obuValue = await ${source};
  const __obuNormalized = __obuValue === undefined ? null : __obuValue;
  let __obuJson;
  try {
    __obuJson = JSON.stringify(__obuNormalized);
  } catch {
    return { __obu_evaluate_summary: summarizeObuValue(__obuNormalized, null, "not_json_serializable") };
  }
  const __obuBytes = typeof TextEncoder === "function"
    ? new TextEncoder().encode(__obuJson ?? "null").length
    : (__obuJson ?? "null").length;
  if (__obuBytes > ${Math.max(1, Math.floor(maxJsonBytes))}) {
    return { __obu_evaluate_summary: summarizeObuValue(__obuNormalized, __obuBytes, "max_json_bytes") };
  }
  return { __obu_evaluate_value: __obuNormalized };

  function summarizeObuValue(value, bytes, reason) {
    if (Array.isArray(value)) return { kind: "truncated", type: "array", length: value.length, bytes, reason };
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      return { kind: "truncated", type: "object", keys: keys.slice(0, 25), key_count: keys.length, bytes, reason };
    }
    return { kind: "truncated", type: value === null ? "null" : typeof value, bytes, reason };
  }
})()
`;
}

function snapshotTextExpression(maxItems: number, maxTextLength: number): string {
  return `
(() => {
  const text = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, ${maxTextLength});
  const take = (selector) => Array.from(document.querySelectorAll(selector)).slice(0, ${maxItems});
  const labelFor = (input) => {
    if (input.labels && input.labels.length) return text(input.labels[0].textContent);
    if (input.getAttribute("aria-label")) return text(input.getAttribute("aria-label"));
    return text(input.getAttribute("name") || input.getAttribute("placeholder") || "");
  };
  return {
    url: location.href,
    title: document.title,
    headings: take("h1,h2,h3").map((el) => ({ level: Number(el.tagName.slice(1)), text: text(el.textContent) })),
    buttons: take("button,[role=button],input[type=button],input[type=submit]").map((el) => text(el.textContent || el.value || el.getAttribute("aria-label"))).filter(Boolean),
    links: take("a[href]").map((el) => ({ text: text(el.textContent || el.getAttribute("aria-label")), href: text(el.href) })),
    forms: take("input,textarea,select").map((el) => ({
      label: labelFor(el),
      type: text(el.getAttribute("type") || el.tagName.toLowerCase()),
      name: text(el.getAttribute("name")),
      placeholder: text(el.getAttribute("placeholder")),
    })),
  };
})()
`;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function optionalTimeout(timeout: number | undefined): { timeout?: number } {
  return timeout === undefined ? {} : { timeout };
}

function evaluateOptions(timeout: number | undefined, maxJsonBytes: number): TabEvaluateOptions {
  const opts: TabEvaluateOptions = { maxJsonBytes };
  if (timeout !== undefined) opts.timeout = timeout;
  return opts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTruncatedEvaluateSummary(value: unknown): boolean {
  return isRecord(value) && value.kind === "truncated";
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
