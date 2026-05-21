import { BrowserTabs } from "./browser_tabs.js";
import { BrowserUser } from "./browser_user.js";
import { Guards } from "./guards.js";
import { withSessionMeta } from "./session-meta.js";
import { Tab } from "./tab.js";
import { tabIdFromWire, tabMetadata, type TabWire } from "./tab_wire.js";
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

export type BrowserFinalizeDesiredStatus = "close" | "release" | "handoff" | "deliverable";

export type BrowserFinalizeTabOutcome =
  | "closed"
  | "released"
  | "kept_handoff"
  | "kept_deliverable"
  | "tab_gone"
  | "failed"
  | "not_attempted";

export type BrowserFinalizeTabAction = {
  tabId?: number;
  tab_id?: string;
  origin?: "agent" | "user";
  desiredStatus?: BrowserFinalizeDesiredStatus;
  desired_status?: BrowserFinalizeDesiredStatus;
  outcome: BrowserFinalizeTabOutcome;
  errorCode?: string;
  error_code?: string;
  errorMessage?: string;
  error_message?: string;
};

export type BrowserFinalizeTabFailure = {
  tabId?: number;
  tab_id?: string;
  desiredStatus?: BrowserFinalizeDesiredStatus;
  desired_status?: BrowserFinalizeDesiredStatus;
  outcome: Extract<BrowserFinalizeTabOutcome, "failed" | "not_attempted">;
  errorCode?: string;
  error_code?: string;
  errorMessage?: string;
  error_message?: string;
};

export type BrowserFinalizeFinalTabs = {
  handoff?: BrowserFinalizeTab[];
  deliverable?: BrowserFinalizeTab[];
  activeTabId?: number | null;
  active_tab_id?: string | null;
};

export type BrowserFinalizeTabsResult = {
  status?: "ok" | "partial" | "fatal";
  actions?: BrowserFinalizeTabAction[];
  closed_tab_ids?: string[];
  closedTabIds?: number[];
  released_tab_ids?: string[];
  releasedTabIds?: number[];
  kept_tabs?: BrowserFinalizeTab[];
  keptTabs?: BrowserFinalizeTab[];
  deliverable_tabs?: BrowserFinalizeTab[];
  deliverableTabs?: BrowserFinalizeTab[];
  finalTabs?: BrowserFinalizeFinalTabs | null;
  final_tabs?: BrowserFinalizeFinalTabs | null;
  failures?: BrowserFinalizeTabFailure[];
  diagnostics?: {
    reconciledFromChrome?: boolean;
    reconciled_from_chrome?: boolean;
    reconciliationSource?: string;
    reconciliation_source?: string;
  };
  errorCode?: string;
  error_code?: string;
  errorMessage?: string;
  error_message?: string;
};

export type BrowserFinishTurnOptions = BrowserFinalizeTabsOptions & {
  turnTimeout?: number;
};

export type BrowserReadySummary = {
  type: string;
  name: string;
  backend: DiscoveredBackend;
  capabilities: Record<string, unknown>;
  profileMetadata: BrowserProfileMetadata;
  supportedMethods: readonly string[];
  unsupportedMethods: readonly string[];
  diagnostics: Record<string, unknown>;
};

export type BrowserProfileMetadata = {
  profileIdHash?: string;
  profileIsLastUsed?: boolean;
  profileOrdering?: number;
  profileRuntimeBinding?: "webextension" | "cdp" | "unknown";
  diagnostics?: {
    profilePathRedacted?: string;
  };
};

export type BrowserCapabilityName = "viewport" | "visibility" | string;

export type BrowserCapabilityEntry = {
  name: BrowserCapabilityName;
  raw: unknown;
  supported: boolean;
  instance?: BrowserViewport | BrowserVisibility;
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

export type BrowserViewportSetOptions = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  timeout?: number;
};

export type BrowserViewportResult = {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  tabId?: number;
  tab_id?: string;
  reset?: boolean;
};

export type BrowserVisibilitySetOptions = {
  visible: boolean;
  focused?: boolean;
  timeout?: number;
};

export type BrowserVisibilityResult = {
  visible: boolean;
  focused?: boolean;
  windowId?: number;
  window_id?: number;
  state?: string;
};

type BrowserControlTabWire = TabWire;

