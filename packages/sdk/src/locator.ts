import { FrameLocator } from "./frame-locator.js";
import { Guards, type CommandabilityGuard } from "./guards.js";
import { Image } from "./image.js";
import { withSessionMeta } from "./session-meta.js";
import type { LoadState } from "./tab.js";
import type { BoundingBox } from "./types.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

const DEFAULT_TIMEOUT_MS = 30_000;
type TextMatcher = string | RegExp;
type LocatorNavigationWaitOptions = boolean | {
  waitUntil?: LoadState;
  timeout?: number;
};
type LocatorClickOptions = {
  button?: "left" | "right" | "middle";
  modifiers?: string[];
  force?: boolean;
  timeout?: number;
  waitForNavigation?: LocatorNavigationWaitOptions;
};
type LocatorDblClickOptions = {
  timeout?: number;
  waitForNavigation?: LocatorNavigationWaitOptions;
};

type LocatorReadAllRow = {
  attributes?: Record<string, string>;
  inner_text?: string;
  innerText?: string;
  text_content?: string | null;
  textContent?: string | null;
};

function escapeRegexForSelector(value: RegExp): string {
  return String(value).replace(/(^|[^\\])(\\\\)*(["'`])/g, "$1$2\\$3").replace(/>>/g, "\\>\\>");
}

export function textSelector(value: TextMatcher, exact: boolean): string {
  return typeof value !== "string" ? escapeRegexForSelector(value) : `${JSON.stringify(value)}${exact ? "s" : "i"}`;
}

export function attrSelector(value: TextMatcher, exact: boolean): string {
  if (typeof value !== "string") return escapeRegexForSelector(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${exact ? "s" : "i"}`;
}

export function roleSelector(role: string, opts: { name?: TextMatcher; exact?: boolean } = {}): string {
  if (!role) throw new Error("getByRole requires a role");
  return `internal:role=${role}${opts.name !== undefined ? `[name=${attrSelector(opts.name, !!opts.exact)}]` : ""}`;
}

export function testIdSelector(testId: string): string {
  if (!testId) throw new Error("getByTestId requires a testId");
  return `internal:testid=[data-testid=${attrSelector(testId, true)}]`;
}

export class Locator {
  constructor(
    protected readonly transport: Transport,
    protected readonly guards: Guards,
    protected readonly tabId: string,
    protected readonly selector: string,
    protected readonly ensureCommandable?: CommandabilityGuard,
  ) {}

  locator(subSelector: string): Locator {
    if (!subSelector) throw new Error("locator.locator requires a selector");
    if (!this.selector) return new Locator(this.transport, this.guards, this.tabId, subSelector, this.ensureCommandable);
    return new Locator(this.transport, this.guards, this.tabId, `${this.selector} >> ${subSelector}`, this.ensureCommandable);
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  nth(index: number): Locator {
    if (typeof index !== "number") throw new Error("locator.nth requires a numeric index");
    return this.locator(`nth=${index}`);
  }

  async all(opts: { timeout?: number } = {}): Promise<Locator[]> {
    const count = await this.count();
    const cache = new LocatorReadAllCache(this.transport, this.guards, this.tabId, this.selector, this.ensureCommandable);
    return Array.from({ length: count }, (_, index) => {
      const selector = this.selector ? `${this.selector} >> nth=${index}` : `nth=${index}`;
      return new CachedLocator(this.transport, this.guards, this.tabId, selector, index, cache, opts.timeout, this.ensureCommandable);
    });
  }

  and(other: Locator): Locator {
    this.#assertCompatible(other, "locator.and");
    return this.locator(`internal:and=${JSON.stringify(other.selector)}`);
  }

  or(other: Locator): Locator {
    this.#assertCompatible(other, "locator.or");
    return this.locator(`internal:or=${JSON.stringify(other.selector)}`);
  }

  filter(opts: { has?: Locator; hasNot?: Locator; hasText?: TextMatcher; hasNotText?: TextMatcher; visible?: boolean } = {}): Locator {
    const parts = [this.selector];
    if (opts.hasText !== undefined) parts.push(`internal:has-text=${textSelector(opts.hasText, false)}`);
    if (opts.hasNotText !== undefined) parts.push(`internal:has-not-text=${textSelector(opts.hasNotText, false)}`);
    if (opts.has) {
      this.#assertCompatible(opts.has, "locator.filter has");
      parts.push(`internal:has=${JSON.stringify(opts.has.selector)}`);
    }
    if (opts.hasNot) {
      this.#assertCompatible(opts.hasNot, "locator.filter hasNot");
      parts.push(`internal:has-not=${JSON.stringify(opts.hasNot.selector)}`);
    }
    if (opts.visible !== undefined) parts.push(`visible=${opts.visible}`);
    return new Locator(this.transport, this.guards, this.tabId, parts.filter(Boolean).join(" >> "), this.ensureCommandable);
  }

  frameLocator(selector: string): FrameLocator {
    if (!selector) throw new Error("locator.frameLocator requires a selector");
    return new FrameLocator(this.transport, this.guards, this.tabId, this.selector ? `${this.selector} >> ${selector}` : selector, this.ensureCommandable);
  }

  getByRole(role: string, opts: { name?: TextMatcher; exact?: boolean } = {}): Locator {
    return this.locator(roleSelector(role, opts));
  }

  getByText(text: TextMatcher, opts: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:text=${textSelector(text, !!opts.exact)}`);
  }

  getByLabel(text: TextMatcher, opts: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:label=${textSelector(text, !!opts.exact)}`);
  }

  getByPlaceholder(text: TextMatcher, opts: { exact?: boolean } = {}): Locator {
    return this.locator(`internal:attr=[placeholder=${attrSelector(text, !!opts.exact)}]`);
  }

  getByTestId(testId: string): Locator {
    return this.locator(testIdSelector(testId));
  }

  async click(opts: LocatorClickOptions = {}): Promise<void> {
    await this.#send(
      M.PLAYWRIGHT_LOCATOR_CLICK,
      { button: opts.button, modifiers: opts.modifiers, force: opts.force, ...navigationWaitParams(opts) },
      opts.timeout,
      requestTimeoutWithNavigationWait(opts),
    );
  }

  async dblclick(opts: LocatorDblClickOptions = {}): Promise<void> {
    await this.#send(
      M.PLAYWRIGHT_LOCATOR_DBLCLICK,
      navigationWaitParams(opts),
      opts.timeout,
      requestTimeoutWithNavigationWait(opts),
    );
  }

  async type(text: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.PLAYWRIGHT_LOCATOR_FILL, { value: text, replace: false }, opts.timeout);
  }

  async fill(text: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.PLAYWRIGHT_LOCATOR_FILL, { value: text, replace: true }, opts.timeout);
  }

  async press(key: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.PLAYWRIGHT_LOCATOR_PRESS, { value: key }, opts.timeout);
  }

  async hover(opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.PLAYWRIGHT_LOCATOR_HOVER, {}, opts.timeout);
  }

  async download_media(opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA, {}, opts.timeout);
  }

  async isVisible(): Promise<boolean> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_IS_VISIBLE, {}) as boolean;
  }

  async isEnabled(): Promise<boolean> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_IS_ENABLED, {}) as boolean;
  }

  async boundingBox(): Promise<BoundingBox | null> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_BOUNDING_BOX, {}) as BoundingBox | null;
  }

  async count(): Promise<number> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_COUNT, {}) as number;
  }

  async waitFor(opts: { state?: "visible" | "hidden" | "attached" | "detached"; timeout?: number } = {}): Promise<void> {
    await this.#send(M.PLAYWRIGHT_LOCATOR_WAIT_FOR, { state: opts.state ?? "visible" }, opts.timeout);
  }

  async textContent(): Promise<string | null> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_TEXT_CONTENT, {}) as string | null;
  }

  async innerText(): Promise<string> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_INNER_TEXT, {}) as string;
  }

  async getAttribute(name: string): Promise<string | null> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE, { name }) as string | null;
  }

  async allTextContents(): Promise<string[]> {
    return await this.#send(M.PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS, {}) as string[];
  }

  async selectOption(values: string | string[] | { value?: string; label?: string; index?: number }[]): Promise<void> {
    const list = Array.isArray(values) ? values : [values];
    const selections = list.map((value) => typeof value === "string" ? { value } : value);
    await this.#send(M.PLAYWRIGHT_LOCATOR_SELECT_OPTION, { selections });
  }

  async setChecked(checked: boolean, opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.PLAYWRIGHT_LOCATOR_SET_CHECKED, { checked }, opts.timeout);
  }

  async check(opts: { timeout?: number } = {}): Promise<void> {
    await this.setChecked(true, opts);
  }

  async uncheck(opts: { timeout?: number } = {}): Promise<void> {
    await this.setChecked(false, opts);
  }

  async screenshot(opts: { timeout?: number } = {}): Promise<Image> {
    this.ensureCommandable?.(M.PLAYWRIGHT_SCREENSHOT);
    const box = await this.boundingBox();
    if (!box) throw new Error(`locator.screenshot failed: no bounding box for ${this.selector}`);
    const params = {
      tab_id: this.tabId,
      cropX: box.x,
      cropY: box.y,
      cropWidth: box.width,
      cropHeight: box.height,
    };
    const currentUrl = this.guards.needsCurrentUrl(M.PLAYWRIGHT_SCREENSHOT)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), opts.timeout)
      : undefined;
    await this.guards.ensureCommandAllowed(
      { command: M.PLAYWRIGHT_SCREENSHOT, ...params },
      { currentUrl },
    );
    const row = await this.transport.sendRequest<{ data: string }>(
      M.PLAYWRIGHT_SCREENSHOT,
      withSessionMeta(params),
      opts.timeout ?? DEFAULT_TIMEOUT_MS,
    );
    return Image.from({ data_base64: row.data, mime_type: "image/png" });
  }

  async #send(method: string, params: Record<string, unknown>, timeoutMs?: number, requestTimeoutMs?: number): Promise<unknown> {
    this.ensureCommandable?.(method);
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const requestTimeout = requestTimeoutMs ?? timeout;
    const command = {
      command: method,
      tab_id: this.tabId,
      selector: this.selector,
      timeout_ms: timeout,
      ...params,
    };
    const currentUrl = this.guards.needsCurrentUrl(method)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), timeout)
      : undefined;
    await this.guards.ensureCommandAllowed(command, { currentUrl });
    return await this.transport.sendRequest(method, withSessionMeta(command), requestTimeout);
  }

  #assertCompatible(other: Locator, label: string): void {
    if (!(other instanceof Locator)) throw new Error(`${label} requires a Locator`);
    if (other.tabId !== this.tabId) throw new Error("Locators must belong to the same tab");
  }
}

class CachedLocator extends Locator {
  constructor(
    transport: Transport,
    guards: Guards,
    tabId: string,
    selector: string,
    private readonly index: number,
    private readonly cache: LocatorReadAllCache,
    private readonly readTimeout?: number,
    ensureCommandable?: CommandabilityGuard,
  ) {
    super(transport, guards, tabId, selector, ensureCommandable);
  }

  override async textContent(): Promise<string | null> {
    const row = await this.cache.row(this.index, this.readTimeout);
    return row.text_content ?? row.textContent ?? null;
  }

  override async innerText(): Promise<string> {
    const row = await this.cache.row(this.index, this.readTimeout);
    return row.inner_text ?? row.innerText ?? "";
  }

  override async getAttribute(name: string): Promise<string | null> {
    const row = await this.cache.row(this.index, this.readTimeout);
    return row.attributes?.[name] ?? null;
  }
}

class LocatorReadAllCache {
  private rowsPromise: Promise<LocatorReadAllRow[]> | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    private readonly tabId: string,
    private readonly selector: string,
    private readonly ensureCommandable?: CommandabilityGuard,
  ) {}

  async row(index: number, timeoutMs?: number): Promise<LocatorReadAllRow> {
    const rows = await this.rows(timeoutMs);
    return rows[index] ?? {};
  }

  private async rows(timeoutMs?: number): Promise<LocatorReadAllRow[]> {
    if (!this.rowsPromise) {
      this.ensureCommandable?.(M.PLAYWRIGHT_LOCATOR_READ_ALL);
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const command = {
        command: M.PLAYWRIGHT_LOCATOR_READ_ALL,
        tab_id: this.tabId,
        selector: this.selector,
        timeout_ms: timeout,
      };
      const currentUrl = this.guards.needsCurrentUrl(M.PLAYWRIGHT_LOCATOR_READ_ALL)
        ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), timeout)
        : undefined;
      await this.guards.ensureCommandAllowed(command, { currentUrl });
      this.rowsPromise = this.transport.sendRequest<LocatorReadAllRow[]>(
        M.PLAYWRIGHT_LOCATOR_READ_ALL,
        withSessionMeta(command),
        timeout,
      );
    }
    return await this.rowsPromise;
  }
}

function navigationWaitParams(opts: { timeout?: number; waitForNavigation?: LocatorNavigationWaitOptions }): Record<string, unknown> {
  const wait = opts.waitForNavigation;
  if (!wait) return {};
  if (wait === true) {
    return {
      wait_for_navigation: true,
      navigation_timeout_ms: opts.timeout,
    };
  }
  return {
    wait_for_navigation: true,
    navigation_wait_until: wait.waitUntil,
    navigation_timeout_ms: wait.timeout ?? opts.timeout,
  };
}

function requestTimeoutWithNavigationWait(opts: { timeout?: number; waitForNavigation?: LocatorNavigationWaitOptions }): number | undefined {
  const wait = opts.waitForNavigation;
  if (!wait) return opts.timeout;
  const actionTimeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const navigationTimeout = wait === true ? actionTimeout : (wait.timeout ?? actionTimeout);
  return actionTimeout + navigationTimeout;
}
