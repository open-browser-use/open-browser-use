import { withSessionMeta } from "./session-meta.js";
import { Guards } from "./guards.js";
import type { LoadState } from "./tab.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export type TabCuaPoint = {
  x: number;
  y: number;
};

export type TabCuaTimeoutOptions = {
  timeout?: number;
};

export type TabCuaMouseOptions = TabCuaTimeoutOptions & {
  button?: "left" | "right" | "middle";
  modifiers?: string[];
  waitForNavigation?: boolean | {
    waitUntil?: LoadState;
    timeout?: number;
  };
};

export type TabCuaScrollDelta =
  | number
  | {
      deltaX?: number;
      deltaY?: number;
    };

export class TabCua {
  private readonly guards: Guards;
  private readonly tabId: string;

  constructor(
    private readonly transport: Transport,
    guardsOrTabId: Guards | string,
    tabId?: string,
  ) {
    this.guards = guardsOrTabId instanceof Guards ? guardsOrTabId : new Guards();
    this.tabId = guardsOrTabId instanceof Guards ? (tabId ?? "") : guardsOrTabId;
  }

  async click(x: number, y: number, opts: TabCuaMouseOptions = {}): Promise<void> {
    await this.#send(
      M.CUA_CLICK,
      { x, y, button: opts.button, modifiers: opts.modifiers, ...navigationWaitParams(opts) },
      opts.timeout,
      requestTimeoutWithNavigationWait(opts),
    );
  }

  async dblclick(x: number, y: number, opts: TabCuaMouseOptions = {}): Promise<void> {
    await this.#send(
      M.CUA_DBLCLICK,
      { x, y, button: opts.button, modifiers: opts.modifiers, ...navigationWaitParams(opts) },
      opts.timeout,
      requestTimeoutWithNavigationWait(opts),
    );
  }

  async scroll(
    x: number,
    y: number,
    delta: TabCuaScrollDelta,
    opts: TabCuaTimeoutOptions = {},
  ): Promise<void> {
    const deltaX = typeof delta === "number" ? 0 : (delta.deltaX ?? 0);
    const deltaY = typeof delta === "number" ? delta : (delta.deltaY ?? 0);
    await this.#send(M.CUA_SCROLL, { x, y, deltaX, deltaY }, opts.timeout);
  }

  async type(text: string, opts: TabCuaTimeoutOptions = {}): Promise<void> {
    await this.#send(M.CUA_TYPE, { text }, opts.timeout);
  }

  async keypress(
    key: string | string[],
    opts: TabCuaTimeoutOptions & { modifiers?: string[] } = {},
  ): Promise<void> {
    const keyPayload = Array.isArray(key) ? { keys: key } : { key };
    await this.#send(M.CUA_KEYPRESS, { ...keyPayload, modifiers: opts.modifiers }, opts.timeout);
  }

  async drag(
    from: TabCuaPoint,
    to: TabCuaPoint,
    opts: TabCuaTimeoutOptions & { steps?: number } = {},
  ): Promise<void> {
    await this.#send(M.CUA_DRAG, { from, to, steps: opts.steps }, opts.timeout);
  }

  async dragPath(path: TabCuaPoint[], opts: TabCuaTimeoutOptions = {}): Promise<void> {
    await this.#send(M.CUA_DRAG, { path }, opts.timeout);
  }

  async move(x: number, y: number, opts: TabCuaTimeoutOptions = {}): Promise<void> {
    await this.#send(M.CUA_MOVE, { x, y }, opts.timeout);
  }

  async #send(method: string, params: Record<string, unknown>, timeoutMs?: number, requestTimeoutMs?: number): Promise<void> {
    const requestTimeout = requestTimeoutMs ?? timeoutMs;
    const command = { command: method, tab_id: this.tabId, ...params };
    const currentUrl = this.guards.needsCurrentUrl(method)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), timeoutMs)
      : undefined;
    await this.guards.ensureCommandAllowed(command, { currentUrl });
    await this.transport.sendRequest(method, withSessionMeta({ tab_id: this.tabId, ...params }), requestTimeout);
  }
}

function navigationWaitParams(opts: TabCuaMouseOptions): Record<string, unknown> {
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

function requestTimeoutWithNavigationWait(opts: TabCuaMouseOptions): number | undefined {
  const wait = opts.waitForNavigation;
  if (!wait) return opts.timeout;
  const actionTimeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const navigationTimeout = wait === true ? actionTimeout : (wait.timeout ?? actionTimeout);
  return actionTimeout + navigationTimeout;
}
