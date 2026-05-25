import type {
  CdpInputBypass,
  CursorTarget,
  CursorVisualEvent,
  SessionParams,
} from "./overlay_coordinator.js";
import type { BrowserSession, SessionTab } from "./session_store.js";
import {
  cdpCursorEventFromParams,
  cdpInputBypassFromParams,
  shouldSuppressAgentOverlayForCdpCapture,
} from "./lifecycle/cdp_input_machine.js";

type DebugLogLevel = "debug" | "info" | "warn" | "error";

type BrowserDebuggerControllerOptions = {
  sessionFor(sessionId: string): BrowserSession;
  requireSessionTab(sessionParams: SessionParams, tabId: number): SessionTab;
  attachDebugger(tabId: number): Promise<void>;
  detachDebugger(tabId: number): Promise<void>;
  // `sessionId` (Chrome 125+) routes the command to a flattened child target
  // (e.g. an out-of-process iframe) under the tab's debugger connection.
  sendDebuggerCommand(tabId: number, method: string, commandParams?: unknown, sessionId?: string): Promise<unknown>;
  activateOverlay(tabId: number, sessionParams: SessionParams, savedCursor?: CursorTarget): Promise<void>;
  allowCdpInput(tabId: number, sessionParams: SessionParams, bypass: CdpInputBypass): Promise<void>;
  sendCursorEvent(tabId: number, sessionParams: SessionParams, event: CursorVisualEvent): Promise<void>;
  withCaptureSuppressed<T>(tabId: number, operation: () => Promise<T>): Promise<T>;
  moveMouse(tabId: number, sessionParams: SessionParams, x: number, y: number): Promise<unknown>;
  persistSessionState(): Promise<void>;
  appendDebugLog(level: DebugLogLevel, event: string, data?: unknown): void;
};

export class BrowserDebuggerController {
  private readonly attachLocks = new Map<number, Promise<void>>();

  constructor(private readonly options: BrowserDebuggerControllerOptions) {}

  lockCount(): number {
    return this.attachLocks.size;
  }

  async attachDebugger(params: unknown): Promise<void> {
    const sessionParams = requireSessionParams(params);
    const tabId = requireTabId(params);
    this.options.requireSessionTab(sessionParams, tabId);
    await this.ensureDebuggerAttached(sessionParams.session_id, tabId);
    this.options.appendDebugLog("debug", "debugger.attach.requested", { tabId });
  }

  async detachDebugger(params: unknown): Promise<void> {
    const sessionParams = requireSessionParams(params);
    const tabId = requireTabId(params);
    const session = this.options.sessionFor(sessionParams.session_id);
    this.options.requireSessionTab(sessionParams, tabId);
    if (!session.attachedTabIds.has(tabId)) return;
    await this.withDebuggerLock(tabId, async () => {
      if (!session.attachedTabIds.has(tabId)) return;
      await this.options.detachDebugger(tabId);
      session.attachedTabIds.delete(tabId);
    });
    this.options.appendDebugLog("debug", "debugger.detach.requested", { tabId });
  }

  async ensureDebuggerAttached(sessionId: string, tabId: number): Promise<void> {
    const session = this.options.sessionFor(sessionId);
    if (session.attachedTabIds.has(tabId)) return;
    await this.withDebuggerLock(tabId, async () => {
      if (session.attachedTabIds.has(tabId)) return;
      await this.options.attachDebugger(tabId);
      session.attachedTabIds.add(tabId);
    });
  }

  async attachDebuggerTarget(tabId: number): Promise<void> {
    await this.withDebuggerLock(tabId, async () => {
      await this.options.attachDebugger(tabId);
    });
  }

  async detachDebuggerTarget(tabId: number): Promise<void> {
    await this.withDebuggerLock(tabId, async () => {
      await this.options.detachDebugger(tabId);
    });
  }

