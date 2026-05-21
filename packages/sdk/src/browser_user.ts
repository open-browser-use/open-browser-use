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

export class BrowserUser {
  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    private readonly supportsMethod: (method: string) => boolean = () => true,
    private readonly backendType?: string,
  ) {}

  async openTabs(): Promise<Tab[]> {
    await this.guards.ensureCommandAllowed({ command: M.GET_USER_TABS });
    const rows = await this.transport.sendRequest<TabWire[]>(M.GET_USER_TABS, withSessionMeta({}));
    return rows.map((row) => this.#tabFromWire(row, "getUserTabs"));
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

  async claimTab(tabId: string | number): Promise<Tab> {
    await this.guards.ensureCommandAllowed({ command: M.CLAIM_USER_TAB, tab_id: String(tabId) });
    const row = await this.transport.sendRequest<TabWire>(
      M.CLAIM_USER_TAB,
      withSessionMeta({ tab_id: String(tabId) }),
    );
    return this.#tabFromWire(row, "claimUserTab");
  }

  #tabFromWire(row: TabWire, method: string): Tab {
    const id = row.tab_id ?? row.id;
    if (!id) throw new Error(`${method} response missing tab_id`);
    return new Tab(this.transport, this.guards, id, tabMetadata(row));
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
  return metadata;
}
