import { Guards } from "./guards.js";
import { ERR_NOT_IMPLEMENTED, ObuError } from "./errors.js";
import { Tab, type TabMetadata } from "./tab.js";
import { withSessionMeta } from "./session-meta.js";
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

export type BrowserHistoryQuery = {
  query?: string;
  limit?: number;
  from?: number;
  to?: number;
};

export type BrowserHistoryItem = {
  id?: string;
  url: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
  typedCount?: number;
};

export class UserTabRef {
  readonly metadata: TabMetadata;
  readonly tab_id: string;
  readonly tabId: string;

  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    public readonly id: string,
    metadata: TabMetadata = {},
  ) {
    this.tab_id = id;
    this.tabId = id;
    this.metadata = {
      ...metadata,
      commandable: false,
      claimRequired: metadata.claimRequired ?? true,
    };
  }

  async claim(opts: { timeout?: number } = {}): Promise<Tab> {
    await this.guards.ensureCommandAllowed({ command: M.CLAIM_USER_TAB, tab_id: this.id });
    const row = await this.transport.sendRequest<TabWire>(
      M.CLAIM_USER_TAB,
      withSessionMeta({ tab_id: this.id }),
      opts.timeout,
    );
    return tabFromWire(this.transport, this.guards, row, "claimUserTab");
  }
}

export class BrowserUser {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    private readonly supportsMethod: (method: string) => boolean = () => true,
    private readonly backendType?: string,
  ) {}

  async discoverTabs(): Promise<UserTabRef[]> {
    await this.guards.ensureCommandAllowed({ command: M.GET_USER_TABS });
    const rows = await this.transport.sendRequest<TabWire[]>(M.GET_USER_TABS, withSessionMeta({}));
    return rows.map((row) => this.#userTabRefFromWire(row, "getUserTabs"));
  }

  /** @deprecated Use discoverTabs(), then claim the returned UserTabRef explicitly. */
  async openTabs(): Promise<Tab[]> {
    await this.guards.ensureCommandAllowed({ command: M.GET_USER_TABS });
    const rows = await this.transport.sendRequest<TabWire[]>(M.GET_USER_TABS, withSessionMeta({}));
    return rows.map((row) => tabFromWire(this.transport, this.guards, row, "getUserTabs"));
  }

  async history(query: BrowserHistoryQuery = {}): Promise<BrowserHistoryItem[]> {
    if (!this.supportsMethod(M.GET_USER_HISTORY)) {
      throw new ObuError(
        ERR_NOT_IMPLEMENTED,
        "backend does not support browser profile history",
        unsupportedBackendCapabilityData(this.backendType, M.GET_USER_HISTORY),
      );
    }
    await this.guards.ensureCommandAllowed({
      command: M.GET_USER_HISTORY,
      query: query.query,
      limit: query.limit,
      from: query.from,
      to: query.to,
    });
    return await this.transport.sendRequest<BrowserHistoryItem[]>(
      M.GET_USER_HISTORY,
      withSessionMeta({
        query: query.query,
        limit: query.limit,
        from: query.from,
        to: query.to,
      }),
    );
  }

  async claimTab(tabId: string | number | UserTabRef | { id: string | number }): Promise<Tab> {
    const id = normalizeClaimTabId(tabId);
    await this.guards.ensureCommandAllowed({ command: M.CLAIM_USER_TAB, tab_id: id });
    const row = await this.transport.sendRequest<TabWire>(
      M.CLAIM_USER_TAB,
      withSessionMeta({ tab_id: id }),
    );
    return tabFromWire(this.transport, this.guards, row, "claimUserTab");
  }

  #userTabRefFromWire(row: TabWire, method: string): UserTabRef {
    const id = row.tab_id ?? row.id;
    if (!id) throw new Error(`${method} response missing tab_id`);
    return new UserTabRef(this.transport, this.guards, id, tabMetadata(row));
  }
}

function unsupportedBackendCapabilityData(backend: string | undefined, method: string): Record<string, unknown> {
  return {
    code: "unsupported_backend_capability",
    ...(backend ? { backend } : {}),
    method,
    missing_capability: `method:${method}`,
  };
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

function tabFromWire(transport: Transport, guards: Guards, row: TabWire, method: string): Tab {
  const id = row.tab_id ?? row.id;
  if (!id) throw new Error(`${method} response missing tab_id`);
  return new Tab(transport, guards, id, tabMetadata(row));
}

function normalizeClaimTabId(tabId: string | number | UserTabRef | { id: string | number }): string {
  if (typeof tabId === "string" || typeof tabId === "number") return String(tabId);
  return String(tabId.id);
}
