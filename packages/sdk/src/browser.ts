import { BrowserTabs } from "./browser_tabs.js";
import { BrowserUser } from "./browser_user.js";
import { Guards } from "./guards.js";
import { withSessionMeta } from "./session-meta.js";
import type { Tab } from "./tab.js";
import type { DiscoveredBackend } from "./browsers.js";
import type { BrowserInfo } from "./types.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export type BrowserFinalizeStatus = "handoff" | "deliverable";

export type BrowserFinalizeKeep = {
  tab?: string | number | { id: string | number };
  tab_id?: string | number;
  tabId?: string | number;
  id?: string | number;
  status: BrowserFinalizeStatus;
};

export type BrowserFinalizeTabsOptions = {
  keep?: BrowserFinalizeKeep[];
  timeout?: number;
};

export type BrowserFinalizeTab = {
  id?: string;
  tab_id?: string;
  target_id?: string;
  url?: string;
  title?: string;
  origin?: "agent" | "user";
  status?: "active" | BrowserFinalizeStatus;
};

export type BrowserFinalizeTabsResult = {
  closed_tab_ids?: string[];
  released_tab_ids?: string[];
  kept_tabs?: BrowserFinalizeTab[];
  deliverable_tabs?: BrowserFinalizeTab[];
};

export type BrowserFinishTurnOptions = BrowserFinalizeTabsOptions & {
  turnTimeout?: number;
};

export type BrowserReadySummary = {
  type: string;
  name: string;
  backend: DiscoveredBackend;
  capabilities: Record<string, unknown>;
  supportedMethods: readonly string[];
  unsupportedMethods: readonly string[];
  diagnostics: Record<string, unknown>;
};

export type BrowserDeliverable = {
  tabId: string;
  tab_id: string;
  sessionId?: string;
  session_id?: string;
  url?: string;
  title?: string;
  claim(): Promise<Tab>;
};

export type BrowserClearLifecycleDiagnosticsResult = {
  cleared?: {
    stale_sessions?: number;
    stale_tabs?: number;
    stale_file_choosers?: number;
    stale_downloads?: number;
  };
  diagnostics?: {
    lifecycle?: Record<string, unknown>;
  };
};

export class Browser {
  readonly metadata: Record<string, unknown>;
  readonly diagnostics: Record<string, unknown>;
  readonly lifecycleDiagnostics: Record<string, unknown>;
  readonly capabilities: Record<string, unknown>;
  readonly supportedMethods: readonly string[];
  readonly unsupportedMethods: readonly string[];
  readonly guards: Guards;
  readonly tabs: BrowserTabs;
  readonly user: BrowserUser;

  constructor(
    private readonly transport: Transport,
    public readonly info: BrowserInfo,
    public readonly backend: DiscoveredBackend,
    guards = new Guards(),
  ) {
    this.metadata = info.metadata ?? {};
    this.diagnostics = recordOrEmpty(this.metadata.diagnostics);
    this.lifecycleDiagnostics = recordOrEmpty(this.diagnostics.lifecycle);
    this.capabilities = info.capabilities ?? {};
    this.supportedMethods = stringList(this.capabilities.supported_methods);
    this.unsupportedMethods = stringList(this.capabilities.unsupported_methods);
    this.guards = guards;
    this.tabs = new BrowserTabs(transport, guards);
    this.user = new BrowserUser(transport, guards, (method) => this.supports(method));
  }

  supports(method: string): boolean {
    if (this.unsupportedMethods.includes(method)) return false;
    if (this.supportedMethods.length > 0) return this.supportedMethods.includes(method);
    return true;
  }

  async name(label: string): Promise<void> {
    await this.transport.sendRequest(M.NAME_SESSION, withSessionMeta({ label }));
  }

  async turnEnded(opts: { timeout?: number } = {}): Promise<void> {
    await this.transport.sendRequest(M.TURN_ENDED, withSessionMeta({}), opts.timeout);
  }

  async finalizeTabs(opts: BrowserFinalizeTabsOptions = {}): Promise<BrowserFinalizeTabsResult> {
    return await this.transport.sendRequest<BrowserFinalizeTabsResult>(
      M.FINALIZE_TABS,
      withSessionMeta({
        keep: (opts.keep ?? []).map((row) => ({
          tab_id: normalizeFinalizeTabId(row),
          status: row.status,
        })),
      }),
      opts.timeout,
    );
  }

