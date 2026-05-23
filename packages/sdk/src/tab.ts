import { Download } from "./download.js";
import { FileChooser } from "./file-chooser.js";
import { FrameLocator } from "./frame-locator.js";
import { Guards } from "./guards.js";
import { Image } from "./image.js";
import { Locator } from "./locator.js";
import { TabClipboard } from "./tab-clipboard.js";
import {
  TabAct,
  actionId,
  type ActionEffect,
  type ActionResult,
  type AgentPointerState,
  type EnvAction,
} from "./tab-action.js";
import { TabContent } from "./tab-content.js";
import { TabCua } from "./tab-cua.js";
import { TabDev } from "./tab-dev.js";
import { TabDomCua, type DomCuaActionResult } from "./tab-dom-cua.js";
import { TabPlaywright } from "./tab-playwright.js";
import { getSessionLifecycleContext, withSessionMeta } from "./session-meta.js";
import { createActionStateTrace, createObserveStateTrace } from "./state-machines.js";
import type { StateTrace, StateTraceEntry, ObserveRequestState, ActionRuntimeState } from "./state-machines.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_POLL_MS = 50;

export type LoadState = "domcontentloaded" | "load";

export type TabNavigationWaitOptions = {
  url?: string | RegExp;
  waitUntil?: LoadState;
  timeout?: number;
  pollInterval?: number;
};

export type TabMetadata = {
  target_id?: string;
  url?: string;
  title?: string;
  origin?: "agent" | "user";
  status?: "active" | "handoff" | "deliverable";
  active?: boolean;
  logicalActive?: boolean;
  windowId?: number;
  groupId?: number;
  pinned?: boolean;
  lastAccessed?: number;
  lastUsedAt?: number;
  tabGroupTitle?: string;
  tabGroup?: string;
  owned?: boolean;
  claimRequired?: boolean;
  commandable?: boolean;
};

export type ScreenshotOptions = {
  timeout?: number;
  type?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
  };
};

export type ArtifactMode = "inline" | "resource" | "auto";

export type ScreenshotForModelOptions = ScreenshotOptions & {
  artifactMode?: ArtifactMode;
  maxInlineBytes?: number;
};

export type ScreenshotForModelResult =
  | {
      kind: "resource";
      mime_type: string;
      bytes: number;
      summary: string;
    }
  | {
      kind: "inline";
      mime_type: string;
      data_base64: string;
      bytes: number;
      warning?: string;
    };

export type TabEvaluateOptions = {
  timeout?: number;
  maxJsonBytes?: number;
};

export type TabSnapshotTextOptions = TabEvaluateOptions & {
  maxItems?: number;
  maxTextLength?: number;
};

export type TabSnapshotTextResult = {
  url: string;
  title: string;
  viewport?: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
  focus?: {
    tag: string;
    id: string;
    name: string;
    type: string;
    placeholder: string;
    ariaLabel: string;
  } | null;
  headings: Array<{ level: number; text: string }>;
  buttons: string[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ label: string; type: string; name: string; placeholder: string }>;
};

export type TabObserveMode = "compact" | "actionable" | "visual";

export type ObservationSectionStatus = {
  status: "present" | "omitted" | "blocked" | "failed";
  reason?: string;
};

export type ObservationLifecycle = {
  state: "creating" | "fresh" | "invalid" | "discarded";
  sessionId?: string;
  turnId?: string;
  tabId?: string;
  runtimeEpoch?: number;
  createdAt: number;
  expiresAt: number;
  pageStateHash?: string;
  tabRevision?: string;
  frameTreeRevision?: string;
  documentRevision?: string;
  routeRevision?: string;
  viewportRevision?: string;
  pointerRevision?: string;
  focusRevision?: string;
  domCuaRevision?: string;
  modalRevision?: string;
  invalidatedAt?: number;
  invalidity?: {
    reason: "stale" | "expired" | "consumed";
    detail?: string;
  };
  consumedByActionId?: string;
};

export type ObservationActionFamily = {
  name: "locator" | "dom-cua" | "coordinate-cua" | "raw-cdp";
  status: "supported" | "unsupported" | "unknown";
  recommendedOrder: number;
  methods: string[];
  reason?: string;
};

export type TabObserveOptions = {
  mode?: TabObserveMode;
  timeout?: number;
  maxItems?: number;
  maxTextLength?: number;
  includeText?: boolean;
  includeDomCua?: boolean;
  includeScreenshot?: boolean;
  observationTtlMs?: number;
};

export type TabObservation = {
  observationId: string;
  status: "succeeded" | "partial" | "blocked" | "failed" | "cancelled";
  mode: TabObserveMode;
  createdAt: number;
  lifecycle: ObservationLifecycle;
  sections: {
    tab: ObservationSectionStatus;
    lifecycle: ObservationSectionStatus;
    viewport: ObservationSectionStatus;
    pointer: ObservationSectionStatus;
    focus: ObservationSectionStatus;
    text: ObservationSectionStatus;
    domCua: ObservationSectionStatus;
    screenshot: ObservationSectionStatus;
    diagnostics: ObservationSectionStatus;
  };
  tab: {
    id: string;
    url?: string;
    title?: string;
    loadState: "unknown";
    metadata: TabMetadata;
  };
  ownership: {
    state: "claimed_by_agent" | "human_controlled" | "unclaimed" | "released" | "lost";
    commandable: boolean;
    owned?: boolean;
    claimRequired?: boolean;
    status?: TabMetadata["status"];
  };
  actionFamilies: ObservationActionFamily[];
  pointer?: AgentPointerState;
  text?: TabSnapshotTextResult;
  domCua?: DomCuaObservation;
  screenshot?: ScreenshotForModelResult;
  diagnostics: {
    advisories: string[];
    sectionErrors: Record<string, string>;
    stateTrace: StateTraceEntry<ObserveRequestState>[];
    backend?: {
      supportedMethods?: readonly string[];
      unsupportedMethods?: readonly string[];
    };
  };
};

export type DomCuaObservation = {
  text?: string;
  snapshot?: unknown;
};

type ActionExecutionResult = {
  point?: ActionExecutionPoint;
  pointerDisposition?: "known" | "stale" | "unchanged";
  staleReason?: string;
};

type ActionExecutionPoint = {
  x: number;
  y: number;
  coordinateSpace?: AgentPointerState["coordinateSpace"];
};

type ObservationFreshnessResult =
  | { ok: true }
  | { ok: false; detail: string; data?: unknown };

export type TabRuntimeLifecycleEpoch = {
  value: number;
  staleReason?: string;
  updatedAt: number;
};

export type TabRuntimeContext = {
  supportedMethods?: readonly string[];
  unsupportedMethods?: readonly string[];
  diagnostics?: Record<string, unknown>;
  pointerStore?: Map<string, AgentPointerState>;
  observationStore?: Map<string, ObservationLifecycle>;
  lifecycleEpoch?: TabRuntimeLifecycleEpoch;
};

export type DomSnapshotResult = {
  domSnapshot: string;
  source: "playwright_dom_snapshot";
  metadata?: Record<string, unknown>;
};

