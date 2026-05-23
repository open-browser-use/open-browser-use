import {
  activeOverlayState,
  overlayTakeoverState,
  parseCursorArrival,
  planContentScriptPreparation,
  planCursorArrival,
  planOverlayActivation,
  planOverlayReleaseRequest,
  planOverlayReleaseResult,
  planOverlayReplacement,
  releasePendingOverlayState,
  type OverlayCursorTarget,
  type OverlayLifecycleState,
  type OverlayTakeoverState,
} from "./lifecycle/overlay_machine.js";

const CURSOR_ARRIVAL_TIMEOUT_MS = 750;
const CONTENT_PING_TIMEOUT_MS = 1_000;
const CONTENT_SCRIPT_HANDLER = "__OBU_CURSOR_CONTENT_SCRIPT_HANDLE_MESSAGE__";

export type PendingExtensionUpdateTrigger =
  | "background_bootstrap"
  | "browser_tabs_cleaned"
  | "content_script_prepared"
  | "control_stopped"
  | "cursor_arrival_cancelled"
  | "cursor_arrival_timeout"
  | "cursor_arrived"
  | "cursor_waiters_rejected"
  | "native_hello_ack"
  | "status_changed"
  | "tab_removed"
  | "tabs_finalized"
  | "unavailable_host"
  | "update_available";

export type SessionParams = {
  session_id: string;
  turn_id: string;
};

export type CursorVisualEvent = {
  kind: "press" | "release" | "click";
  x?: number;
  y?: number;
  button?: string;
  clickCount: number;
};

export type CdpInputBypass = {
  durationMs: number;
  reason: string;
  eventFamilies: InputBypassEventFamily[];
};

export type InputBypassEventFamily = "pointer" | "wheel" | "touch" | "keyboard" | "text";

export type CursorTarget = OverlayCursorTarget;

export type OverlayReleaseDiagnostic = {
  tabId: number;
  state: "release_pending" | "release_failed";
  failures?: number;
  sessionId: string;
  turnId: string;
};

type CursorArrivalWaiter = {
  tabId: number;
  sessionId: string;
  turnId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: boolean): void;
};

type ActiveTakeover = OverlayTakeoverState;
type OverlayState = OverlayLifecycleState;

type FrameScope = "all" | "top";

export class OverlayCoordinator {
  private nextCursorSequence = 1;
  private nextCaptureSuppression = 1;
  private cursorArrivalWaiters = new Map<number, CursorArrivalWaiter>();
  private overlayStates = new Map<number, OverlayState>();
  private contentScriptPreparations = new Map<number, Promise<boolean>>();

  constructor(
    private readonly onPendingUpdateTrigger: (trigger: PendingExtensionUpdateTrigger) => void,
  ) {}

  async activate(
    tabId: number,
    sessionParams: SessionParams,
    savedCursor?: CursorTarget,
    options: { rehydrateCursor?: boolean } = {},
  ): Promise<void> {
    const plan = planOverlayActivation({
      previous: overlayTakeoverState(this.overlayStates.get(tabId)),
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
      savedCursor,
      rehydrateCursor: options.rehydrateCursor !== false,
    });
    this.overlayStates.set(tabId, activeOverlayState(plan.state));
    await this.sendTakeoverState(tabId, plan.state);
    if (plan.sendSavedCursor) await this.sendSavedCursor(tabId, plan.state);
  }

