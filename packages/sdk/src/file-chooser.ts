import { Guards } from "./guards.js";
import { withSessionMeta } from "./session-meta.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export class FileChooser {
  constructor(
    private readonly transport: Transport,
    public readonly id: string,
    private readonly guards = new Guards(),
    public readonly tabId?: string,
  ) {}

  async setFiles(paths: string | string[]): Promise<void> {
    const files = Array.isArray(paths) ? paths : [paths];
    const params = {
      ...(this.tabId ? { tab_id: this.tabId } : {}),
      file_chooser_id: this.id,
      paths: files,
    };
    const currentUrl = this.tabId && this.guards.needsCurrentUrl(M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }))
      : undefined;
    await this.guards.ensureCommandAllowed({
      command: M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
      ...params,
    }, { currentUrl });
    await this.transport.sendRequest(
      M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
      withSessionMeta(params),
    );
  }
}