export class Tab {
  readonly act: TabAct;
  readonly clipboard: TabClipboard;
  readonly content: TabContent;
  readonly cua: TabCua;
  readonly dev: TabDev;
  readonly dom_cua: TabDomCua;
  readonly playwright: TabPlaywright;
  readonly metadata: TabMetadata;
  #localObservations = new Map<string, ObservationLifecycle>();
  #pointerState: AgentPointerState | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly guards: Guards,
    public readonly id: string,
    metadata: TabMetadata = {},
    private readonly runtimeContext: TabRuntimeContext = {},
  ) {
    this.metadata = metadata;
    this.#pointerState = this.runtimeContext.pointerStore?.get(this.id);
    const ensureCommandable = (method: string) => this.#ensureCommandable(method);
    this.act = new TabAct((action) => this.step(action));
    this.clipboard = new TabClipboard(transport, guards, id, ensureCommandable);
    this.content = new TabContent(transport, guards, id, ensureCommandable);
    this.cua = new TabCua(transport, guards, id, ensureCommandable);
    this.dev = new TabDev(transport, guards, id, ensureCommandable);
    this.dom_cua = new TabDomCua(transport, guards, id, ensureCommandable);
    this.playwright = new TabPlaywright(transport, guards, id, ensureCommandable);
  }

  async observe(opts: TabObserveOptions = {}): Promise<TabObservation> {
    const stateTrace = createObserveStateTrace();
    const mode = opts.mode ?? "compact";
    const createdAt = Date.now();
    const observationId = `${this.id}:${createdAt}:${nextObservationSequence()}`;
    stateTrace.transition("preflight");
    const ttlMs = positiveInt(opts.observationTtlMs, 30_000);
    const advisories: string[] = [];
    const sectionErrors: Record<string, string> = {};
    const sections = initialObservationSections(mode, opts);
    stateTrace.transition("reading_backend");
    const tab: TabObservation["tab"] = {
      id: this.id,
      loadState: "unknown",
      metadata: { ...this.metadata },
      ...(this.metadata.url !== undefined ? { url: this.metadata.url } : {}),
      ...(this.metadata.title !== undefined ? { title: this.metadata.title } : {}),
    };

    const urlResult = await this.#observeSection("tab.url", async () => {
      const url = await this.#readCurrentUrlRaw(opts.timeout);
      await this.guards.ensureCommandAllowed(
        { command: M.TAB_URL, tab_id: this.id },
        { currentUrl: url },
      );
      return url;
    });
    if (urlResult.ok) tab.url = urlResult.value;
    else {
      sectionErrors["tab.url"] = urlResult.error;
      advisories.push("tab URL could not be read; page-state continuity is weaker");
    }

    const titleResult = await this.#observeSection("tab.title", async () => {
      await this.#ensureObserveReadAllowed(M.TAB_TITLE, {}, tab.url, opts.timeout);
      return await this.transport.sendRequest<string>(
        M.TAB_TITLE,
        withSessionMeta({ tab_id: this.id }),
        opts.timeout,
      );
    });
    if (titleResult.ok) tab.title = titleResult.value;
    else {
      sectionErrors["tab.title"] = titleResult.error;
      advisories.push("tab title could not be read");
    }
    sections.tab = Object.keys(sectionErrors).some((key) => key.startsWith("tab."))
      ? { status: "present", reason: "metadata present; one or more live tab fields failed" }
      : { status: "present" };

    let text: TabSnapshotTextResult | undefined;
    if (opts.includeText !== false) {
      const textResult = await this.#observeSection("text", async () => {
        await this.#ensureObserveReadAllowed(M.TAB_SNAPSHOT_TEXT, {}, tab.url, opts.timeout);
        return await this.#snapshotTextForObserve(opts);
      });
      if (textResult.ok) {
        text = textResult.value;
        sections.text = { status: "present" };
        if (text.viewport !== undefined) sections.viewport = { status: "present" };
        if (text.focus !== undefined) sections.focus = { status: "present" };
      } else {
        sectionErrors.text = textResult.error;
        sections.text = { status: "failed", reason: textResult.error };
      }
    }

    let domCua: DomCuaObservation | undefined;
    let domCuaRevision: string | undefined;
    const shouldReadDomCua = opts.includeDomCua ?? (mode === "actionable" || mode === "visual");
    if (shouldReadDomCua) {
      if (this.#methodStatus(M.DOM_CUA_GET_VISIBLE_DOM) === "unsupported") {
        sections.domCua = { status: "blocked", reason: "capability_unsupported" };
      } else {
        const domResult = await this.#observeSection("domCua", async () => {
          await this.#ensureObserveReadAllowed(M.DOM_CUA_GET_VISIBLE_DOM, {}, tab.url, opts.timeout);
          const response = await this.transport.sendRequest<{ text?: string } & Record<string, unknown>>(
            M.DOM_CUA_GET_VISIBLE_DOM,
            withSessionMeta({ tab_id: this.id, format: "compact_text", observation_id: observationId }),
            opts.timeout,
          );
          return {
            ...(typeof response.text === "string" ? { text: response.text } : {}),
            snapshot: response,
          };
        });
        if (domResult.ok) {
          domCua = domResult.value;
          domCuaRevision = domCuaRevisionFromSnapshot(domResult.value.snapshot);
          sections.domCua = { status: "present" };
        } else {
          sectionErrors.domCua = domResult.error;
          sections.domCua = { status: "failed", reason: domResult.error };
        }
      }
    }

    let screenshot: ScreenshotForModelResult | undefined;
    const shouldReadScreenshot = opts.includeScreenshot ?? mode === "visual";
    if (shouldReadScreenshot) {
      const screenshotResult = await this.#observeSection("screenshot", async () => {
        await this.#ensureObserveReadAllowed(M.TAB_SCREENSHOT, {}, tab.url, opts.timeout);
        const row = await this.transport.sendRequest<{ data?: string; data_base64?: string; mime_type?: string }>(
          M.TAB_SCREENSHOT,
          withSessionMeta({ tab_id: this.id, type: "jpeg", quality: 60, fullPage: false }),
          opts.timeout,
        );
        return await screenshotForModelResultFromRow(row);
      });
      if (screenshotResult.ok) {
        screenshot = screenshotResult.value;
        sections.screenshot = { status: "present" };
      } else {
        sectionErrors.screenshot = screenshotResult.error;
        sections.screenshot = { status: "failed", reason: screenshotResult.error };
      }
    }

    const pageStateHash = observationPageStateHash({
      tabId: this.id,
      url: tab.url,
      title: tab.title,
      status: this.metadata.status,
      active: this.metadata.active,
      logicalActive: this.metadata.logicalActive,
      commandable: this.metadata.commandable,
    });
    const lifecycle: ObservationLifecycle = {
      state: "fresh",
      ...getSessionLifecycleContext(),
      tabId: this.id,
      runtimeEpoch: this.#runtimeEpoch(),
      createdAt,
      expiresAt: createdAt + ttlMs,
      pageStateHash,
      tabRevision: pageStateHash,
      ...(tab.url !== undefined ? { documentRevision: tab.url, routeRevision: tab.url } : {}),
      ...(text?.viewport !== undefined ? { viewportRevision: observationPageStateHash({ viewport: text.viewport }) } : {}),
      ...(text?.focus !== undefined ? { focusRevision: observationPageStateHash({ focus: text.focus }) } : {}),
      ...(domCuaRevision !== undefined ? { domCuaRevision } : {}),
    };
    const diagnostics = {
      advisories,
      sectionErrors,
      stateTrace: stateTrace.history,
      backend: {
        ...(this.runtimeContext.supportedMethods !== undefined ? { supportedMethods: this.runtimeContext.supportedMethods } : {}),
        ...(this.runtimeContext.unsupportedMethods !== undefined ? { unsupportedMethods: this.runtimeContext.unsupportedMethods } : {}),
      },
    };
    stateTrace.transition("composing_snapshot");
    this.#pointerState = this.runtimeContext.pointerStore?.get(this.id) ?? this.#pointerState;
    const pointer = this.#pointerState;
    if (pointer !== undefined) {
      sections.pointer = {
        status: "present",
        ...(pointer.phase === "stale" && pointer.staleReason !== undefined ? { reason: pointer.staleReason } : {}),
      };
    }
    const actionFamilies = this.#actionFamilies();
    const status = observationStatus(mode, sections, actionFamilies);
    stateTrace.transition(status);
    this.#observationStore().set(observationId, lifecycle);
    return {
      observationId,
      status,
      mode,
      createdAt,
      lifecycle,
      sections,
      tab,
      ownership: this.#ownershipObservation(),
      actionFamilies,
      ...(pointer !== undefined ? { pointer } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(domCua !== undefined ? { domCua } : {}),
      ...(screenshot !== undefined ? { screenshot } : {}),
      diagnostics,
    };
  }

  async step(action: EnvAction): Promise<ActionResult> {
    const stateTrace = createActionStateTrace();
    const startedAt = Date.now();
    const id = action.actionId ?? actionId("tab");
    stateTrace.transition("preflight");
    const blocked = await this.#preflightAction(action, id, startedAt, stateTrace);
    if (blocked) return blocked;
    try {
      stateTrace.transition("running");
      const execution = await this.#executeAction(action);
      stateTrace.transition("waiting_for_effect");
      const pointer = this.#updatePointerAfterAction(action, execution);
      const invalidatedObservations = this.#consumeActionObservation(action, id);
      stateTrace.transition("reconciling");
      stateTrace.transition("succeeded");
      return actionResult({
        actionId: id,
        action,
        status: "succeeded",
        effect: actionEffect(action),
        startedAt,
        pointer,
        invalidatedObservations,
        stateTrace: stateTrace.history,
      });
    } catch (error) {
      if (stateTrace.state !== "failed") stateTrace.transition("failed");
      return actionResult({
        actionId: id,
        action,
        status: "failed",
        effect: "unknown",
        startedAt,
        pointer: this.#pointerState,
        stateTrace: stateTrace.history,
        error: {
          code: "action_failed",
          message: errorMessage(error),
        },
      });
    }
  }

  locator(selector: string): Locator {
    return new Locator(this.transport, this.guards, this.id, selector, (method) => this.#ensureCommandable(method));
  }

  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.transport, this.guards, this.id, selector, (method) => this.#ensureCommandable(method));
  }

  getByRole(role: string, opts: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return this.locator("").getByRole(role, opts);
  }

  getByText(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.locator("").getByText(text, opts);
  }

  getByLabel(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.locator("").getByLabel(text, opts);
  }

  getByPlaceholder(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return this.locator("").getByPlaceholder(text, opts);
  }

  getByTestId(testId: string): Locator {
    return this.locator("").getByTestId(testId);
  }

  async goto(url: string, opts: { timeout?: number } = {}): Promise<void> {
    this.#ensureCommandable(M.TAB_GOTO);
    await this.guards.ensureCommandAllowed({ command: M.TAB_GOTO, tab_id: this.id, url });
    await this.transport.sendRequest(M.TAB_GOTO, withSessionMeta({ tab_id: this.id, url }), opts.timeout);
  }

  async attach(opts: { timeout?: number } = {}): Promise<void> {
    this.#ensureCommandable(M.ATTACH);
    await this.transport.sendRequest(M.ATTACH, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async detach(opts: { timeout?: number } = {}): Promise<void> {
    this.#ensureCommandable(M.DETACH);
    await this.transport.sendRequest(M.DETACH, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async reload(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_RELOAD, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_RELOAD, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async back(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_BACK, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_BACK, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async forward(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_FORWARD, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_FORWARD, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async waitForURL(url: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_WAIT_FOR_URL, { url }, opts.timeout);
    await this.transport.sendRequest(M.TAB_WAIT_FOR_URL, withSessionMeta({ tab_id: this.id, url }), opts.timeout);
  }

  async waitForUrl(url: string, opts: { timeout?: number } = {}): Promise<void> {
    await this.waitForURL(url, opts);
  }

  async waitForLoadState(state: LoadState = "load", opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_WAIT_FOR_LOAD_STATE, { state }, opts.timeout);
    await this.transport.sendRequest(M.TAB_WAIT_FOR_LOAD_STATE, withSessionMeta({ tab_id: this.id, state }), opts.timeout);
  }

  async waitForNavigation(opts?: TabNavigationWaitOptions): Promise<void>;
  async waitForNavigation<T>(action: () => T | Promise<T>, opts?: TabNavigationWaitOptions): Promise<T>;
  async waitForNavigation<T>(
    actionOrOpts?: (() => T | Promise<T>) | TabNavigationWaitOptions,
    opts: TabNavigationWaitOptions = {},
  ): Promise<T | void> {
    const action = typeof actionOrOpts === "function" ? actionOrOpts : undefined;
    const options: TabNavigationWaitOptions = action ? opts : ((actionOrOpts as TabNavigationWaitOptions | undefined) ?? {});
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    const startUrl = await this.url({ timeout: remainingMs(deadline) });
    let cancelled = false;
    const wait = this.#waitForNavigationFrom(startUrl, deadline, options, () => cancelled);

    if (!action) {
      await wait;
      return;
    }

    try {
      const result = await action();
      await wait;
      return result;
    } catch (error) {
      cancelled = true;
      wait.catch(() => {});
      throw error;
    }
  }

  async url(opts: { timeout?: number } = {}): Promise<string> {
    this.#ensureCommandable(M.TAB_URL);
    const currentUrl = await this.#currentUrlForGuard(opts.timeout);
    await this.guards.ensureCommandAllowed({ command: M.TAB_URL, tab_id: this.id }, { currentUrl });
    return currentUrl;
  }

  async title(opts: { timeout?: number } = {}): Promise<string> {
    await this.#ensureTabCommandAllowed(M.TAB_TITLE, {}, opts.timeout);
    return await this.transport.sendRequest<string>(M.TAB_TITLE, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<Image> {
    await this.#ensureTabCommandAllowed(M.TAB_SCREENSHOT, {}, opts.timeout);
    const row = await this.transport.sendRequest<{ data?: string; data_base64?: string; mime_type?: string }>(
      M.TAB_SCREENSHOT,
      withSessionMeta({ tab_id: this.id, ...screenshotParams(opts) }),
      opts.timeout,
    );
    return Image.from({
      data_base64: row.data_base64 ?? row.data ?? "",
      mime_type: row.mime_type ?? "image/png",
    });
  }

  async screenshotForModel(opts: ScreenshotForModelOptions = {}): Promise<ScreenshotForModelResult> {
    const artifactMode = opts.artifactMode ?? "auto";
    const maxInlineBytes = opts.maxInlineBytes ?? 32 * 1024;
    const shot = await this.screenshot({
      ...opts,
      type: opts.type ?? "jpeg",
      quality: opts.quality ?? 60,
      fullPage: opts.fullPage ?? false,
    });
    const bytes = estimatedBase64Bytes(shot.data_base64);
    const shouldEmit =
      artifactMode === "resource" || (artifactMode === "auto" && bytes > maxInlineBytes);
    if (shouldEmit) {
      const emitted = await emitMcpImage(shot);
      if (emitted) {
        return {
          kind: "resource",
          mime_type: shot.mime_type,
          bytes,
          summary: `${bytes} byte ${shot.mime_type} screenshot emitted as an MCP resource`,
        };
      }
    }
    return {
      kind: "inline",
      mime_type: shot.mime_type,
      data_base64: shot.data_base64,
      bytes,
      ...(shouldEmit
        ? { warning: "MCP image emission is unavailable; returned inline screenshot bytes" }
        : {}),
    };
  }

  async evaluate<T = unknown>(
    expressionOrFn: string | (() => T | Promise<T>),
    opts: TabEvaluateOptions = {},
  ): Promise<T | unknown> {
    const maxJsonBytes = opts.maxJsonBytes ?? 64 * 1024;
    return this.#evaluateWithMethod<T>(
      M.TAB_EVALUATE,
      boundedEvaluateExpression(expressionOrFn, maxJsonBytes),
      opts.timeout,
      "tab.evaluate failed",
    );
  }

  async snapshotText(opts: TabSnapshotTextOptions = {}): Promise<TabSnapshotTextResult> {
    const maxItems = positiveInt(opts.maxItems, 20);
    const maxTextLength = positiveInt(opts.maxTextLength, 120);
    const result = await this.#evaluateWithMethod<TabSnapshotTextResult>(
      M.TAB_SNAPSHOT_TEXT,
      boundedEvaluateExpression(snapshotTextExpression(maxItems, maxTextLength), opts.maxJsonBytes ?? 32 * 1024),
      opts.timeout,
      "tab.snapshotText failed",
      opts.maxJsonBytes ?? 32 * 1024,
    );
    if (isTruncatedEvaluateSummary(result)) {
      throw new Error(
        "tab.snapshotText result exceeded maxJsonBytes; reduce maxItems/maxTextLength or increase maxJsonBytes",
      );
    }
    return result as TabSnapshotTextResult;
  }

  async domSnapshot(opts: { timeout?: number } = {}): Promise<DomSnapshotResult> {
    await this.#ensureTabCommandAllowed(M.PLAYWRIGHT_DOM_SNAPSHOT, {}, opts.timeout);
    const row = await this.transport.sendRequest<{ domSnapshot?: string; source?: string; metadata?: Record<string, unknown> }>(
      M.PLAYWRIGHT_DOM_SNAPSHOT,
      withSessionMeta({ tab_id: this.id }),
      opts.timeout,
    );
    return {
      domSnapshot: typeof row.domSnapshot === "string" ? row.domSnapshot : "",
      source: "playwright_dom_snapshot",
      ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
    };
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.#ensureCommandable(M.PLAYWRIGHT_WAIT_FOR_TIMEOUT);
    await this.transport.sendRequest(M.PLAYWRIGHT_WAIT_FOR_TIMEOUT, withSessionMeta({ tab_id: this.id, timeout_ms: ms }), ms + 1000);
  }

  async close(opts: { timeout?: number } = {}): Promise<void> {
    await this.#ensureTabCommandAllowed(M.TAB_CLOSE, {}, opts.timeout);
    await this.transport.sendRequest(M.TAB_CLOSE, withSessionMeta({ tab_id: this.id }), opts.timeout);
  }

  async #ensureTabCommandAllowed(method: string, params: Record<string, unknown> = {}, timeout?: number): Promise<void> {
    this.#ensureCommandable(method);
    const command = { command: method, tab_id: this.id, ...params };
    const currentUrl = this.guards.needsCurrentUrl(method)
      ? await this.#currentUrlForGuard(timeout)
      : undefined;
    await this.guards.ensureCommandAllowed(command, { currentUrl });
  }

  async #currentUrlForGuard(timeout?: number): Promise<string> {
    return await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.id }), timeout);
  }

  async #ensureObserveReadAllowed(
    method: string,
    params: Record<string, unknown>,
    currentUrl: string | undefined,
    timeout?: number,
  ): Promise<void> {
    const resolvedCurrentUrl = this.guards.needsCurrentUrl(method)
      ? currentUrl ?? await this.#readCurrentUrlRaw(timeout)
      : currentUrl;
    await this.guards.ensureCommandAllowed(
      { command: method, tab_id: this.id, ...params },
      { currentUrl: resolvedCurrentUrl },
    );
  }

  async #readCurrentUrlRaw(timeout?: number): Promise<string> {
    return await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.id }), timeout);
  }

  async #snapshotTextForObserve(opts: TabObserveOptions): Promise<TabSnapshotTextResult> {
    const maxItems = positiveInt(opts.maxItems, 20);
    const maxTextLength = positiveInt(opts.maxTextLength, 120);
    const response = await this.transport.sendRequest<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      M.TAB_SNAPSHOT_TEXT,
      withSessionMeta({
        tab_id: this.id,
        expression: boundedEvaluateExpression(snapshotTextExpression(maxItems, maxTextLength), 32 * 1024),
        awaitPromise: true,
        returnByValue: true,
        maxJsonBytes: 32 * 1024,
      }),
      opts.timeout,
    );
    if (response?.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? "tab.observe text section failed",
      );
    }
    const value = response?.result?.value;
    if (isRecord(value) && "__obu_evaluate_value" in value) {
      return value.__obu_evaluate_value as TabSnapshotTextResult;
    }
    return value as TabSnapshotTextResult;
  }

  async #observeSection<T>(
    _section: string,
    read: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      return { ok: true, value: await read() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  #methodStatus(method: string): "supported" | "unsupported" | "unknown" {
    if (this.runtimeContext.unsupportedMethods?.includes(method)) return "unsupported";
    if (this.runtimeContext.supportedMethods?.includes(method)) return "supported";
    if (this.runtimeContext.supportedMethods !== undefined && this.runtimeContext.supportedMethods.length > 0) {
      return "unsupported";
    }
    return "unknown";
  }

  #unsupportedActionMethod(action: EnvAction): string | undefined {
    const method = actionRequiredMethod(action);
    return this.#methodStatus(method) === "unsupported" ? method : undefined;
  }

  #ownershipObservation(): TabObservation["ownership"] {
    const commandable = this.metadata.commandable !== false;
    const claimRequired = this.metadata.claimRequired === true;
    const owned = this.metadata.owned;
    const state: TabObservation["ownership"]["state"] = commandable
      ? "claimed_by_agent"
      : claimRequired
        ? "human_controlled"
        : "unclaimed";
    return {
      state,
      commandable,
      ...(owned !== undefined ? { owned } : {}),
      ...(claimRequired !== undefined ? { claimRequired } : {}),
      ...(this.metadata.status !== undefined ? { status: this.metadata.status } : {}),
    };
  }

  #actionFamilies(): ObservationActionFamily[] {
    return [
      {
        name: "locator",
        recommendedOrder: 1,
        methods: [M.PLAYWRIGHT_LOCATOR_CLICK, M.PLAYWRIGHT_LOCATOR_FILL, M.PLAYWRIGHT_LOCATOR_PRESS],
        status: this.#anyActionMethodStatus([
          M.PLAYWRIGHT_LOCATOR_CLICK,
          M.PLAYWRIGHT_LOCATOR_FILL,
          M.PLAYWRIGHT_LOCATOR_PRESS,
        ]),
      },
      {
        name: "dom-cua",
        recommendedOrder: 2,
        methods: [
          M.DOM_CUA_GET_VISIBLE_DOM,
          M.DOM_CUA_CLICK,
          M.DOM_CUA_TYPE,
          M.DOM_CUA_SCROLL,
          M.DOM_CUA_KEYPRESS,
        ],
        status: this.#domCuaFamilyStatus(),
      },
      {
        name: "coordinate-cua",
        recommendedOrder: 3,
        methods: [M.CUA_CLICK, M.CUA_MOVE, M.CUA_SCROLL, M.CUA_TYPE, M.CUA_KEYPRESS],
        status: this.#anyActionMethodStatus([M.CUA_CLICK, M.CUA_MOVE, M.CUA_SCROLL, M.CUA_TYPE, M.CUA_KEYPRESS]),
      },
      {
        name: "raw-cdp",
        recommendedOrder: 4,
        methods: [M.EXECUTE_CDP],
        status: this.#allRequiredMethodStatus([M.EXECUTE_CDP]),
        reason: "policy-gated escape hatch",
      },
    ];
  }

  #anyActionMethodStatus(methods: readonly string[]): "supported" | "unsupported" | "unknown" {
    const statuses = methods.map((method) => this.#methodStatus(method));
    if (statuses.some((status) => status === "supported")) return "supported";
    if (statuses.every((status) => status === "unsupported")) return "unsupported";
    return "unknown";
  }

  #allRequiredMethodStatus(methods: readonly string[]): "supported" | "unsupported" | "unknown" {
    const statuses = methods.map((method) => this.#methodStatus(method));
    if (statuses.every((status) => status === "supported")) return "supported";
    if (statuses.some((status) => status === "unsupported")) return "unsupported";
    return "unknown";
  }

  #domCuaFamilyStatus(): "supported" | "unsupported" | "unknown" {
    const readStatus = this.#methodStatus(M.DOM_CUA_GET_VISIBLE_DOM);
    const actionStatus = this.#anyActionMethodStatus([
      M.DOM_CUA_CLICK,
      M.DOM_CUA_TYPE,
      M.DOM_CUA_SCROLL,
      M.DOM_CUA_KEYPRESS,
    ]);
    if (readStatus === "supported" && actionStatus === "supported") return "supported";
    if (readStatus === "unsupported" || actionStatus === "unsupported") return "unsupported";
    return "unknown";
  }

  async #evaluateWithMethod<T>(
    method: string,
    expression: string,
    timeout: number | undefined,
    fallbackMessage: string,
    maxJsonBytes?: number,
  ): Promise<T | unknown> {
    await this.#ensureTabCommandAllowed(method, {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...(maxJsonBytes !== undefined ? { maxJsonBytes } : {}),
    }, timeout);
    const response = await this.transport.sendRequest<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      method,
      withSessionMeta({
        tab_id: this.id,
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...(maxJsonBytes !== undefined ? { maxJsonBytes } : {}),
      }),
      timeout,
    );
    if (response?.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? fallbackMessage,
      );
    }
    const value = response?.result?.value;
    if (isRecord(value) && "__obu_evaluate_value" in value) {
      return value.__obu_evaluate_value as T;
    }
    if (isRecord(value) && "__obu_evaluate_summary" in value) {
      return value.__obu_evaluate_summary;
    }
    return value as T;
  }

  #ensureCommandable(method: string): void {
    if (this.metadata.commandable !== false) return;
    throw new Error(`tab ${this.id} is not commandable; claim or resume it before ${method}`);
  }

  async #preflightAction(
    action: EnvAction,
    actionIdValue: string,
    startedAt: number,
    stateTrace: StateTrace<ActionRuntimeState>,
  ): Promise<ActionResult | undefined> {
    if (this.metadata.commandable === false) {
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        stateTrace: stateTrace.history,
        error: {
          code: "tab_not_commandable",
          message: `tab ${this.id} is not commandable; claim or resume it before ${action.kind}`,
        },
      });
    }
    const unsupportedMethod = this.#unsupportedActionMethod(action);
    if (unsupportedMethod !== undefined) {
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        stateTrace: stateTrace.history,
        error: {
          code: "unsupported_backend_capability",
          message: `${action.kind} requires unsupported backend method ${unsupportedMethod}`,
          data: {
            code: "unsupported_backend_capability",
            action: action.kind,
            method: unsupportedMethod,
            missing_capability: `method:${unsupportedMethod}`,
          },
        },
      });
    }
    const observationId = observationIdForAction(action);
    if (!observationId) {
      if (action.target.source === "dom-cua") {
        stateTrace.transition("blocked");
        return actionResult({
          actionId: actionIdValue,
          action,
          status: "blocked",
          effect: "no_visible_change",
          startedAt,
          pointer: this.#pointerState,
          stateTrace: stateTrace.history,
          error: {
            code: "missing_observation",
            message: `${action.kind} requires a DOM-CUA target from a current tab.observe() result`,
          },
        });
      }
      if (action.target.source === "coordinate" && coordinateActionUsesPointer(action) && this.#pointerState?.phase === "stale") {
        stateTrace.transition("blocked");
        return actionResult({
          actionId: actionIdValue,
          action,
          status: "blocked",
          effect: "no_visible_change",
          startedAt,
          pointer: this.#pointerState,
          stateTrace: stateTrace.history,
          error: {
            code: "stale_pointer",
            message: `${action.kind} requires a fresh observation after pointer state became stale`,
            data: {
              staleReason: this.#pointerState.staleReason,
            },
          },
        });
      }
      return undefined;
    }
    const lifecycle = this.#observationStore().get(observationId);
    if (!lifecycle) {
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        stateTrace: stateTrace.history,
        error: {
          code: "unknown_observation",
          message: `observation ${observationId} is not known to this tab`,
        },
      });
    }
    if (lifecycle.tabId !== undefined && lifecycle.tabId !== this.id) {
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        stateTrace: stateTrace.history,
        error: {
          code: "wrong_observation_tab",
          message: `observation ${observationId} belongs to tab ${lifecycle.tabId}, not ${this.id}`,
          data: lifecycle,
        },
      });
    }
    const lifecycleEpoch = lifecycle.runtimeEpoch ?? 0;
    const currentEpoch = this.#runtimeEpoch();
    if (lifecycleEpoch !== currentEpoch) {
      const invalidated = this.#invalidateObservation(
        observationId,
        "stale",
        this.runtimeContext.lifecycleEpoch?.staleReason ?? "runtime lifecycle changed",
      );
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        invalidatedObservations: [observationId],
        stateTrace: stateTrace.history,
        error: {
          code: "stale_observation",
          message: `observation ${observationId} was created before the current browser-control lifecycle`,
          data: invalidated ?? lifecycle,
        },
      });
    }
    const now = Date.now();
    if (lifecycle.state !== "fresh" || now >= lifecycle.expiresAt) {
      if (now >= lifecycle.expiresAt && lifecycle.state === "fresh") {
        this.#invalidateObservation(observationId, "expired", "observation ttl elapsed");
      }
      const updated = this.#observationStore().get(observationId) ?? lifecycle;
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        stateTrace: stateTrace.history,
        error: {
          code: "invalid_observation",
          message: `observation ${observationId} is ${updated.invalidity?.reason ?? updated.state}`,
          data: updated,
        },
      });
    }
    if (action.target.source === "dom-cua" && lifecycle.domCuaRevision === undefined) {
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        stateTrace: stateTrace.history,
        error: {
          code: "invalid_observation",
          message: `observation ${observationId} did not include DOM-CUA affordances`,
          data: lifecycle,
        },
      });
    }
    const freshness = await this.#validateObservationStillFresh(observationId, lifecycle, action);
    if (!freshness.ok) {
      const invalidated = this.#invalidateObservation(
        observationId,
        "stale",
        freshness.detail,
      );
      stateTrace.transition("blocked");
      return actionResult({
        actionId: actionIdValue,
        action,
        status: "blocked",
        effect: "no_visible_change",
        startedAt,
        pointer: this.#pointerState,
        invalidatedObservations: [observationId],
        stateTrace: stateTrace.history,
        error: {
          code: "stale_observation",
          message: `observation ${observationId} no longer matches the current page state`,
          data: freshness.data ?? invalidated,
        },
      });
    }
    return undefined;
  }

  async #executeAction(action: EnvAction): Promise<ActionExecutionResult> {
    switch (action.kind) {
      case "locator.click":
        assertTarget(action, "locator");
        await this.locator(action.target.selector).click(mouseActionOptions(action));
        return {
          pointerDisposition: "stale",
          staleReason: "locator action executed without a reported cursor point",
        };
      case "locator.fill":
        assertTarget(action, "locator");
        await this.locator(action.target.selector).fill(action.text ?? "", timeoutActionOptions(action));
        return {
          pointerDisposition: "stale",
          staleReason: "locator action executed without a reported cursor point",
        };
      case "locator.type":
        assertTarget(action, "locator");
        await this.locator(action.target.selector).type(action.text ?? "", timeoutActionOptions(action));
        return {
          pointerDisposition: "stale",
          staleReason: "locator action executed without a reported cursor point",
        };
      case "locator.press":
        assertTarget(action, "locator");
        await this.locator(action.target.selector).press(singleKey(action.key), timeoutActionOptions(action));
        return {
          pointerDisposition: "stale",
          staleReason: "locator action executed without a reported cursor point",
        };
      case "dom_cua.click":
        assertTarget(action, "dom-cua");
        return domCuaExecutionResult(
          await this.dom_cua.click(
            action.target.nodeId,
            observationActionOptions(action, modifierActionOptions(action)),
          ),
        );
      case "dom_cua.type":
        assertTarget(action, "dom-cua");
        return domCuaExecutionResult(
          await this.dom_cua.type(
            action.target.nodeId,
            action.text ?? "",
            observationActionOptions(action, timeoutActionOptions(action)),
          ),
        );
      case "dom_cua.scroll":
        assertTarget(action, "dom-cua");
        return domCuaExecutionResult(
          await this.dom_cua.scroll(
            action.target.nodeId,
            action.delta ?? 0,
            observationActionOptions(action, modifierActionOptions(action)),
          ),
        );
      case "dom_cua.keypress":
        assertTarget(action, "dom-cua");
        return domCuaExecutionResult(
          await this.dom_cua.keypress(
            action.target.nodeId,
            action.key ?? "",
            observationActionOptions(action, modifierActionOptions(action)),
          ),
        );
      case "coordinate.click":
        assertTarget(action, "coordinate");
        await this.cua.click(requiredNumber(action.target.x, "x"), requiredNumber(action.target.y, "y"), mouseActionOptions(action));
        return { pointerDisposition: "known" };
      case "coordinate.move":
        assertTarget(action, "coordinate");
        await this.cua.move(requiredNumber(action.target.x, "x"), requiredNumber(action.target.y, "y"), modifierActionOptions(action));
        return { pointerDisposition: "known" };
      case "coordinate.scroll":
        assertTarget(action, "coordinate");
        await this.cua.scroll(
          requiredNumber(action.target.x, "x"),
          requiredNumber(action.target.y, "y"),
          action.delta ?? 0,
          modifierActionOptions(action),
        );
        return { pointerDisposition: "known" };
      case "coordinate.type":
        await this.cua.type(action.text ?? "", timeoutActionOptions(action));
        return { pointerDisposition: "unchanged" };
      case "coordinate.keypress":
        await this.cua.keypress(action.key ?? "", modifierActionOptions(action));
        return { pointerDisposition: "unchanged" };
    }
  }

  #updatePointerAfterAction(action: EnvAction, execution: ActionExecutionResult): AgentPointerState | undefined {
    if (execution.point !== undefined) {
      return this.#setPointerState(
        execution.point.x,
        execution.point.y,
        action,
        execution.point.coordinateSpace ?? "visualViewport",
      );
    }
    if (execution.pointerDisposition === "stale") {
      return this.#markPointerStale(execution.staleReason ?? `${action.kind} changed cursor state without reporting a point`);
    }
    if (action.target.source !== "coordinate" || execution.pointerDisposition !== "known") return this.#pointerState;
    const x = action.target.x;
    const y = action.target.y;
    if (typeof x !== "number" || typeof y !== "number") return this.#pointerState;
    return this.#setPointerState(x, y, action, "visualViewport");
  }

  #setPointerState(
    x: number,
    y: number,
    action: EnvAction,
    coordinateSpace: AgentPointerState["coordinateSpace"],
  ): AgentPointerState {
    this.#pointerState = {
      tabId: this.id,
      ...getSessionLifecycleContext(),
      x,
      y,
      coordinateSpace,
      phase: "idle",
      buttonsDown: [],
      modifiers: action.modifiers ?? [],
      source: "agent",
      visible: true,
      updatedAt: Date.now(),
    };
    this.runtimeContext.pointerStore?.set(this.id, this.#pointerState);
    return this.#pointerState;
  }

  #markPointerStale(reason: string): AgentPointerState | undefined {
    const current = this.runtimeContext.pointerStore?.get(this.id) ?? this.#pointerState;
    if (current === undefined) return undefined;
    this.#pointerState = {
      ...current,
      ...getSessionLifecycleContext(),
      phase: "stale",
      source: "unknown",
      visible: false,
      updatedAt: Date.now(),
      staleReason: reason,
    };
    this.runtimeContext.pointerStore?.set(this.id, this.#pointerState);
    return this.#pointerState;
  }

  #consumeActionObservation(action: EnvAction, actionIdValue: string): string[] | undefined {
    const observationId = observationIdForAction(action);
    if (!observationId) return undefined;
    this.#invalidateObservation(observationId, "consumed", `used by ${action.kind}`, actionIdValue);
    return [observationId];
  }

  #invalidateObservation(
    observationId: string,
    reason: "stale" | "expired" | "consumed",
    detail: string,
    consumedByActionId?: string,
  ): ObservationLifecycle | undefined {
    const lifecycle = this.#observationStore().get(observationId);
    if (!lifecycle) return undefined;
    const invalidated: ObservationLifecycle = {
      ...lifecycle,
      state: "invalid",
      invalidatedAt: Date.now(),
      invalidity: { reason, detail },
      ...(consumedByActionId !== undefined ? { consumedByActionId } : {}),
    };
    this.#observationStore().set(observationId, invalidated);
    return invalidated;
  }

  async #validateObservationStillFresh(
    observationId: string,
    lifecycle: ObservationLifecycle,
    action: EnvAction,
  ): Promise<ObservationFreshnessResult> {
    if (lifecycle.pageStateHash !== undefined) {
      let currentHash: string;
      try {
        currentHash = await this.#currentPageStateHash(action.timeout);
      } catch (error) {
        return {
          ok: false,
          detail: `page state could not be checked: ${errorMessage(error)}`,
          data: { observationId, changed: "unknown", error: errorMessage(error) },
        };
      }
      if (currentHash !== lifecycle.pageStateHash) {
        return {
          ok: false,
          detail: "page state changed since observation",
          data: { observationId, expected: lifecycle.pageStateHash, current: currentHash, changed: "page_state" },
        };
      }
    }
    if (lifecycle.viewportRevision !== undefined || lifecycle.focusRevision !== undefined) {
      const textResult = await this.#observeSection("current.text", async () => {
        await this.#ensureObserveReadAllowed(M.TAB_SNAPSHOT_TEXT, {}, undefined, action.timeout);
        return await this.#snapshotTextForObserve(timeoutActionOptions(action));
      });
      if (!textResult.ok) {
        return {
          ok: false,
          detail: `text state could not be checked: ${textResult.error}`,
          data: { observationId, changed: "unknown", error: textResult.error },
        };
      }
      if (lifecycle.viewportRevision !== undefined) {
        const currentViewportRevision = textResult.value.viewport === undefined
          ? undefined
          : observationPageStateHash({ viewport: textResult.value.viewport });
        if (currentViewportRevision !== lifecycle.viewportRevision) {
          return {
            ok: false,
            detail: "viewport changed since observation",
            data: {
              observationId,
              expected: lifecycle.viewportRevision,
              current: currentViewportRevision,
              changed: "geometry",
            },
          };
        }
      }
      if (lifecycle.focusRevision !== undefined) {
        const currentFocusRevision = textResult.value.focus === undefined
          ? undefined
          : observationPageStateHash({ focus: textResult.value.focus });
        if (currentFocusRevision !== lifecycle.focusRevision) {
          return {
            ok: false,
            detail: "focus changed since observation",
            data: {
              observationId,
              expected: lifecycle.focusRevision,
              current: currentFocusRevision,
              changed: "focus",
            },
          };
        }
      }
    }
    if (action.target.source === "dom-cua" && lifecycle.domCuaRevision !== undefined) {
      const domResult = await this.#observeSection("current.domCua", async () => {
        await this.#ensureObserveReadAllowed(M.DOM_CUA_GET_VISIBLE_DOM, {}, undefined, action.timeout);
        return await this.transport.sendRequest<{ text?: string } & Record<string, unknown>>(
          M.DOM_CUA_GET_VISIBLE_DOM,
          withSessionMeta({ tab_id: this.id, format: "compact_text" }),
          action.timeout,
        );
      });
      if (!domResult.ok) {
        return {
          ok: false,
          detail: `DOM-CUA state could not be checked: ${domResult.error}`,
          data: { observationId, changed: "unknown", error: domResult.error },
        };
      }
      const currentDomCuaRevision = domCuaRevisionFromSnapshot(domResult.value);
      if (currentDomCuaRevision !== lifecycle.domCuaRevision) {
        return {
          ok: false,
          detail: "DOM-CUA affordance state changed since observation",
          data: {
            observationId,
            expected: lifecycle.domCuaRevision,
            current: currentDomCuaRevision,
            changed: "dom",
          },
        };
      }
    }
    return { ok: true };
  }

  async #currentPageStateHash(timeout?: number): Promise<string> {
    const urlResult = await this.#observeSection("current.url", async () => {
      const url = await this.#readCurrentUrlRaw(timeout);
      await this.guards.ensureCommandAllowed(
        { command: M.TAB_URL, tab_id: this.id },
        { currentUrl: url },
      );
      return url;
    });
    if (!urlResult.ok) {
      throw new Error(`URL state could not be checked: ${urlResult.error}`);
    }
    const titleResult = await this.#observeSection("current.title", async () => {
      await this.#ensureObserveReadAllowed(M.TAB_TITLE, {}, urlResult.value, timeout);
      return await this.transport.sendRequest<string>(
        M.TAB_TITLE,
        withSessionMeta({ tab_id: this.id }),
        timeout,
      );
    });
    if (!titleResult.ok) {
      throw new Error(`title state could not be checked: ${titleResult.error}`);
    }
    return observationPageStateHash({
      tabId: this.id,
      url: urlResult.value,
      title: titleResult.value,
      status: this.metadata.status,
      active: this.metadata.active,
      logicalActive: this.metadata.logicalActive,
      commandable: this.metadata.commandable,
    });
  }

  #observationStore(): Map<string, ObservationLifecycle> {
    return this.runtimeContext.observationStore ?? this.#localObservations;
  }

  #runtimeEpoch(): number {
    return this.runtimeContext.lifecycleEpoch?.value ?? 0;
  }

  async waitForEvent(event: "filechooser" | "download", opts: { timeout?: number } = {}): Promise<FileChooser | Download> {
    if (event === "filechooser") {
      this.#ensureCommandable(M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER);
      const command = { command: M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER, tab_id: this.id };
      const currentUrl = this.guards.needsCurrentUrl(M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER)
        ? await this.#currentUrlForGuard(opts.timeout)
        : undefined;
      await this.guards.ensureCommandAllowed(command, { currentUrl });
      const row = await this.transport.sendRequest<{ file_chooser_id: string; id?: string }>(
        M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER,
        withSessionMeta({ tab_id: this.id }),
        opts.timeout,
      );
      return new FileChooser(this.transport, row.file_chooser_id ?? row.id ?? "", this.guards, this.id);
    }
    this.#ensureCommandable(M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD);
    const currentUrl = this.guards.needsCurrentUrl(M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD)
      ? await this.#currentUrlForGuard(opts.timeout)
      : undefined;
    await this.guards.ensureCommandAllowed({ command: M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD, tab_id: this.id }, { currentUrl });
    const row = await this.transport.sendRequest<{ download_id: string; id?: string }>(
      M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
      withSessionMeta({ tab_id: this.id }),
      opts.timeout,
    );
    return new Download(this.transport, row.download_id ?? row.id ?? "", this.guards, this.id);
  }

  async #waitForNavigationFrom(
    startUrl: string,
    deadline: number,
    opts: TabNavigationWaitOptions,
    isCancelled: () => boolean,
  ): Promise<void> {
    const pollInterval = Math.max(0, opts.pollInterval ?? DEFAULT_NAVIGATION_POLL_MS);
    while (!isCancelled()) {
      const currentUrl = await this.url({ timeout: remainingMs(deadline) });
      if (currentUrl !== startUrl && navigationUrlMatches(currentUrl, opts.url)) {
        await this.waitForLoadState(opts.waitUntil ?? "load", { timeout: remainingMs(deadline) });
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`navigation timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms`);
      }
      await delay(Math.min(pollInterval, remaining));
    }
  }
}

