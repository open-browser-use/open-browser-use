import { Guards } from "./guards.js";
import { withSessionMeta } from "./session-meta.js";
import { Tab, type TabMetadata } from "./tab.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

type TabWire = {
  tab_id?: string;
  id?: string;
  target_id?: string;
  url?: string;
  title?: string;
  origin?: "agent" | "user";
  status?: "active" | "handoff" | "deliverable";
};

export type CreateTabOptions = {
  url?: string;
};

export class BrowserTabs {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
  ) {}

  async list(): Promise<Tab[]> {
    const rows = await this.transport.sendRequest<TabWire[]>(M.GET_TABS, withSessionMeta({}));
    return rows.map((row) => this.fromWire(row));
  }

  async create(urlOrOptions?: string | CreateTabOptions): Promise<Tab> {
    const url = normalizeCreateUrl(urlOrOptions);
    const params: Record<string, unknown> = { url };
    await this.guards.ensureCommandAllowed({ command: M.CREATE_TAB, ...params });
    const row = await this.transport.sendRequest<TabWire>(M.CREATE_TAB, withSessionMeta(params));
    return this.fromWire(row, "createTab response missing tab_id");
  }

  get(tabId: string): Tab {
    return new Tab(this.transport, this.guards, tabId);
  }

  private fromWire(row: TabWire, missingIdMessage = "getTabs response missing tab_id"): Tab {
    const id = row.tab_id ?? row.id;
    if (!id) throw new Error(missingIdMessage);
    return new Tab(this.transport, this.guards, id, tabMetadata(row));
  }
}

function normalizeCreateUrl(urlOrOptions: string | CreateTabOptions | undefined): string {
  if (urlOrOptions === undefined) return "about:blank";
  if (typeof urlOrOptions === "string") return urlOrOptions;
  if (typeof urlOrOptions === "object" && urlOrOptions !== null && !Array.isArray(urlOrOptions)) {
    if (urlOrOptions.url === undefined) return "about:blank";
    if (typeof urlOrOptions.url === "string") return urlOrOptions.url;
  }
  throw new TypeError("browser.tabs.create expected a URL string or { url: string }");
}

function tabMetadata(row: TabWire): TabMetadata {
  const metadata: TabMetadata = {};
  if (row.target_id !== undefined) metadata.target_id = row.target_id;
  if (row.url !== undefined) metadata.url = row.url;
  if (row.title !== undefined) metadata.title = row.title;
  if (row.origin !== undefined) metadata.origin = row.origin;
  if (row.status !== undefined) metadata.status = row.status;
  return metadata;
}
