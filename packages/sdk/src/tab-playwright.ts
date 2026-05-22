import { Guards } from "./guards.js";
import { Image } from "./image.js";
import { withSessionMeta } from "./session-meta.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export type ElementPointOptions = {
  x: number;
  y: number;
  includeNonInteractable?: boolean;
  timeout?: number;
};

export type ElementInfo = {
  node_id?: string;
  backendNodeId?: number;
  nodeId?: number;
  nodeName?: string;
  localName?: string;
  nodeType?: number;
  attributes?: Record<string, string>;
  bounds?: { x: number; y: number; width: number; height: number };
  point: { x: number; y: number };
};

export class TabPlaywright {
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

  async elementInfo(opts: ElementPointOptions): Promise<ElementInfo | null> {
    const params = pointParams(this.tabId, opts);
    await this.#ensureAllowed(M.PLAYWRIGHT_ELEMENT_INFO, params, opts.timeout);
    return await this.transport.sendRequest<ElementInfo | null>(
      M.PLAYWRIGHT_ELEMENT_INFO,
      withSessionMeta(params),
      opts.timeout,
    );
  }

  async elementScreenshot(opts: ElementPointOptions): Promise<Image> {
    const params = pointParams(this.tabId, opts);
    await this.#ensureAllowed(M.PLAYWRIGHT_ELEMENT_SCREENSHOT, params, opts.timeout);
    const row = await this.transport.sendRequest<{ data?: string; data_base64?: string; mime_type?: string }>(
      M.PLAYWRIGHT_ELEMENT_SCREENSHOT,
      withSessionMeta(params),
      opts.timeout,
    );
    return Image.from({
      data_base64: row.data_base64 ?? row.data ?? "",
      mime_type: row.mime_type ?? "image/png",
    });
  }

  async #ensureAllowed(method: string, params: Record<string, unknown>, timeout?: number): Promise<void> {
    const currentUrl = this.guards.needsCurrentUrl(method)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), timeout)
      : undefined;
    await this.guards.ensureCommandAllowed({ command: method, ...params }, { currentUrl });
  }
}

function pointParams(tabId: string, opts: ElementPointOptions): Record<string, unknown> {
  return {
    tab_id: tabId,
    x: opts.x,
    y: opts.y,
    includeNonInteractable: opts.includeNonInteractable,
  };
}
