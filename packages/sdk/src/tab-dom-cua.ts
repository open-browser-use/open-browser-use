import { withSessionMeta } from "./session-meta.js";
import { Guards } from "./guards.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export type DomCuaNode = {
  node_id: string;
  role?: string;
  name?: string;
  text?: string;
  tag?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: DomCuaNode[];
};

export type DomCuaSnapshot = {
  nodes?: DomCuaNode[];
  root?: DomCuaNode;
  text?: string;
};

export type DomCuaTimeoutOptions = { timeout?: number };
export type DomCuaModifierOptions = { modifiers?: string[] };
export type DomCuaActionOptions = DomCuaTimeoutOptions & DomCuaModifierOptions;

export class TabDomCua {
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

  async get_visible_dom(opts: { timeout?: number; format?: "json" }): Promise<DomCuaSnapshot>;
  async get_visible_dom(opts: { timeout?: number; format: "text" }): Promise<string>;
  async get_visible_dom(opts: { timeout?: number; format: "debug_text" }): Promise<string>;
  async get_visible_dom(opts: { timeout?: number; format: "compact_text" }): Promise<string>;
  async get_visible_dom(opts: { timeout?: number; format?: "json" | "text" | "debug_text" | "compact_text" } = {}): Promise<DomCuaSnapshot | string> {
    const currentUrl = this.guards.needsCurrentUrl(M.DOM_CUA_GET_VISIBLE_DOM)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), opts.timeout)
      : undefined;
    await this.guards.ensureCommandAllowed(
      { command: M.DOM_CUA_GET_VISIBLE_DOM, tab_id: this.tabId },
      { currentUrl },
    );
    const response = await this.transport.sendRequest<DomCuaSnapshot>(
      M.DOM_CUA_GET_VISIBLE_DOM,
      withSessionMeta({
        tab_id: this.tabId,
        ...(["text", "debug_text", "compact_text"].includes(opts.format ?? "") ? { format: opts.format } : {}),
      }),
      opts.timeout,
    );
    if (opts.format === "text" || opts.format === "debug_text" || opts.format === "compact_text") return response.text ?? "";
    return response;
  }

  async text(opts: { timeout?: number } = {}): Promise<string> {
    return await this.get_visible_dom({ ...opts, format: "text" });
  }

  async click(node_id: string, opts: DomCuaActionOptions = {}): Promise<void> {
    await this.#send(M.DOM_CUA_CLICK, { node_id, modifiers: opts.modifiers }, opts.timeout);
  }

  async double_click(node_id: string, opts: DomCuaActionOptions = {}): Promise<void> {
    await this.#send(M.DOM_CUA_DOUBLE_CLICK, { node_id, modifiers: opts.modifiers }, opts.timeout);
  }

  async scroll(node_id: string, delta: number | { deltaX?: number; deltaY?: number }, opts?: DomCuaActionOptions): Promise<void>;
  async scroll(delta: number | { deltaX?: number; deltaY?: number }, opts?: DomCuaActionOptions): Promise<void>;
  async scroll(
    nodeOrDelta: string | number | { deltaX?: number; deltaY?: number },
    deltaOrOpts?: number | { deltaX?: number; deltaY?: number } | DomCuaActionOptions,
    maybeOpts: DomCuaActionOptions = {},
  ): Promise<void> {
    const node_id = typeof nodeOrDelta === "string" ? nodeOrDelta : undefined;
    const delta = typeof nodeOrDelta === "string"
      ? ((deltaOrOpts as number | { deltaX?: number; deltaY?: number } | undefined) ?? 0)
      : (nodeOrDelta as number | { deltaX?: number; deltaY?: number });
    const opts = typeof nodeOrDelta === "string"
      ? maybeOpts
      : ((deltaOrOpts as DomCuaActionOptions | undefined) ?? {});
    const deltaX = typeof delta === "number" ? 0 : (delta.deltaX ?? 0);
    const deltaY = typeof delta === "number" ? delta : (delta.deltaY ?? 0);
    await this.#send(M.DOM_CUA_SCROLL, { ...(node_id ? { node_id } : {}), deltaX, deltaY, modifiers: opts.modifiers }, opts.timeout);
  }

  async type(node_id: string, text: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.DOM_CUA_TYPE, { node_id, text }, opts.timeout);
  }

  async keypress(node_id: string, key: string | string[], opts: DomCuaActionOptions = {}): Promise<void> {
    const keyPayload = Array.isArray(key) ? { keys: key } : { key };
    await this.#send(M.DOM_CUA_KEYPRESS, { node_id, ...keyPayload, modifiers: opts.modifiers }, opts.timeout);
  }

  async download_media(node_id: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.#send(M.DOM_CUA_DOWNLOAD_MEDIA, { node_id }, opts.timeout);
  }

  async #send(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<void> {
    const command = { command: method, tab_id: this.tabId, ...params };
    const currentUrl = this.guards.needsCurrentUrl(method)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), timeoutMs)
      : undefined;
    await this.guards.ensureCommandAllowed(command, { currentUrl });
    await this.transport.sendRequest(method, withSessionMeta({ tab_id: this.tabId, ...params }), timeoutMs);
  }
}