function screenshotParams(opts: ScreenshotOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (opts.type !== undefined) params.type = opts.type;
  if (opts.quality !== undefined) params.quality = opts.quality;
  if (opts.fullPage !== undefined) params.fullPage = opts.fullPage;
  if (opts.clip !== undefined) params.clip = opts.clip;
  return params;
}

function estimatedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

async function emitMcpImage(shot: Image): Promise<boolean> {
  const nodeRepl = (globalThis as {
    nodeRepl?: { emitImage?: (image: string) => Promise<void> | void };
  }).nodeRepl;
  if (typeof nodeRepl?.emitImage !== "function") {
    return false;
  }
  await nodeRepl.emitImage(`data:${shot.mime_type};base64,${shot.data_base64}`);
  return true;
}

async function screenshotForModelResultFromRow(row: {
  data?: string;
  data_base64?: string;
  mime_type?: string;
}): Promise<ScreenshotForModelResult> {
  const shot = Image.from({
    data_base64: row.data_base64 ?? row.data ?? "",
    mime_type: row.mime_type ?? "image/jpeg",
  });
  const bytes = estimatedBase64Bytes(shot.data_base64);
  const emitted = await emitMcpImage(shot);
  if (emitted) {
    return {
      kind: "resource",
      mime_type: shot.mime_type,
      bytes,
      summary: `${bytes} byte ${shot.mime_type} screenshot emitted as an MCP resource`,
    };
  }
  return {
    kind: "inline",
    mime_type: shot.mime_type,
    data_base64: shot.data_base64,
    bytes,
  };
}