  async finalize(opts: BrowserFinalizeTabsOptions = {}): Promise<BrowserFinalizeTabsResult> {
    return await this.finalizeTabs(opts);
  }

  async finishTurn(opts: BrowserFinishTurnOptions = {}): Promise<BrowserFinalizeTabsResult> {
    const finalizeOpts: BrowserFinalizeTabsOptions = {};
    if (opts.keep !== undefined) finalizeOpts.keep = opts.keep;
    if (opts.timeout !== undefined) finalizeOpts.timeout = opts.timeout;
    const result = await this.finalizeTabs(finalizeOpts);
    const turnOpts: { timeout?: number } = {};
    const turnTimeout = opts.turnTimeout ?? opts.timeout;
    if (turnTimeout !== undefined) turnOpts.timeout = turnTimeout;
    await this.turnEnded(turnOpts);
    return result;
  }

  async ensureReady(opts: { timeout?: number } = {}): Promise<BrowserReadySummary> {
    const info = await this.transport.sendRequest<BrowserInfo>(M.GET_INFO, {}, opts.timeout);
    const capabilities = info.capabilities ?? {};
    const metadata = info.metadata ?? {};
    const diagnostics = recordOrEmpty(recordOrEmpty(metadata).diagnostics);
    return {
      type: info.type,
      name: info.name,
      backend: this.backend,
      capabilities,
      supportedMethods: stringList(capabilities.supported_methods),
      unsupportedMethods: stringList(capabilities.unsupported_methods),
      diagnostics,
    };
  }

  async deliverables(opts: { timeout?: number } = {}): Promise<BrowserDeliverable[]> {
    await this.tabs.list();
    const info = await this.transport.sendRequest<BrowserInfo>(M.GET_INFO, {}, opts.timeout);
    return deliverableSummaries(info).map((row) => {
      const deliverable: BrowserDeliverable = {
        tabId: row.tabId,
        tab_id: row.tabId,
        claim: () => this.user.claimTab(row.tabId),
      };
      if (row.sessionId !== undefined) {
        deliverable.sessionId = row.sessionId;
        deliverable.session_id = row.sessionId;
      }
      if (row.url !== undefined) deliverable.url = row.url;
      if (row.title !== undefined) deliverable.title = row.title;
      return deliverable;
    });
  }

  async clearLifecycleDiagnostics(
    opts: { timeout?: number } = {},
  ): Promise<BrowserClearLifecycleDiagnosticsResult> {
    return await this.transport.sendRequest<BrowserClearLifecycleDiagnosticsResult>(
      M.CLEAR_LIFECYCLE_DIAGNOSTICS,
      withSessionMeta({}),
      opts.timeout,
    );
  }
}

function normalizeFinalizeTabId(row: BrowserFinalizeKeep): string {
  const value = row.tab ?? row.tab_id ?? row.tabId ?? row.id;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && ("id" in value)) return String(value.id);
  throw new Error("finalizeTabs keep entry missing tab id");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function deliverableSummaries(info: BrowserInfo): Array<{
  tabId: string;
  sessionId?: string;
  url?: string;
  title?: string;
}> {
  const metadata = recordOrEmpty(info.metadata);
  const diagnostics = recordOrEmpty(metadata.diagnostics);
  const lifecycle = recordOrEmpty(diagnostics.lifecycle);
  const rows = lifecycle.deliverable_tab_summaries;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const record = row as Record<string, unknown>;
    const tabId = record.tab_id ?? record.tabId;
    if (typeof tabId !== "string" || tabId.length === 0) return [];
    const sessionId = record.session_id ?? record.sessionId;
    const url = record.url;
    const title = record.title;
    const summary: {
      tabId: string;
      sessionId?: string;
      url?: string;
      title?: string;
    } = { tabId };
    if (typeof sessionId === "string") summary.sessionId = sessionId;
    if (typeof url === "string") summary.url = url;
    if (typeof title === "string") summary.title = title;
    return [summary];
  });
}
