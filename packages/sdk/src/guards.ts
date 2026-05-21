import { ObuError, ERR_DISALLOWED } from "./errors.js";
import * as M from "./wire/methods.js";

export type MethodClassification =
  | "always-allowed"
  | "target-url"
  | "current-origin"
  | "history"
  | "download"
  | "upload"
  | "raw-cdp"
  | "internal-lifecycle";

export type GuardContext = {
  command: string;
  classification: MethodClassification;
  tabId?: string | undefined;
  url?: string | undefined;
  params: Record<string, unknown>;
};

export const METHOD_CLASSIFICATION: Record<string, MethodClassification> = Object.freeze({
  [M.PING]: "always-allowed",
  [M.GET_INFO]: "always-allowed",
  [M.GET_TABS]: "always-allowed",
  [M.GET_CURRENT_TAB]: "always-allowed",
  [M.NAME_SESSION]: "always-allowed",
  [M.PLAYWRIGHT_WAIT_FOR_TIMEOUT]: "always-allowed",
  [M.TURN_ENDED]: "internal-lifecycle",
  [M.YIELD_CONTROL]: "internal-lifecycle",
  [M.RESUME_CONTROL]: "internal-lifecycle",
  [M.CLEAR_LIFECYCLE_DIAGNOSTICS]: "internal-lifecycle",
  [M.FINALIZE_TABS]: "internal-lifecycle",
  [M.ATTACH]: "internal-lifecycle",
  [M.DETACH]: "internal-lifecycle",
  [M.EXECUTE_UNHANDLED_COMMAND]: "internal-lifecycle",
  [M.BROWSER_VIEWPORT_SET]: "internal-lifecycle",
  [M.BROWSER_VIEWPORT_RESET]: "internal-lifecycle",
  [M.BROWSER_VISIBILITY_SET]: "internal-lifecycle",
  [M.BROWSER_VISIBILITY_GET]: "internal-lifecycle",

  [M.CREATE_TAB]: "target-url",
  [M.TAB_GOTO]: "target-url",
  [M.TAB_WAIT_FOR_URL]: "target-url",
  [M.PLAYWRIGHT_WAIT_FOR_URL]: "target-url",
  [M.BROWSER_TABS_CONTENT]: "target-url",

  [M.GET_USER_HISTORY]: "history",
  [M.GET_USER_TABS]: "history",
  [M.GET_SELECTED_TAB]: "history",
  [M.CLAIM_USER_TAB]: "history",

  [M.PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA]: "download",
  [M.CUA_DOWNLOAD_MEDIA]: "download",
  [M.DOM_CUA_DOWNLOAD_MEDIA]: "download",
  [M.PLAYWRIGHT_WAIT_FOR_DOWNLOAD]: "download",
  [M.PLAYWRIGHT_DOWNLOAD_PATH]: "download",

  [M.PLAYWRIGHT_FILE_CHOOSER_SET_FILES]: "upload",

  [M.EXECUTE_CDP]: "raw-cdp",

  [M.MOVE_MOUSE]: "current-origin",
  [M.CUA_CLICK]: "current-origin",
  [M.CUA_DBLCLICK]: "current-origin",
  [M.CUA_SCROLL]: "current-origin",
  [M.CUA_TYPE]: "current-origin",
  [M.CUA_KEYPRESS]: "current-origin",
  [M.CUA_DRAG]: "current-origin",
  [M.CUA_MOVE]: "current-origin",
  [M.DOM_CUA_GET_VISIBLE_DOM]: "current-origin",
  [M.DOM_CUA_CLICK]: "current-origin",
  [M.DOM_CUA_DOUBLE_CLICK]: "current-origin",
  [M.DOM_CUA_SCROLL]: "current-origin",
  [M.DOM_CUA_TYPE]: "current-origin",
  [M.DOM_CUA_KEYPRESS]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_CLICK]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_DBLCLICK]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_FILL]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_PRESS]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_WAIT_FOR]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_COUNT]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_SELECT_OPTION]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_SET_CHECKED]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_IS_VISIBLE]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_IS_ENABLED]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_TEXT_CONTENT]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_INNER_TEXT]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_READ_ALL]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_HOVER]: "current-origin",
  [M.PLAYWRIGHT_LOCATOR_BOUNDING_BOX]: "current-origin",
  [M.PLAYWRIGHT_SCREENSHOT]: "current-origin",
  [M.PLAYWRIGHT_DOM_SNAPSHOT]: "current-origin",
  [M.PLAYWRIGHT_WAIT_FOR_LOAD_STATE]: "current-origin",
  [M.PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER]: "current-origin",
  [M.TAB_RELOAD]: "current-origin",
  [M.TAB_BACK]: "current-origin",
  [M.TAB_FORWARD]: "current-origin",
  [M.TAB_CLOSE]: "current-origin",
  [M.TAB_SCREENSHOT]: "current-origin",
  [M.TAB_WAIT_FOR_LOAD_STATE]: "current-origin",
  [M.TAB_CONTENT_EXPORT]: "current-origin",
  [M.TAB_URL]: "current-origin",
  [M.TAB_TITLE]: "current-origin",
  [M.TAB_CLIPBOARD_READ_TEXT]: "current-origin",
  [M.TAB_CLIPBOARD_WRITE_TEXT]: "current-origin",
  [M.TAB_CLIPBOARD_READ]: "current-origin",
  [M.TAB_CLIPBOARD_WRITE]: "current-origin",
});