  async executeCdp(params: unknown): Promise<unknown> {
    const sessionParams = requireSessionParams(params);
    const tabId = requireTabId(params);
    const row = this.options.requireSessionTab(sessionParams, tabId);
    await this.ensureDebuggerAttached(sessionParams.session_id, tabId);
    if (!isRecord(params) || typeof params.method !== "string") {
      throw new Error("executeCdp requires method");
    }
    const method = params.method;
    // A `target.sessionId` routes this command to a flattened OOPIF child session
    // (Chrome 125+) rather than the tab's top-level session.
    const sessionId = oopifSessionIdFromParams(params);
    const timeoutMs = timeoutMsFromParams(params);
    const suppressAgentOverlayForCapture = shouldSuppressAgentOverlayForCdpCapture(params);
    this.options.appendDebugLog("debug", "cdp.execute", { method, tabId, sessionId, timeoutMs });
    await this.options.activateOverlay(tabId, sessionParams, row.lastCursor);
    const inputBypass = cdpInputBypassFromParams(params);
    if (inputBypass) {
      await this.options.allowCdpInput(tabId, sessionParams, inputBypass);
    }
    const cursorEvent = cdpCursorEventFromParams(params);
    if (cursorEvent?.kind === "press") {
      await this.options.sendCursorEvent(tabId, sessionParams, cursorEvent);
    }
    const sendCommand = () => withTimeout(
      this.options.sendDebuggerCommand(tabId, method, params.commandParams, sessionId),
      timeoutMs,
      `executeCdp ${method} timed out after ${timeoutMs}ms`,
    );
    const result = suppressAgentOverlayForCapture
      ? await this.options.withCaptureSuppressed(tabId, sendCommand)
      : await sendCommand();
    if (cursorEvent && cursorEvent.kind !== "press") {
      await this.options.sendCursorEvent(tabId, sessionParams, cursorEvent);
      if (cursorEvent.kind === "release" && cursorEvent.clickCount > 0) {
        await this.options.sendCursorEvent(tabId, sessionParams, { ...cursorEvent, kind: "click" });
      }
    }
    if (typeof cursorEvent?.x === "number" && typeof cursorEvent.y === "number") {
      row.lastCursor = { x: cursorEvent.x, y: cursorEvent.y };
      await this.options.persistSessionState();
    }
    return result;
  }

  async moveMouse(params: unknown): Promise<unknown> {
    const sessionParams = requireSessionParams(params);
    const tabId = requireTabId(params);
    const row = this.options.requireSessionTab(sessionParams, tabId);
    const x = requiredNumber(params, "x");
    const y = requiredNumber(params, "y");
    const result = await this.options.moveMouse(tabId, sessionParams, x, y);
    if (isRecord(result) && result.visible === true) {
      row.lastCursor = { x, y, sequence: typeof result.sequence === "number" ? result.sequence : undefined };
      await this.options.persistSessionState();
    }
    this.options.appendDebugLog("debug", "cursor.move", { tabId, result });
    return result;
  }

  private async withDebuggerLock(tabId: number, operation: () => Promise<void>): Promise<void> {
    const previous = this.attachLocks.get(tabId) ?? Promise.resolve();
    const current = (async () => {
      await previous.catch(() => undefined);
      await operation();
    })();
    this.attachLocks.set(tabId, current);
    try {
      await current;
    } finally {
      if (this.attachLocks.get(tabId) === current) {
        this.attachLocks.delete(tabId);
      }
    }
  }
}

function requireSessionParams(params: unknown): SessionParams {
  if (!isRecord(params)) throw new Error("request params must be an object");
  const sessionId = params.session_id;
  const turnId = params.turn_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Missing required browser session_id");
  }
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new Error("Missing required browser turn_id");
  }
  return { session_id: sessionId, turn_id: turnId };
}

function requireTabId(params: unknown): number {
  if (!isRecord(params)) throw new Error("request params must be an object");
  const direct = params.tabId;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  const target = isRecord(params.target) ? params.target.tabId : undefined;
  if (typeof target === "number" && Number.isInteger(target)) return target;
  throw new Error("tabId must be an integer");
}

/// The optional OOPIF child `sessionId` carried in `params.target`, or undefined
/// for a top-level command. The host adds it to route into an out-of-process
/// iframe; the extension passes it straight to `chrome.debugger.sendCommand`.
function oopifSessionIdFromParams(params: unknown): string | undefined {
  if (!isRecord(params) || !isRecord(params.target)) return undefined;
  const sessionId = params.target.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function requiredNumber(params: unknown, key: string): number {
  if (!isRecord(params) || typeof params[key] !== "number") throw new Error(`${key} must be a number`);
  return params[key];
}

function timeoutMsFromParams(params: unknown): number {
  const raw = isRecord(params) ? params.timeoutMs : undefined;
  return clampNumber(raw, 30_000, 1, 5 * 60_000);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = "native host request timed out"): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
