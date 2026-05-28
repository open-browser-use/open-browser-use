import { BrowserTabs } from "./browser_tabs.js";
import { BrowserTasks } from "./browser-tasks.js";
import { BrowserUser } from "./browser_user.js";
import { Guards } from "./guards.js";
import { withSessionMeta } from "./session-meta.js";
import { Tab, markTabRuntimeContextStale, type TabRuntimeContext } from "./tab.js";
import { tabIdFromWire, tabMetadata, type TabWire } from "./tab_wire.js";
import type { DiscoveredBackend } from "./browsers.js";
import type { BrowserInfo } from "./types.js";
import type { Transport, TransportDiagnostics } from "./wire/transport.js";
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
  tabId: string;
  origin: "agent" | "user";
  desiredStatus: BrowserFinalizeDesiredStatus;
  outcome: BrowserFinalizeTabOutcome;
  errorCode?: string;
  errorMessage?: string;
};

export type BrowserFinalizeTabFailure = {
  tabId?: string;
  desiredStatus?: BrowserFinalizeDesiredStatus;
  outcome: Extract<BrowserFinalizeTabOutcome, "failed" | "not_attempted">;
  errorCode: string;
  errorMessage: string;
};

export type BrowserFinalizeFinalTabs = {
  handoff: BrowserFinalizeTab[];
  deliverable: BrowserFinalizeTab[];
  activeTabId: string | null;
};

export type BrowserFinalizeTabsResult = BrowserFinalizeTabsSuccessResult | BrowserFinalizeTabsFatalResult;

export type BrowserFinalizeTabsSuccessResult = {
  status: "ok" | "partial";
  actions: BrowserFinalizeTabAction[];
  closedTabIds: string[];
  releasedTabIds: string[];
  keptTabs: BrowserFinalizeTab[];
  deliverableTabs: BrowserFinalizeTab[];
  finalTabs: BrowserFinalizeFinalTabs;
  failures: BrowserFinalizeTabFailure[];
  diagnostics: {
    reconciledFromChrome: true;
    reconciliationSource: "chrome.tabs";
  };
};

export type BrowserFinalizeTabsFatalResult = {
  status: "fatal";
  actions: BrowserFinalizeTabAction[];
  closedTabIds: string[];
  releasedTabIds: string[];
  keptTabs: BrowserFinalizeTab[];
  deliverableTabs: BrowserFinalizeTab[];
  finalTabs: null;
  failures: BrowserFinalizeTabFailure[];
  errorCode: string;
  errorMessage: string;
  diagnostics: {
    reconciledFromChrome: false;
    reconciliationSource?: "chrome.tabs";
  };
};

type BrowserFinalizeTabsWireResult = Record<string, unknown>;

export type BrowserFinishTurnOptions = BrowserFinalizeTabsOptions & {
  turnTimeout?: number;
  endTurnOnPartial?: boolean;
};