export class Browser {
  readonly metadata: Record<string, unknown>;
  readonly profileMetadata: BrowserProfileMetadata;
  readonly diagnostics: Record<string, unknown>;
  readonly lifecycleDiagnostics: Record<string, unknown>;
  readonly capabilities: Record<string, unknown>;
  readonly supportedMethods: readonly string[];
  readonly unsupportedMethods: readonly string[];
  readonly guards: Guards;
  readonly tabs: BrowserTabs;
  readonly user: BrowserUser;
  readonly capabilityRegistry: BrowserCapabilityRegistry;
  readonly viewport?: BrowserViewport;
  readonly visibility?: BrowserVisibility;

  constructor(
    private readonly transport: Transport,
    public readonly info: BrowserInfo,
    public readonly backend: DiscoveredBackend,
    guards = new Guards(),
  ) {
    this.metadata = info.metadata ?? {};
    this.profileMetadata = profileMetadataFrom(this.metadata);
    this.diagnostics = recordOrEmpty(this.metadata.diagnostics);
    this.lifecycleDiagnostics = recordOrEmpty(this.diagnostics.lifecycle);
    this.capabilities = info.capabilities ?? {};
    this.supportedMethods = stringList(this.capabilities.supported_methods);
    this.unsupportedMethods = stringList(this.capabilities.unsupported_methods);
    this.guards = guards;
    this.tabs = new BrowserTabs(transport, guards);
    this.user = new BrowserUser(transport, guards, (method) => this.supports(method), info.type);
    this.capabilityRegistry = new BrowserCapabilityRegistry(this.capabilities);
    if (capabilityAdvertised(this.capabilities, "viewport") && this.supports(M.BROWSER_VIEWPORT_SET)) {
      this.viewport = new BrowserViewport(transport);
      this.capabilityRegistry.register("viewport", this.viewport);
    }
    if (capabilityAdvertised(this.capabilities, "visibility") && this.supports(M.BROWSER_VISIBILITY_GET)) {
      this.visibility = new BrowserVisibility(transport);
      this.capabilityRegistry.register("visibility", this.visibility);
    }
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

  async yieldControl(opts: { timeout?: number } = {}): Promise<void> {
    await this.transport.sendRequest(M.YIELD_CONTROL, withSessionMeta({}), opts.timeout);
  }

  async resumeControl(opts: { timeout?: number } = {}): Promise<Tab | undefined> {
    const response = await this.transport.sendRequest<{ tab?: BrowserControlTabWire | null } | BrowserControlTabWire | null>(
      M.RESUME_CONTROL,
      withSessionMeta({}),
      opts.timeout,
    );
    const row = unwrapBrowserControlTab(response);
    if (!row) return undefined;
    const id = tabIdFromWire(row, "resumeControl response missing tab_id");
    return new Tab(this.transport, this.guards, id, tabMetadata(row));
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
      profileMetadata: profileMetadataFrom(recordOrEmpty(metadata)),
      supportedMethods: stringList(capabilities.supported_methods),
      unsupportedMethods: stringList(capabilities.unsupported_methods),
      diagnostics,
    };
  }