let OBSERVATION_SEQUENCE = 0;

function nextObservationSequence(): number {
  OBSERVATION_SEQUENCE = (OBSERVATION_SEQUENCE + 1) % Number.MAX_SAFE_INTEGER;
  return OBSERVATION_SEQUENCE;
}

function initialObservationSections(
  mode: TabObserveMode,
  opts: TabObserveOptions,
): TabObservation["sections"] {
  return {
    tab: { status: "present" },
    lifecycle: { status: "present" },
    viewport: { status: "omitted", reason: "not_implemented_initial_observe" },
    pointer: { status: "omitted", reason: "not_implemented_initial_observe" },
    focus: { status: "omitted", reason: "not_implemented_initial_observe" },
    text: opts.includeText === false
      ? { status: "omitted", reason: "disabled_by_options" }
      : { status: "omitted", reason: "not_read_yet" },
    domCua: (opts.includeDomCua ?? (mode === "actionable" || mode === "visual"))
      ? { status: "omitted", reason: "not_read_yet" }
      : { status: "omitted", reason: "not_requested" },
    screenshot: (opts.includeScreenshot ?? mode === "visual")
      ? { status: "omitted", reason: "not_read_yet" }
      : { status: "omitted", reason: "not_requested" },
    diagnostics: { status: "present" },
  };
}