export type BrowserFinishTurnResult = BrowserFinalizeTabsResult & {
  turnEnded: boolean;
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

export type BrowserResumeControlRepair = {
  status: "repair_required" | "blocked";
  reason?: string;
  nextActiveTabId?: string | number;
  diagnostics: unknown[];
  cleanup: unknown[];
};

export type BrowserResumeControlResult =
  | { status: "resumed"; tab: Tab; repair?: BrowserResumeControlRepair }
  | { status: "blocked"; tab?: undefined; repair: BrowserResumeControlRepair };

type BrowserControlTabWire = TabWire;
type BrowserControlWire = { tab?: BrowserControlTabWire | null; repair?: unknown } | BrowserControlTabWire | null;

export class Browser {
  readonly metadata: Record<string, unknown>;
  readonly profileMetadata: BrowserProfileMetadata;
  readonly diagnostics: Record<string, unknown>;
  readonly lifecycleDiagnostics: Record<string, unknown>;
  readonly capabilities: Record<string, unknown>;
  readonly supportedMethods: readonly string[];
  readonly unsupportedMethods: readonly string[];
  private readonly tabRuntimeContext: TabRuntimeContext;
  readonly guards: Guards;
  readonly tabs: BrowserTabs;
  readonly tasks: BrowserTasks;
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
    this.tabRuntimeContext = {
      supportedMethods: this.supportedMethods,
      unsupportedMethods: this.unsupportedMethods,
      diagnostics: this.diagnostics,
      pointerStore: new Map(),
      observationStore: new Map(),
      lifecycleEpoch: { value: 0, updatedAt: Date.now() },
    };
    // A transparent reconnect means the host process restarted (fresh registry), so any
    // cached tab ownership / observations are stale. Bump the lifecycle epoch so observe()
    // reports ownership "lost" and step() rejects stale observations — the same signal the
    // SDK already raises for yield/resume/finalize.
    this.transport.onReconnect?.(() => markTabRuntimeContextStale(this.tabRuntimeContext, "host_restart"));
    this.guards = guards;
    this.tabs = new BrowserTabs(transport, guards, this.tabRuntimeContext);
    this.tasks = new BrowserTasks(transport, (opts) => this.resumeControlResult(opts));
    this.user = new BrowserUser(transport, guards, (method) => this.supports(method), info.type, this.tabRuntimeContext);
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
    markTabRuntimeContextStale(this.tabRuntimeContext, "human_takeover");
  }

  async resumeControl(opts: { timeout?: number } = {}): Promise<Tab | undefined> {
    const result = await this.resumeControlResult(opts);
    return result.status === "resumed" ? result.tab : undefined;
  }

  async resumeControlResult(opts: { timeout?: number } = {}): Promise<BrowserResumeControlResult> {
    const response = await this.transport.sendRequest<BrowserControlWire>(
      M.RESUME_CONTROL,
      withSessionMeta({}),
      opts.timeout,
    );
    markTabRuntimeContextStale(this.tabRuntimeContext, "resume_control_revalidation_required");
    const row = unwrapBrowserControlTab(response);
    const repair = unwrapBrowserControlRepair(response);
    if (!row) {
      return { status: "blocked", repair: normalizeBrowserControlRepair(repair, "blocked") };
    }
    const id = tabIdFromWire(row, "resumeControl response missing tab_id");
    const result: BrowserResumeControlResult = {
      status: "resumed",
      tab: new Tab(this.transport, this.guards, id, tabMetadata(row), this.tabRuntimeContext),
    };
    if (repair !== undefined) {
      result.repair = normalizeBrowserControlRepair(repair, "repair_required");
    }
    return result;
  }

  async finalizeTabs(opts: BrowserFinalizeTabsOptions = {}): Promise<BrowserFinalizeTabsResult> {
    const response = await this.transport.sendRequest<BrowserFinalizeTabsWireResult>(
      M.FINALIZE_TABS,
      withSessionMeta({
        keep: (opts.keep ?? []).map((row) => ({
          tab_id: normalizeFinalizeTabId(row),
          status: row.status,
        })),
      }),
      opts.timeout,
    );
    const result = normalizeFinalizeTabsResult(response);
    markTabRuntimeContextStale(this.tabRuntimeContext, "finalize_tabs");
    return result;
  }

  async finalize(opts: BrowserFinalizeTabsOptions = {}): Promise<BrowserFinalizeTabsResult> {
    return await this.finalizeTabs(opts);
  }

  async finishTurn(opts: BrowserFinishTurnOptions = {}): Promise<BrowserFinishTurnResult> {
    const finalizeOpts: BrowserFinalizeTabsOptions = {};
    if (opts.keep !== undefined) finalizeOpts.keep = opts.keep;
    if (opts.timeout !== undefined) finalizeOpts.timeout = opts.timeout;
    const result = await this.finalizeTabs(finalizeOpts);
    if (!shouldEndTurnAfterFinalize(result, opts)) {
      return { ...result, turnEnded: false };
    }
    const turnOpts: { timeout?: number } = {};
    const turnTimeout = opts.turnTimeout ?? opts.timeout;
    if (turnTimeout !== undefined) turnOpts.timeout = turnTimeout;
    await this.turnEnded(turnOpts);
    return { ...result, turnEnded: true };
  }

  async ensureReady(opts: { timeout?: number } = {}): Promise<BrowserReadySummary> {
    const info = await this.transport.sendRequest<BrowserInfo>(M.GET_INFO, {}, opts.timeout);
    const capabilities = info.capabilities ?? {};
    const metadata = info.metadata ?? {};
    const diagnostics = {
      ...recordOrEmpty(recordOrEmpty(metadata).diagnostics),
      ...transportDiagnostics(this.transport),
    };
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

function transportDiagnostics(transport: Transport): Record<string, unknown> {
  const diagnostics = (transport as unknown as { diagnostics?: () => TransportDiagnostics }).diagnostics?.();
  const requestLifecycle = diagnostics?.request_lifecycle;
  return Array.isArray(requestLifecycle) && requestLifecycle.length > 0
    ? { sdk_requests: requestLifecycle }
    : {};
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

function normalizeFinalizeTabsResult(row: BrowserFinalizeTabsWireResult): BrowserFinalizeTabsResult {
  const finalTabsValue = field(row, "finalTabs", "final_tabs");
  const status = finalTabsValue === null ? "fatal" : finalizeStatus(row.status) ?? "ok";
  const actions = arrayField(row, "actions").map(normalizeFinalizeAction);
  const closedTabIds = tabIdListField(row, "closedTabIds", "closed_tab_ids");
  const releasedTabIds = tabIdListField(row, "releasedTabIds", "released_tab_ids");
  const keptTabs = tabListField(row, "keptTabs", "kept_tabs");
  const deliverableTabs = tabListField(row, "deliverableTabs", "deliverable_tabs");
  const failures = arrayField(row, "failures").map(normalizeFinalizeFailure);
  if (status === "fatal") {
    return {
      status,
      actions,
      closedTabIds,
      releasedTabIds,
      keptTabs,
      deliverableTabs,
      finalTabs: null,
      failures,
      errorCode: stringField(row, "errorCode", "error_code") ?? "finalize_failed",
      errorMessage: stringField(row, "errorMessage", "error_message") ?? "finalizeTabs failed",
      diagnostics: normalizeFinalizeDiagnostics(row, false),
    };
  }
  return {
    status,
    actions,
    closedTabIds,
    releasedTabIds,
    keptTabs,
    deliverableTabs,
    finalTabs: normalizeFinalizeFinalTabs(finalTabsValue, keptTabs, deliverableTabs),
    failures,
    diagnostics: normalizeFinalizeDiagnostics(row, true),
  };
}

function shouldEndTurnAfterFinalize(result: BrowserFinalizeTabsResult, opts: BrowserFinishTurnOptions): boolean {
  if (result.status === "fatal") return false;
  if (result.status === "partial") return opts.endTurnOnPartial === true;
  return result.failures.length === 0;
}

function normalizeFinalizeAction(value: unknown): BrowserFinalizeTabAction {
  const row = requiredRecord(value, "finalizeTabs action");
  const errorCode = stringField(row, "errorCode", "error_code");
  const errorMessage = stringField(row, "errorMessage", "error_message");
  const action: BrowserFinalizeTabAction = {
    tabId: requiredTabId(field(row, "tabId", "tab_id"), "finalizeTabs action tabId"),
    origin: finalizeOrigin(row.origin),
    desiredStatus: requiredFinalizeDesiredStatus(field(row, "desiredStatus", "desired_status")),
    outcome: requiredFinalizeOutcome(row.outcome),
  };
  if (errorCode !== undefined) action.errorCode = errorCode;
  if (errorMessage !== undefined) action.errorMessage = errorMessage;
  return action;
}

function normalizeFinalizeFailure(value: unknown): BrowserFinalizeTabFailure {
  const row = requiredRecord(value, "finalizeTabs failure");
  const tabId = tabIdField(field(row, "tabId", "tab_id"));
  const desiredStatus = finalizeDesiredStatus(field(row, "desiredStatus", "desired_status"));
  const failure: BrowserFinalizeTabFailure = {
    outcome: requiredFinalizeFailureOutcome(row.outcome),
    errorCode: stringField(row, "errorCode", "error_code") ?? "failed_to_finalize",
    errorMessage: stringField(row, "errorMessage", "error_message") ?? "finalizeTabs transition failed",
  };
  if (tabId !== undefined) failure.tabId = tabId;
  if (desiredStatus !== undefined) failure.desiredStatus = desiredStatus;
  return failure;
}

function normalizeFinalizeFinalTabs(
  value: unknown,
  keptTabs: BrowserFinalizeTab[],
  deliverableTabs: BrowserFinalizeTab[],
): BrowserFinalizeFinalTabs {
  if (!isRecord(value)) {
    return { handoff: keptTabs, deliverable: deliverableTabs, activeTabId: null };
  }
  return {
    handoff: tabListField(value, "handoff"),
    deliverable: tabListField(value, "deliverable"),
    activeTabId: nullableTabId(field(value, "activeTabId", "active_tab_id")),
  };
}

function normalizeFinalizeDiagnostics(
  row: BrowserFinalizeTabsWireResult,
  reconciledFromChrome: true,
): BrowserFinalizeTabsSuccessResult["diagnostics"];
function normalizeFinalizeDiagnostics(
  row: BrowserFinalizeTabsWireResult,
  reconciledFromChrome: false,
): BrowserFinalizeTabsFatalResult["diagnostics"];
function normalizeFinalizeDiagnostics(
  row: BrowserFinalizeTabsWireResult,
  reconciledFromChrome: boolean,
): BrowserFinalizeTabsSuccessResult["diagnostics"] | BrowserFinalizeTabsFatalResult["diagnostics"] {
  if (reconciledFromChrome) {
    return { reconciledFromChrome: true, reconciliationSource: "chrome.tabs" };
  }
  const diagnostics = recordOrEmpty(field(row, "diagnostics"));
  const source = stringField(diagnostics, "reconciliationSource", "reconciliation_source");
  return {
    reconciledFromChrome: false,
    ...(source === "chrome.tabs" ? { reconciliationSource: source } : {}),
  };
}

function normalizeFinalizeTabId(row: BrowserFinalizeKeep): string {
  const value = row.tab ?? row.tab_id ?? row.tabId ?? row.id;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && ("id" in value)) return String(value.id);
  throw new Error("finalizeTabs keep entry missing tab id");
}

function arrayField(row: Record<string, unknown>, key: string): unknown[] {
  const value = row[key];
  return Array.isArray(value) ? value : [];
}

function tabIdListField(row: Record<string, unknown>, camelKey: string, snakeKey: string): string[] {
  const ids = [...arrayField(row, camelKey), ...arrayField(row, snakeKey)].map((value) =>
    requiredTabId(value, camelKey),
  );
  return [...new Set(ids)];
}

function tabListField(row: Record<string, unknown>, camelKey: string, snakeKey?: string): BrowserFinalizeTab[] {
  return arrayFieldFromEither(row, camelKey, snakeKey)
    .filter(isRecord)
    .map((tab) => tab as BrowserFinalizeTab);
}

function arrayFieldFromEither(row: Record<string, unknown>, camelKey: string, snakeKey?: string): unknown[] {
  const camelValue = row[camelKey];
  if (Array.isArray(camelValue)) return camelValue;
  return snakeKey ? arrayField(row, snakeKey) : [];
}

function field(row: Record<string, unknown>, camelKey: string, snakeKey?: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, camelKey)) return row[camelKey];
  if (snakeKey && Object.prototype.hasOwnProperty.call(row, snakeKey)) return row[snakeKey];
  return undefined;
}

