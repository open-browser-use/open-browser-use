import { withSessionMeta } from "./session-meta.js";
import { Guards } from "./guards.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export class Download {
  constructor(
    private readonly transport: Transport,
    public readonly id: string,
    private readonly guards = new Guards(),
    public readonly tabId?: string,
  ) {}

  async path(): Promise<string> {
    const params = {
      ...(this.tabId ? { tab_id: this.tabId } : {}),
      download_id: this.id,
    };
    const currentUrl = this.tabId && this.guards.needsCurrentUrl(M.PLAYWRIGHT_DOWNLOAD_PATH)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }))
      : undefined;
    await this.guards.ensureCommandAllowed({
      command: M.PLAYWRIGHT_DOWNLOAD_PATH,
      ...params,
    }, { currentUrl });
    const row = await this.transport.sendRequest<{ path: string }>(
      M.PLAYWRIGHT_DOWNLOAD_PATH,
      withSessionMeta(params),
    );
    return row.path;
  }
}