function observationStatus(
  mode: TabObserveMode,
  sections: TabObservation["sections"],
  actionFamilies: ObservationActionFamily[],
): TabObservation["status"] {
  if (sections.tab.status === "blocked") return "blocked";
  if (sections.tab.status === "failed") return "failed";
  if (mode === "actionable") {
    const primaryFamilies = actionFamilies.filter((family) =>
      family.name === "locator" || family.name === "dom-cua" || family.name === "coordinate-cua"
    );
    if (primaryFamilies.length > 0 && primaryFamilies.every((family) => family.status === "unsupported")) {
      return "blocked";
    }
    if (
      sections.text.status === "failed"
      && sections.domCua.status === "failed"
      && sections.screenshot.status !== "present"
    ) {
      return "failed";
    }
  }
  const values = Object.values(sections);
  if (values.some((section) => section.status === "blocked")) return "partial";
  if (values.some((section) => section.status === "failed")) return "partial";
  return "succeeded";
}

function observationPageStateHash(value: Record<string, unknown>): string {
  const stable = JSON.stringify(sortRecord(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `psh_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function domCuaRevisionFromSnapshot(snapshot: unknown): string {
  if (isRecord(snapshot)) {
    if (Array.isArray(snapshot.nodes)) {
      return observationPageStateHash({ domCuaNodes: snapshot.nodes });
    }
    if (typeof snapshot.text === "string") {
      return observationPageStateHash({ domCuaText: snapshot.text });
    }
  }
  return observationPageStateHash({ domCua: snapshot });
}

export function markTabRuntimeContextStale(
  context: TabRuntimeContext,
  staleReason: string,
): void {
  const now = Date.now();
  context.lifecycleEpoch = {
    value: (context.lifecycleEpoch?.value ?? 0) + 1,
    staleReason,
    updatedAt: now,
  };
  if (context.observationStore) {
    for (const [observationId, lifecycle] of context.observationStore) {
      if (lifecycle.state !== "fresh") continue;
      context.observationStore.set(observationId, {
        ...lifecycle,
        state: "invalid",
        invalidatedAt: now,
        invalidity: { reason: "stale", detail: staleReason },
      });
    }
  }
  if (context.pointerStore) {
    const lifecycleContext = getSessionLifecycleContext();
    for (const [tabId, pointer] of context.pointerStore) {
      context.pointerStore.set(tabId, {
        ...pointer,
        ...lifecycleContext,
        phase: "stale",
        buttonsDown: [],
        source: "unknown",
        visible: false,
        updatedAt: now,
        staleReason,
      });
    }
  }
}

function sortRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecord);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== undefined) sorted[key] = sortRecord(item);
  }
  return sorted;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown error");
}

function actionResult(input: {
  actionId: string;
  action: EnvAction;
  status: ActionResult["status"];
  effect: ActionEffect;
  startedAt: number;
  pointer?: AgentPointerState | undefined;
  invalidatedObservations?: string[] | undefined;
  stateTrace?: StateTraceEntry<ActionRuntimeState>[] | undefined;
  error?: ActionResult["error"] | undefined;
}): ActionResult {
  return {
    actionId: input.actionId,
    kind: input.action.kind,
    status: input.status,
    effect: input.effect,
    ...getSessionLifecycleContext(),
    startedAt: input.startedAt,
    completedAt: Date.now(),
    ...(input.pointer !== undefined ? { pointer: input.pointer } : {}),
    ...(input.invalidatedObservations !== undefined ? { invalidatedObservations: input.invalidatedObservations } : {}),
    ...(input.stateTrace !== undefined ? { diagnostics: [{ type: "action_state_trace", states: input.stateTrace }] } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

function actionEffect(action: EnvAction): ActionEffect {
  switch (action.kind) {
    case "coordinate.move":
      return "pointer_moved";
    case "locator.click":
    case "locator.fill":
    case "locator.type":
    case "locator.press":
    case "dom_cua.click":
    case "dom_cua.type":
    case "dom_cua.scroll":
    case "dom_cua.keypress":
    case "coordinate.click":
    case "coordinate.scroll":
    case "coordinate.type":
    case "coordinate.keypress":
      return "input_dispatched";
  }
}

function actionRequiredMethod(action: EnvAction): string {
  switch (action.kind) {
    case "locator.click":
      return M.PLAYWRIGHT_LOCATOR_CLICK;
    case "locator.fill":
    case "locator.type":
      return M.PLAYWRIGHT_LOCATOR_FILL;
    case "locator.press":
      return M.PLAYWRIGHT_LOCATOR_PRESS;
    case "dom_cua.click":
      return M.DOM_CUA_CLICK;
    case "dom_cua.type":
      return M.DOM_CUA_TYPE;
    case "dom_cua.scroll":
      return M.DOM_CUA_SCROLL;
    case "dom_cua.keypress":
      return M.DOM_CUA_KEYPRESS;
    case "coordinate.click":
      return M.CUA_CLICK;
    case "coordinate.move":
      return M.CUA_MOVE;
    case "coordinate.scroll":
      return M.CUA_SCROLL;
    case "coordinate.type":
      return M.CUA_TYPE;
    case "coordinate.keypress":
      return M.CUA_KEYPRESS;
  }
}

function coordinateActionUsesPointer(action: EnvAction): boolean {
  return action.kind === "coordinate.click"
    || action.kind === "coordinate.move"
    || action.kind === "coordinate.scroll";
}

function observationIdForAction(action: EnvAction): string | undefined {
  return action.target.observationId;
}

function observationActionOptions<T extends { timeout?: number; modifiers?: string[] }>(
  action: EnvAction,
  opts: T,
): T & { observationId?: string } {
  const observationId = observationIdForAction(action);
  return observationId === undefined ? opts : { ...opts, observationId };
}

function domCuaExecutionResult(result: DomCuaActionResult | undefined): ActionExecutionResult {
  const point = actionPointFromResult(result);
  if (point !== undefined) return { point, pointerDisposition: "known" };
  return {
    pointerDisposition: "stale",
    staleReason: "DOM-CUA action executed without a reported cursor point",
  };
}

function actionPointFromResult(result: unknown): ActionExecutionPoint | undefined {
  if (!isRecord(result)) return undefined;
  const point = result.point;
  if (!isRecord(point)) return undefined;
  const x = point.x;
  const y = point.y;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    return undefined;
  }
  const coordinateSpace = point.coordinateSpace;
  return {
    x,
    y,
    ...(coordinateSpace === "layoutViewport" || coordinateSpace === "visualViewport" ? { coordinateSpace } : {}),
  };
}

function assertTarget<T extends EnvAction["target"]["source"]>(
  action: EnvAction,
  source: T,
): asserts action is EnvAction & { target: Extract<EnvAction["target"], { source: T }> } {
  if (action.target.source !== source) {
    throw new Error(`${action.kind} requires ${source} target`);
  }
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`coordinate action requires numeric ${name}`);
  }
  return value;
}

function singleKey(key: string | string[] | undefined): string {
  if (Array.isArray(key)) return key.join("+");
  return key ?? "";
}

function timeoutActionOptions(action: EnvAction): { timeout?: number } {
  return action.timeout === undefined ? {} : { timeout: action.timeout };
}

function modifierActionOptions(action: EnvAction): { timeout?: number; modifiers?: string[] } {
  const opts: { timeout?: number; modifiers?: string[] } = timeoutActionOptions(action);
  if (action.modifiers !== undefined) opts.modifiers = action.modifiers;
  return opts;
}

function mouseActionOptions(action: EnvAction): {
  timeout?: number;
  modifiers?: string[];
  button?: "left" | "right" | "middle";
} {
  const opts: { timeout?: number; modifiers?: string[]; button?: "left" | "right" | "middle" } = modifierActionOptions(action);
  if (action.button !== undefined) opts.button = action.button;
  return opts;
}

function boundedEvaluateExpression(
  expressionOrFn: string | (() => unknown),
  maxJsonBytes: number,
): string {
  const source = typeof expressionOrFn === "function"
    ? `(${expressionOrFn})()`
    : `(${expressionOrFn})`;
  return `
(async () => {
  const __obuValue = await ${source};
  const __obuNormalized = __obuValue === undefined ? null : __obuValue;
  let __obuJson;
  try {
    __obuJson = JSON.stringify(__obuNormalized);
  } catch {
    return { __obu_evaluate_summary: summarizeObuValue(__obuNormalized, null, "not_json_serializable") };
  }
  const __obuBytes = typeof TextEncoder === "function"
    ? new TextEncoder().encode(__obuJson ?? "null").length
    : (__obuJson ?? "null").length;
  if (__obuBytes > ${Math.max(1, Math.floor(maxJsonBytes))}) {
    return { __obu_evaluate_summary: summarizeObuValue(__obuNormalized, __obuBytes, "max_json_bytes") };
  }
  return { __obu_evaluate_value: __obuNormalized };

  function summarizeObuValue(value, bytes, reason) {
    if (Array.isArray(value)) return { kind: "truncated", type: "array", length: value.length, bytes, reason };
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      return { kind: "truncated", type: "object", keys: keys.slice(0, 25), key_count: keys.length, bytes, reason };
    }
    return { kind: "truncated", type: value === null ? "null" : typeof value, bytes, reason };
  }
})()
`;
}

function snapshotTextExpression(maxItems: number, maxTextLength: number): string {
  return `
(() => {
  const OBU_OVERLAY_SELECTOR = "#obu-agent-overlay-root,[data-obu-overlay-root]";
  const text = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, ${maxTextLength});
  const isObuOverlay = (el) => Boolean(el?.matches?.(OBU_OVERLAY_SELECTOR) || el?.closest?.(OBU_OVERLAY_SELECTOR));
  const take = (selector) => Array.from(document.querySelectorAll(selector)).filter((el) => !isObuOverlay(el)).slice(0, ${maxItems});
  const labelFor = (input) => {
    if (input.labels && input.labels.length) return text(input.labels[0].textContent);
    if (input.getAttribute("aria-label")) return text(input.getAttribute("aria-label"));
    return text(input.getAttribute("name") || input.getAttribute("placeholder") || "");
  };
  const active = document.activeElement && !isObuOverlay(document.activeElement)
    ? {
        tag: text(document.activeElement.tagName.toLowerCase()),
        id: text(document.activeElement.id),
        name: text(document.activeElement.getAttribute("name")),
        type: text(document.activeElement.getAttribute("type")),
        placeholder: text(document.activeElement.getAttribute("placeholder")),
        ariaLabel: text(document.activeElement.getAttribute("aria-label")),
      }
    : null;
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    focus: active,
    headings: take("h1,h2,h3").map((el) => ({ level: Number(el.tagName.slice(1)), text: text(el.textContent) })),
    buttons: take("button,[role=button],input[type=button],input[type=submit]").map((el) => text(el.textContent || el.value || el.getAttribute("aria-label"))).filter(Boolean),
    links: take("a[href]").map((el) => ({ text: text(el.textContent || el.getAttribute("aria-label")), href: text(el.href) })),
    forms: take("input,textarea,select").map((el) => ({
      label: labelFor(el),
      type: text(el.getAttribute("type") || el.tagName.toLowerCase()),
      name: text(el.getAttribute("name")),
      placeholder: text(el.getAttribute("placeholder")),
    })),
  };
})()
`;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTruncatedEvaluateSummary(value: unknown): boolean {
  return isRecord(value) && value.kind === "truncated";
}

function navigationUrlMatches(currentUrl: string, expected?: string | RegExp): boolean {
  if (expected === undefined) return true;
  return typeof expected === "string" ? currentUrl === expected : expected.test(currentUrl);
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