function stringField(row: Record<string, unknown>, camelKey: string, snakeKey?: string): string | undefined {
  const value = field(row, camelKey, snakeKey);
  return typeof value === "string" ? value : undefined;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} must be an object`);
}

function finalizeStatus(value: unknown): "ok" | "partial" | "fatal" | undefined {
  return value === "ok" || value === "partial" || value === "fatal" ? value : undefined;
}

function finalizeOrigin(value: unknown): "agent" | "user" {
  if (value === "agent" || value === "user") return value;
  throw new Error("finalizeTabs action origin must be agent or user");
}

function finalizeDesiredStatus(value: unknown): BrowserFinalizeDesiredStatus | undefined {
  if (value === "close" || value === "release" || value === "handoff" || value === "deliverable") {
    return value;
  }
  return undefined;
}

function requiredFinalizeDesiredStatus(value: unknown): BrowserFinalizeDesiredStatus {
  const status = finalizeDesiredStatus(value);
  if (status) return status;
  throw new Error("finalizeTabs action desiredStatus is invalid");
}

function requiredFinalizeOutcome(value: unknown): BrowserFinalizeTabOutcome {
  if (
    value === "closed" ||
    value === "released" ||
    value === "kept_handoff" ||
    value === "kept_deliverable" ||
    value === "tab_gone" ||
    value === "failed" ||
    value === "not_attempted"
  ) {
    return value;
  }
  throw new Error("finalizeTabs action outcome is invalid");
}

function requiredFinalizeFailureOutcome(value: unknown): "failed" | "not_attempted" {
  if (value === "failed" || value === "not_attempted") return value;
  throw new Error("finalizeTabs failure outcome is invalid");
}

function nullableTabId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredTabId(value, "finalizeTabs tab id");
}

function tabIdField(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return undefined;
}

function requiredTabId(value: unknown, label: string): string {
  const id = tabIdField(value);
  if (id !== undefined) return id;
  throw new Error(`${label} must be a non-empty string or integer`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value)
    ? value
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  response: BrowserControlWire,
): BrowserControlTabWire | null | undefined {
  if (!response) return response;
  if (Object.prototype.hasOwnProperty.call(response, "tab")) {
    return (response as { tab?: BrowserControlTabWire | null }).tab;
  }
  return response as BrowserControlTabWire;
}

function unwrapBrowserControlRepair(response: BrowserControlWire): unknown {
  if (!response || !Object.prototype.hasOwnProperty.call(response, "repair")) return undefined;
  return (response as { repair?: unknown }).repair;
}

function normalizeBrowserControlRepair(
  value: unknown,
  fallbackStatus: BrowserResumeControlRepair["status"],
): BrowserResumeControlRepair {
  const row = recordOrEmpty(value);
  const status = row.status === "repair_required" || row.status === "blocked"
    ? row.status
    : fallbackStatus;
  const reason = typeof row.reason === "string" ? row.reason : status === "blocked" ? "no_active_tab" : undefined;
  const nextActiveTabId = field(row, "nextActiveTabId", "next_active_tab_id");
  return {
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(typeof nextActiveTabId === "string" || typeof nextActiveTabId === "number" ? { nextActiveTabId } : {}),
    diagnostics: Array.isArray(row.diagnostics) ? row.diagnostics : [],
    cleanup: Array.isArray(row.cleanup) ? row.cleanup : [],
  };
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