  async reassert(tabId: number): Promise<void> {
    const current = this.overlayStates.get(tabId);
    const state = current?.kind === "active" ? current.takeover : undefined;
    if (!state) return;
    if (!await this.sendTakeoverState(tabId, state)) return;
    if (!state.lastCursor) return;
    await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_MOVE",
      x: state.lastCursor.x,
      y: state.lastCursor.y,
      sequence: state.lastCursor.sequence,
      sessionId: state.sessionId,
      turnId: state.turnId,
    }, { frameScope: "top" });
  }

  forget(tabId: number): void {
    this.overlayStates.delete(tabId);
    this.rejectWaitersForTab(tabId);
  }

  activeTabIds(): number[] {
    return [...this.overlayStates.keys()];
  }

  async syncForeground(): Promise<void> {
    for (const [tabId, state] of [...this.overlayStates]) {
      if (state.kind === "release_pending" || state.kind === "release_failed") {
        await this.hide(tabId);
      } else if (await this.isTabVisible(tabId)) {
        await this.reassert(tabId);
      } else {
        await this.hide(tabId);
      }
    }
  }

  async replaceTabId(removedTabId: number, addedTabId: number): Promise<void> {
    const previous = this.overlayStates.get(removedTabId);
    const plan = planOverlayReplacement(overlayTakeoverState(previous));
    this.overlayStates.delete(removedTabId);
    this.rejectWaitersForTab(removedTabId);
    if (plan.kind === "drop") return;
    this.overlayStates.set(
      addedTabId,
      previous?.kind === "release_pending" || previous?.kind === "release_failed"
        ? releasePendingOverlayState(plan.state)
        : activeOverlayState(plan.state),
    );
    if (previous?.kind === "release_pending" || previous?.kind === "release_failed") {
      await this.hide(addedTabId);
    } else {
      await this.reassert(addedTabId);
    }
  }

  hasPendingActivity(): boolean {
    return this.cursorArrivalWaiters.size > 0
      || this.contentScriptPreparations.size > 0
      || [...this.overlayStates.values()].some((state) => state.kind === "release_pending" || state.kind === "release_failed");
  }

  releaseDiagnostics(): OverlayReleaseDiagnostic[] {
    const diagnostics = [];
    for (const [tabId, state] of this.overlayStates) {
      if (state.kind !== "release_pending" && state.kind !== "release_failed") continue;
      diagnostics.push({
        tabId,
        state: state.kind,
        ...(state.kind === "release_failed" ? { failures: state.failures } : {}),
        sessionId: state.takeover.sessionId,
        turnId: state.takeover.turnId,
      });
    }
    return diagnostics;
  }

  async moveMouse(tabId: number, sessionParams: SessionParams, x: number, y: number): Promise<unknown> {
    const visible = await this.isTabVisible(tabId);
    if (!visible) return { visible: false };
    await this.activate(tabId, sessionParams, undefined, { rehydrateCursor: false });

    const sequence = this.nextCursorSequence++;
    const arrival = this.waitForArrival(tabId, sequence, sessionParams);
    const sent = await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_MOVE",
      x,
      y,
      sequence,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
    }, { frameScope: "top" });
    if (!sent) {
      this.cancelArrival(sequence, false);
      return { visible: false };
    }
    this.rememberCursorTarget(tabId, { x, y, sequence });
    const arrived = await arrival;
    return { visible: true, arrived, sequence };
  }

  async sendCursorEvent(tabId: number, sessionParams: SessionParams, event: CursorVisualEvent): Promise<void> {
    await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_EVENT",
      kind: event.kind,
      x: event.x,
      y: event.y,
      button: event.button,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
    }, { frameScope: "top" });
  }

  async allowCdpInput(tabId: number, sessionParams: SessionParams, bypass: CdpInputBypass): Promise<void> {
    await this.sendContentMessage(tabId, {
      type: "OBU_INPUT_BYPASS",
      durationMs: bypass.durationMs,
      eventFamilies: bypass.eventFamilies,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
      reason: bypass.reason,
    });
  }

  async withCaptureSuppressed<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const token = `capture-${Date.now()}-${this.nextCaptureSuppression++}`;
    const suppressed = await this.sendContentMessage(tabId, {
      type: "OBU_CAPTURE_SUPPRESSION",
      active: true,
      token,
    }, { frameScope: "top" });
    if (!suppressed) {
      throw new Error("Page.captureScreenshot could not suppress the open-browser-use overlay");
    }
    try {
      return await operation();
    } finally {
      await this.sendContentMessage(tabId, {
        type: "OBU_CAPTURE_SUPPRESSION",
        active: false,
        token,
      }, { frameScope: "top" });
    }
  }

  handleCursorArrived(message: unknown): void {
    const arrival = parseCursorArrival(message);
    const waiter = arrival ? this.cursorArrivalWaiters.get(arrival.sequence) : undefined;
    const plan = planCursorArrival(arrival, waiter);
    if (plan.kind === "ignore" || !waiter) return;
    this.cursorArrivalWaiters.delete(plan.sequence);
    clearTimeout(waiter.timer);
    waiter.resolve(true);
    this.onPendingUpdateTrigger("cursor_arrived");
  }

  async hide(tabId: number): Promise<void> {
    const plan = planOverlayReleaseRequest(this.overlayStates.get(tabId));
    if (plan.kind === "send_hide") this.overlayStates.set(tabId, plan.next);
    const sent = await this.sendContentMessage(tabId, { type: "OBU_CURSOR_HIDE" }, { prepare: false });
    if (plan.kind === "noop") return;
    const next = planOverlayReleaseResult(plan.next, sent);
    if (next) {
      this.overlayStates.set(tabId, next);
      return;
    }
    this.overlayStates.delete(tabId);
    this.rejectWaitersForTab(tabId);
  }

  private async sendTakeoverState(tabId: number, state: ActiveTakeover): Promise<boolean> {
    return await this.sendContentMessage(tabId, {
      type: "OBU_TAKEOVER_STATE",
      active: true,
      lockInputs: state.lockInputs,
      sessionId: state.sessionId,
      turnId: state.turnId,
      reason: "browser-control",
    });
  }

  private async sendSavedCursor(tabId: number, state: ActiveTakeover): Promise<void> {
    if (!state.lastCursor) return;
    await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_MOVE",
      x: state.lastCursor.x,
      y: state.lastCursor.y,
      sequence: state.lastCursor.sequence,
      sessionId: state.sessionId,
      turnId: state.turnId,
    }, { frameScope: "top" });
  }

  private async sendContentMessage(
    tabId: number,
    message: unknown,
    options: { prepare?: boolean; frameScope?: FrameScope } = {},
  ): Promise<boolean> {
    if (options.prepare !== false && !await this.prepareContentScript(tabId)) return false;
    try {
      const target = options.frameScope === "top"
        ? { tabId, frameIds: [0] }
        : { tabId, allFrames: true };
      const results = await chrome.scripting.executeScript({
        target,
        world: "ISOLATED",
        args: [CONTENT_SCRIPT_HANDLER, message],
        func: (handlerName: string, payload: unknown) => {
          const handler = (globalThis as Record<string, unknown>)[handlerName];
          if (typeof handler !== "function") return false;
          handler(payload);
          return true;
        },
      });
      return results.some((result) => result.result === true);
    } catch {
      return false;
    }
  }

  private async prepareContentScript(tabId: number): Promise<boolean> {
    const pingSucceeded = await this.pingContentScript(tabId);
    let pending = this.contentScriptPreparations.get(tabId);
    const plan = planContentScriptPreparation({
      pingSucceeded,
      preparationPending: pending !== undefined,
    });
    if (plan.kind === "ready") return true;
    if (plan.kind === "await_pending" && pending) return await pending;
    if (plan.kind === "inject") {
      pending = this.injectContentScript(tabId).finally(() => {
        this.contentScriptPreparations.delete(tabId);
        this.onPendingUpdateTrigger("content_script_prepared");
      });
      this.contentScriptPreparations.set(tabId, pending);
    }
    return pending ? await pending : false;
  }

  private async pingContentScript(tabId: number): Promise<boolean> {
    try {
      const response = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: "OBU_CONTENT_PING" }),
        CONTENT_PING_TIMEOUT_MS,
      );
      return isRecord(response) && response.ok === true;
    } catch {
      return false;
    }
  }

  private async injectContentScript(tabId: number): Promise<boolean> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        injectImmediately: true,
        world: "ISOLATED",
        files: ["cursor.js"],
      });
      return await this.pingContentScript(tabId);
    } catch {
      return false;
    }
  }

  private waitForArrival(tabId: number, sequence: number, sessionParams: SessionParams): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.cursorArrivalWaiters.has(sequence)) return;
        this.cursorArrivalWaiters.delete(sequence);
        resolve(false);
        this.onPendingUpdateTrigger("cursor_arrival_timeout");
      }, CURSOR_ARRIVAL_TIMEOUT_MS);
      this.cursorArrivalWaiters.set(sequence, {
        tabId,
        sessionId: sessionParams.session_id,
        turnId: sessionParams.turn_id,
        timer,
        resolve,
      });
    });
  }

  private cancelArrival(sequence: number, value: boolean): void {
    const waiter = this.cursorArrivalWaiters.get(sequence);
    if (!waiter) return;
    this.cursorArrivalWaiters.delete(sequence);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
    this.onPendingUpdateTrigger("cursor_arrival_cancelled");
  }

  private rejectWaitersForTab(tabId: number): void {
    for (const [sequence, waiter] of this.cursorArrivalWaiters) {
      if (waiter.tabId !== tabId) continue;
      this.cursorArrivalWaiters.delete(sequence);
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.onPendingUpdateTrigger("cursor_waiters_rejected");
  }

  private rememberCursorTarget(tabId: number, cursor: CursorTarget): void {
    const state = this.overlayStates.get(tabId);
    if (state?.kind === "active") state.takeover.lastCursor = cursor;
  }

  private async isTabVisible(tabId: number): Promise<boolean> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.active !== true || typeof tab.windowId !== "number") return false;
      const windowInfo = await chrome.windows.get(tab.windowId);
      return windowInfo.type === "normal" && windowInfo.state !== "minimized";
    } catch {
      return false;
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
