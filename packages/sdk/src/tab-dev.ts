import { withSessionMeta } from "./session-meta.js";
import { Guards } from "./guards.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export class TabDev {
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

  async cdp<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeout?: number } = {},
  ): Promise<T> {
    const command = {
      command: M.EXECUTE_CDP,
      tab_id: this.tabId,
      target: { tabId: this.tabId },
      method,
      commandParams: params,
    };
    const currentUrl = this.guards.needsCurrentUrl(M.EXECUTE_CDP)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }))
      : undefined;
    await this.guards.ensureCommandAllowed(command, { currentUrl });
    return await this.transport.sendRequest<T>(
      M.EXECUTE_CDP,
      withSessionMeta({
        tab_id: this.tabId,
        target: { tabId: this.tabId },
        method,
        commandParams: params,
      }),
      opts.timeout,
    );
  }
}
