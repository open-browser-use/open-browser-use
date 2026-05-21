import { Guards } from "./guards.js";
import { ERR_NOT_IMPLEMENTED, ObuError } from "./errors.js";
import { Tab, type TabMetadata } from "./tab.js";
import { tabFromWire, tabIdFromWire, tabMetadata, type TabWire } from "./tab_wire.js";
import { withSessionMeta } from "./session-meta.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

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
    const id = tabIdFromWire(row, `${method} response missing tab_id`);
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

function normalizeClaimTabId(tabId: string | number | UserTabRef | { id: string | number }): string {
  if (typeof tabId === "string" || typeof tabId === "number") return String(tabId);
  return String(tabId.id);
}