export const ALWAYS_ALLOWED = new Set<string>([
  ...Object.entries(METHOD_CLASSIFICATION)
    .filter(([, classification]) => classification === "always-allowed")
    .map(([method]) => method),
]);

export type GuardHooks = {
  beforeCommand?: (command: Record<string, unknown>) => void | Promise<void>;
  checkNavigation?: (url: string, context: GuardContext) => void | Promise<void>;
  checkCurrentOrigin?: (
    tabId: string,
    url: string | undefined,
    command: string,
    context: GuardContext,
  ) => void | Promise<void>;
  checkDownload?: (tabId: string | undefined, url: string | undefined, context: GuardContext) => void | Promise<void>;
  checkUpload?: (tabId: string | undefined, paths: string[], context: GuardContext) => void | Promise<void>;
  checkHistory?: (query: Record<string, unknown>, context: GuardContext) => void | Promise<void>;
  checkRawCdp?: (
    tabId: string,
    method: string,
    params: unknown,
    context: GuardContext,
  ) => void | Promise<void>;
};

export class Guards {
  constructor(private readonly hooks: GuardHooks = {}) {}

  needsCurrentUrl(command: string): boolean {
    if (guardModeDisabled()) return false;
    const classification = METHOD_CLASSIFICATION[command];
    if (classification === "current-origin") return !!this.hooks.checkCurrentOrigin;
    if (classification === "raw-cdp") return !!this.hooks.checkCurrentOrigin;
    if (classification === "download") return !!this.hooks.checkDownload;
    if (classification === "upload") return !!this.hooks.checkUpload;
    return false;
  }

  async ensureCommandAllowed(command: Record<string, unknown>, resolved?: { currentUrl?: string | undefined }): Promise<void> {
    const method = typeof command.command === "string" ? command.command : undefined;
    const classification = (method && METHOD_CLASSIFICATION[method]) || "current-origin";
    if (guardModeDisabled() || classification === "always-allowed") return;
    const context = buildContext(command, classification, resolved?.currentUrl);
    try {
      await this.ensureSemanticAllowed(command, context);
      await this.hooks.beforeCommand?.(command);
    } catch (error) {
      if (error instanceof ObuError) throw error;
      throw new ObuError(ERR_DISALLOWED, String(error ?? "command disallowed"));
    }
  }

  private async ensureSemanticAllowed(command: Record<string, unknown>, context: GuardContext): Promise<void> {
    switch (context.classification) {
      case "target-url":
        if (typeof context.url === "string") await this.hooks.checkNavigation?.(context.url, context);
        return;
      case "current-origin":
        if (context.tabId) {
          await this.hooks.checkCurrentOrigin?.(context.tabId, context.url, context.command, context);
        }
        return;
      case "history":
        await this.hooks.checkHistory?.(command, context);
        return;
      case "download":
        await this.hooks.checkDownload?.(context.tabId, context.url, context);
        return;
      case "upload":
        await this.hooks.checkUpload?.(context.tabId, normalizePaths(command.paths), context);
        return;
      case "raw-cdp": {
        const cdpMethod = typeof command.method === "string" ? command.method : "";
        if (!context.tabId) throw new Error("raw CDP command missing tab id");
        await this.hooks.checkCurrentOrigin?.(context.tabId, context.url, context.command, context);
        const navigationUrl = rawCdpNavigationUrl(command);
        if (navigationUrl) {
          await this.hooks.checkNavigation?.(navigationUrl, { ...context, url: navigationUrl });
        }
        await this.hooks.checkRawCdp?.(context.tabId, cdpMethod, command.commandParams, context);
        return;
      }
      case "internal-lifecycle":
      case "always-allowed":
        return;
    }
  }
}

function buildContext(
  command: Record<string, unknown>,
  classification: MethodClassification,
  currentUrl: string | undefined,
): GuardContext {
  const method = typeof command.command === "string" ? command.command : "";
  const target = isRecord(command.target) ? command.target : undefined;
  const tabId = stringifyId(command.tab_id ?? command.tabId ?? target?.tabId);
  const url = currentUrl ?? (typeof command.url === "string" ? command.url : undefined);
  return {
    command: method,
    classification,
    tabId,
    url,
    params: command,
  };
}

function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stringifyId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return undefined;
}

function rawCdpNavigationUrl(command: Record<string, unknown>): string | undefined {
  const params = isRecord(command.commandParams)
    ? command.commandParams
    : isRecord(command.params)
      ? command.params
      : undefined;
  return typeof params?.url === "string" ? params.url : undefined;
}

function guardModeDisabled(): boolean {
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.OBU_GUARD_MODE === "disabled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
