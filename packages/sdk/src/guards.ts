import { ObuError, ERR_DISALLOWED } from "./errors.js";
import { METHOD_CLASSIFICATION } from "./wire/method-policy.js";

export { METHOD_CLASSIFICATION };

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

export type CommandabilityGuard = (method: string) => void;

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
