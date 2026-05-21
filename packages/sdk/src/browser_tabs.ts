import { Guards } from "./guards.js";
import { withSessionMeta } from "./session-meta.js";
import { Tab, type TabMetadata } from "./tab.js";
import { UserTabRef } from "./browser_user.js";
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
  active?: boolean;
  logicalActive?: boolean;
  logical_active?: boolean;
  windowId?: number;
  window_id?: number;
  groupId?: number;
  group_id?: number;
  pinned?: boolean;
  lastAccessed?: number;
  last_accessed?: number;
  lastUsedAt?: number;
  last_used_at?: number;
  tabGroupTitle?: string;
  tab_group_title?: string;
  tabGroup?: string;
  tab_group?: string;
  owned?: boolean;
  claimRequired?: boolean;
  claim_required?: boolean;
  commandable?: boolean;
};

export type CreateTabOptions = {
  url?: string;
};

export class BrowserTabs {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
  ) {}

  async list(opts: { timeout?: number } = {}): Promise<Tab[]> {
    const rows = await this.transport.sendRequest<TabWire[]>(M.GET_TABS, withSessionMeta({}), opts.timeout);
    return rows.map((row) => this.fromWire(row));
  }

  async current(opts: { timeout?: number } = {}): Promise<Tab | undefined> {
    const row = await this.transport.sendRequest<TabWire | null>(
      M.GET_CURRENT_TAB,
      withSessionMeta({}),
      opts.timeout,
    );
    if (!row) return undefined;
    return this.fromWire(row, "getCurrentTab response missing tab_id");
  }

  async selected(opts: { timeout?: number } = {}): Promise<Tab | UserTabRef | undefined> {
    await this.guards.ensureCommandAllowed({ command: M.GET_SELECTED_TAB });
    const row = await this.transport.sendRequest<TabWire | null>(
      M.GET_SELECTED_TAB,
      withSessionMeta({}),
      opts.timeout,
    );
    if (!row) return undefined;
    const id = row.tab_id ?? row.id;
    if (!id) throw new Error("getSelectedTab response missing tab_id");
    const metadata = tabMetadata(row);
    if (row.commandable === false || row.claimRequired === true || row.claim_required === true) {
      return new UserTabRef(this.transport, this.guards, id, metadata);
    }
    return new Tab(this.transport, this.guards, id, metadata);
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
  if (row.active !== undefined) metadata.active = row.active;
  if (row.logicalActive !== undefined) metadata.logicalActive = row.logicalActive;
  if (row.logical_active !== undefined) metadata.logicalActive = row.logical_active;
  if (row.windowId !== undefined) metadata.windowId = row.windowId;
  if (row.window_id !== undefined) metadata.windowId = row.window_id;
  if (row.groupId !== undefined) metadata.groupId = row.groupId;
  if (row.group_id !== undefined) metadata.groupId = row.group_id;
  if (row.pinned !== undefined) metadata.pinned = row.pinned;
  if (row.lastAccessed !== undefined) metadata.lastAccessed = row.lastAccessed;
  if (row.last_accessed !== undefined) metadata.lastAccessed = row.last_accessed;
  if (row.lastUsedAt !== undefined) metadata.lastUsedAt = row.lastUsedAt;
  if (row.last_used_at !== undefined) metadata.lastUsedAt = row.last_used_at;
  if (row.tabGroupTitle !== undefined) metadata.tabGroupTitle = row.tabGroupTitle;
  if (row.tab_group_title !== undefined) metadata.tabGroupTitle = row.tab_group_title;
  if (row.tabGroup !== undefined) metadata.tabGroup = row.tabGroup;
  if (row.tab_group !== undefined) metadata.tabGroup = row.tab_group;
  if (row.owned !== undefined) metadata.owned = row.owned;
  if (row.claimRequired !== undefined) metadata.claimRequired = row.claimRequired;
  if (row.claim_required !== undefined) metadata.claimRequired = row.claim_required;
  if (row.commandable !== undefined) metadata.commandable = row.commandable;
  return metadata;
}
