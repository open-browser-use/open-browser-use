import type { SessionParams } from "./overlay_coordinator.js";
import { requireTabWindowId } from "./tab_group_manager.js";

type DebugLogLevel = "debug" | "info" | "warn" | "error";

type BrowserCommandTab = {
  tabId: number;
  tab: ChromeTab;
};

type ChromeWindowUpdateInfo = {
  state?: ChromeWindow["state"];
  focused?: boolean;
};

type BrowserCapabilityControllerOptions = {
  requireCurrentSessionTabForBrowserCommand(
    sessionParams: SessionParams,
    operation: string,
  ): Promise<BrowserCommandTab>;
  ensureDebuggerAttached(sessionId: string, tabId: number): Promise<void>;
  sendDebuggerCommand(tabId: number, method: string, commandParams?: unknown): Promise<unknown>;
  updateWindow(windowId: number, updateInfo: ChromeWindowUpdateInfo): Promise<ChromeWindow>;
  getWindow(windowId: number): Promise<ChromeWindow>;
  appendDebugLog(level: DebugLogLevel, event: string, data?: unknown): void;
};

export class BrowserCapabilityController {
  constructor(private readonly options: BrowserCapabilityControllerOptions) {}

  async setViewport(sessionParams: SessionParams, params: unknown): Promise<unknown> {
    const { tabId } = await this.options.requireCurrentSessionTabForBrowserCommand(
      sessionParams,
      "browser viewport set",
    );
    const width = requiredPositiveInteger(params, "width", 1, 16_384);
    const height = requiredPositiveInteger(params, "height", 1, 16_384);
    const deviceScaleFactor = optionalFiniteNumber(params, "deviceScaleFactor", 1, 0.1, 8);
    const mobile = isRecord(params) && params.mobile === true;
    await this.options.ensureDebuggerAttached(sessionParams.session_id, tabId);
    await this.options.sendDebuggerCommand(tabId, "Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
    this.options.appendDebugLog("info", "browser.viewport.set", {
      sessionId: sessionParams.session_id,
      tabId,
      width,
      height,
    });
    return { width, height, deviceScaleFactor, mobile, tabId };
  }

  async resetViewport(sessionParams: SessionParams): Promise<unknown> {
    const { tabId } = await this.options.requireCurrentSessionTabForBrowserCommand(
      sessionParams,
      "browser viewport reset",
    );
    await this.options.ensureDebuggerAttached(sessionParams.session_id, tabId);
    await this.options.sendDebuggerCommand(tabId, "Emulation.clearDeviceMetricsOverride", {});
    this.options.appendDebugLog("info", "browser.viewport.reset", { sessionId: sessionParams.session_id, tabId });
    return { reset: true, tabId };
  }

  async setVisibility(sessionParams: SessionParams, params: unknown): Promise<unknown> {
    const { tab } = await this.options.requireCurrentSessionTabForBrowserCommand(
      sessionParams,
      "browser visibility set",
    );
    const visible = requiredBoolean(params, "visible");
    const focus = isRecord(params) ? params.focused !== false : true;
    const windowId = requireTabWindowId(tab);
    const updateProperties: ChromeWindowUpdateInfo = visible
      ? { state: "normal", focused: focus }
      : { state: "minimized" };
    const windowInfo = await this.options.updateWindow(windowId, updateProperties)
      ?? await this.options.getWindow(windowId);
    this.options.appendDebugLog("info", "browser.visibility.set", {
      sessionId: sessionParams.session_id,
      windowId,
      visible,
      focused: windowInfo.focused === true,
      state: windowInfo.state,
    });
    return browserVisibilityDto(windowInfo);
  }

  async getVisibility(sessionParams: SessionParams): Promise<unknown> {
    const { tab } = await this.options.requireCurrentSessionTabForBrowserCommand(
      sessionParams,
      "browser visibility get",
    );
    return browserVisibilityDto(await this.options.getWindow(requireTabWindowId(tab)));
  }
}

function browserVisibilityDto(windowInfo: ChromeWindow): {
  visible: boolean;
  focused: boolean;
  windowId?: number;
  state?: ChromeWindow["state"];
} {
  return {
    visible: windowInfo.state !== "minimized",
    focused: windowInfo.focused === true,
    windowId: windowInfo.id,
    state: windowInfo.state,
  };
}

function requiredNumber(params: unknown, key: string): number {
  if (!isRecord(params) || typeof params[key] !== "number") throw new Error(`${key} must be a number`);
  return params[key];
}

function requiredBoolean(params: unknown, key: string): boolean {
  if (!isRecord(params) || typeof params[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  return params[key];
}

function requiredPositiveInteger(params: unknown, key: string, min: number, max: number): number {
  const value = requiredNumber(params, key);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalFiniteNumber(params: unknown, key: string, fallback: number, min: number, max: number): number {
  const value = isRecord(params) ? params[key] : undefined;
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
