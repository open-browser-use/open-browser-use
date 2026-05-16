import { withSessionMeta } from "./session-meta.js";
import { Guards } from "./guards.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export type ClipboardPresentationStyle = "unspecified" | "inline" | "attachment";

export type ClipboardEntry = {
  mimeType: string;
  text?: string;
  base64?: string;
};

export type ClipboardItem = {
  entries: ClipboardEntry[];
  presentationStyle?: ClipboardPresentationStyle;
};

type WireClipboardEntry = {
  mime_type: string;
  text?: string;
  base64?: string;
};

type WireClipboardItem = {
  entries: WireClipboardEntry[];
  presentation_style?: ClipboardPresentationStyle;
};

export class TabClipboard {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    private readonly tabId: string,
  ) {}

  async readText(opts: { timeout?: number } = {}): Promise<string> {
    const params = { tab_id: this.tabId };
    await this.#ensureCommandAllowed(M.TAB_CLIPBOARD_READ_TEXT, params, opts.timeout);
    const row = await this.transport.sendRequest<{ text?: string }>(
      M.TAB_CLIPBOARD_READ_TEXT,
      withSessionMeta(params),
      opts.timeout,
    );
    return row.text ?? "";
  }

  async writeText(text: string, opts: { timeout?: number } = {}): Promise<void> {
    const params = { tab_id: this.tabId, text };
    await this.#ensureCommandAllowed(M.TAB_CLIPBOARD_WRITE_TEXT, params, opts.timeout);
    await this.transport.sendRequest(
      M.TAB_CLIPBOARD_WRITE_TEXT,
      withSessionMeta(params),
      opts.timeout,
    );
  }

  async read(opts: { timeout?: number } = {}): Promise<ClipboardItem[]> {
    const params = { tab_id: this.tabId };
    await this.#ensureCommandAllowed(M.TAB_CLIPBOARD_READ, params, opts.timeout);
    const row = await this.transport.sendRequest<{ items?: WireClipboardItem[] }>(
      M.TAB_CLIPBOARD_READ,
      withSessionMeta(params),
      opts.timeout,
    );
    return (row.items ?? []).map(fromWireItem);
  }

  async write(items: ClipboardItem[], opts: { timeout?: number } = {}): Promise<void> {
    const params = { tab_id: this.tabId, items: items.map(toWireItem) };
    await this.#ensureCommandAllowed(M.TAB_CLIPBOARD_WRITE, params, opts.timeout);
    await this.transport.sendRequest(
      M.TAB_CLIPBOARD_WRITE,
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

function fromWireItem(item: WireClipboardItem): ClipboardItem {
  const out: ClipboardItem = {
    entries: (item.entries ?? []).map((entry) => {
      const entryOut: ClipboardEntry = { mimeType: entry.mime_type };
      if (entry.text !== undefined) entryOut.text = entry.text;
      if (entry.base64 !== undefined) entryOut.base64 = entry.base64;
      return entryOut;
    }),
  };
  if (item.presentation_style !== undefined) out.presentationStyle = item.presentation_style;
  return out;
}

function toWireItem(item: ClipboardItem): WireClipboardItem {
  const out: WireClipboardItem = {
    entries: item.entries.map((entry) => {
      const entryOut: WireClipboardEntry = { mime_type: entry.mimeType };
      if (entry.text !== undefined) entryOut.text = entry.text;
      if (entry.base64 !== undefined) entryOut.base64 = entry.base64;
      return entryOut;
    }),
  };
  if (item.presentationStyle !== undefined) out.presentation_style = item.presentationStyle;
  return out;
}