  async deliverables(opts: { timeout?: number } = {}): Promise<BrowserDeliverable[]> {
    const listOpts: { timeout?: number } = {};
    if (opts.timeout !== undefined) listOpts.timeout = opts.timeout;
    await this.tabs.list(listOpts);
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

export class BrowserCapabilityRegistry {
  private readonly instances = new Map<string, BrowserViewport | BrowserVisibility>();

  constructor(readonly raw: Record<string, unknown>) {}

  register(name: string, instance: BrowserViewport | BrowserVisibility): void {
    this.instances.set(name, instance);
  }

  list(): BrowserCapabilityEntry[] {
    return Object.keys(this.raw)
      .filter((name) => !["supported_methods", "unsupported_methods", "backend"].includes(name))
      .sort()
      .map((name) => {
        const entry: BrowserCapabilityEntry = {
          name,
          raw: this.raw[name],
          supported: capabilityAdvertised(this.raw, name),
        };
        const instance = this.instances.get(name);
        return instance ? { ...entry, instance } : entry;
      });
  }

  has(name: string): boolean {
    return capabilityAdvertised(this.raw, name);
  }

  get(name: "viewport"): BrowserViewport;
  get(name: "visibility"): BrowserVisibility;
  get(name: string): BrowserCapabilityEntry;
  get(name: string): BrowserCapabilityEntry | BrowserViewport | BrowserVisibility {
    const instance = this.instances.get(name);
    if (instance) return instance;
    if (Object.prototype.hasOwnProperty.call(this.raw, name)) {
      return { name, raw: this.raw[name], supported: capabilityAdvertised(this.raw, name) };
    }
    throw new Error(`unsupported browser capability: ${name}`);
  }
}

export class BrowserViewport {
  constructor(private readonly transport: Transport) {}

  async set(opts: BrowserViewportSetOptions): Promise<BrowserViewportResult> {
    assertIntegerInRange(opts.width, "width", 1, 16_384);
    assertIntegerInRange(opts.height, "height", 1, 16_384);
    if (opts.deviceScaleFactor !== undefined) {
      assertNumberInRange(opts.deviceScaleFactor, "deviceScaleFactor", 0.1, 8);
    }
    return await this.transport.sendRequest<BrowserViewportResult>(
      M.BROWSER_VIEWPORT_SET,
      withSessionMeta({
        width: opts.width,
        height: opts.height,
        ...(opts.deviceScaleFactor !== undefined ? { deviceScaleFactor: opts.deviceScaleFactor } : {}),
        ...(opts.mobile !== undefined ? { mobile: opts.mobile } : {}),
      }),
      opts.timeout,
    );
  }

  async reset(opts: { timeout?: number } = {}): Promise<BrowserViewportResult> {
    return await this.transport.sendRequest<BrowserViewportResult>(
      M.BROWSER_VIEWPORT_RESET,
      withSessionMeta({}),
      opts.timeout,
    );
  }
}

export class BrowserVisibility {
  constructor(private readonly transport: Transport) {}

  async set(opts: BrowserVisibilitySetOptions): Promise<BrowserVisibilityResult> {
    if (typeof opts.visible !== "boolean") throw new Error("visible must be a boolean");
    if (opts.focused !== undefined && typeof opts.focused !== "boolean") {
      throw new Error("focused must be a boolean");
    }
    return await this.transport.sendRequest<BrowserVisibilityResult>(
      M.BROWSER_VISIBILITY_SET,
      withSessionMeta({
        visible: opts.visible,
        ...(opts.focused !== undefined ? { focused: opts.focused } : {}),
      }),
      opts.timeout,
    );
  }

  async get(opts: { timeout?: number } = {}): Promise<BrowserVisibilityResult> {
    return await this.transport.sendRequest<BrowserVisibilityResult>(
      M.BROWSER_VISIBILITY_GET,
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

function profileMetadataFrom(metadata: Record<string, unknown>): BrowserProfileMetadata {
  const diagnostics = recordOrEmpty(metadata.diagnostics);
  const profile: BrowserProfileMetadata = {};
  if (typeof metadata.profileIdHash === "string") profile.profileIdHash = metadata.profileIdHash;
  if (typeof metadata.profileIsLastUsed === "boolean") profile.profileIsLastUsed = metadata.profileIsLastUsed;
  if (typeof metadata.profileOrdering === "number" && Number.isFinite(metadata.profileOrdering)) {
    profile.profileOrdering = metadata.profileOrdering;
  }
  if (
    metadata.profileRuntimeBinding === "webextension" ||
    metadata.profileRuntimeBinding === "cdp" ||
    metadata.profileRuntimeBinding === "unknown"
  ) {
    profile.profileRuntimeBinding = metadata.profileRuntimeBinding;
  }
  if (typeof diagnostics.profilePathRedacted === "string") {
    profile.diagnostics = { profilePathRedacted: diagnostics.profilePathRedacted };
  }
  return profile;
}

function capabilityAdvertised(capabilities: Record<string, unknown>, key: string): boolean {
  const value = capabilities[key];
  if (value === true) return true;
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertIntegerInRange(value: number, key: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
}

function assertNumberInRange(value: number, key: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
}

function unwrapBrowserControlTab(
  response: { tab?: BrowserControlTabWire | null } | BrowserControlTabWire | null,
): BrowserControlTabWire | null | undefined {
  if (!response) return response;
  if (Object.prototype.hasOwnProperty.call(response, "tab")) {
    return (response as { tab?: BrowserControlTabWire | null }).tab;
  }
  return response as BrowserControlTabWire;
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
