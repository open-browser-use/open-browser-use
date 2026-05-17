import { withSessionMeta } from "./session-meta.js";
import { Guards } from "./guards.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export type ContentExportOptions = {
  format?: "html" | "png" | "pdf";
  timeout?: number;
};

export class TabContent {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    private readonly tabId: string,
  ) {}

  async export(opts: ContentExportOptions = {}): Promise<{ data: string; data_base64: string; mime_type: string }> {
    const params: Record<string, unknown> = { tab_id: this.tabId };
    if (opts.format !== undefined) params.format = opts.format;
    await this.#ensureCommandAllowed(M.TAB_CONTENT_EXPORT, params, opts.timeout);
    return await this.transport.sendRequest(
      M.TAB_CONTENT_EXPORT,
      withSessionMeta(params),
      opts.timeout,
    );
  }

  async #ensureCommandAllowed(method: string, params: Record<string, unknown>, timeout?: number): Promise<void> {
    const currentUrl = this.guards.needsCurrentUrl(method)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), timeout)
      : undefined;
    await this.guards.ensureCommandAllowed({ command: method, ...params }, { currentUrl });
  }
}
