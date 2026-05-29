import type { SessionTab, TabOrigin } from "./session.js";

export type FinalizeKeepStatus = Extract<SessionTab["status"], "handoff" | "deliverable">;

export type FinalizeDesiredStatus = "close" | "release" | "handoff" | "deliverable";

export type FinalizeTabOutcome =
  | "closed"
  | "released"
  | "kept_handoff"
  | "kept_deliverable"
  | "tab_gone"
  | "failed"
  | "not_attempted";

export type FinalizeTabAction = {
  tabId: number;
  origin: TabOrigin;
  desiredStatus: FinalizeDesiredStatus;
  outcome: FinalizeTabOutcome;
  errorCode?: string;
  errorMessage?: string;
};

export type FinalizeTabFailure = {
  tabId?: number;
  desiredStatus?: FinalizeDesiredStatus;
  outcome: Extract<FinalizeTabOutcome, "failed" | "not_attempted">;
  errorCode: string;
  errorMessage: string;
};

export type FinalizeTabEffect =
  | "close_agent_tab"
  | "release_user_tab"
  | "keep_handoff"
  | "keep_deliverable";

export type FinalizeTabPlanStep = {
  tabId: number;
  row: SessionTab;
  origin: TabOrigin;
  desiredStatus: FinalizeDesiredStatus;
  effect: FinalizeTabEffect;
};

export type FinalizeTabsPlan = {
  steps: FinalizeTabPlanStep[];
  /** Keep tabIds that matched no tab owned by the session (audit §4.10). */
  unknownKeepTabIds: number[];
};

export function parseFinalizeKeep(params: unknown): Map<number, FinalizeKeepStatus> {
  const keep = new Map<number, FinalizeKeepStatus>();
  if (!isRecord(params)) return keep;
  // Distinguish absent (legitimate "keep nothing") from present-but-malformed.
  // A non-array `keep` previously coerced to `[]`, silently triggering the
  // destructive default finalize (agent tabs closed, user tabs released).
  const rawKeep = params.keep;
  if (rawKeep !== undefined && !Array.isArray(rawKeep)) {
    throw new Error("finalizeTabs.keep must be an array");
  }
  const rows = Array.isArray(rawKeep) ? rawKeep : [];
  for (const row of rows) {
    if (!isRecord(row)) throw new Error("finalizeTabs.keep entries must be objects");
    const tabId = requireTabId(row);
    const status = row.status;
    if (status !== "handoff" && status !== "deliverable") {
      throw new Error("finalizeTabs.keep status must be handoff or deliverable");
    }
    if (keep.has(tabId)) throw new Error(`finalizeTabs.keep contains duplicate tab ${tabId}`);
    keep.set(tabId, status);
  }
  return keep;
}

export function planFinalizeTabs(
  tabs: Iterable<[number, SessionTab]>,
  keep: ReadonlyMap<number, FinalizeKeepStatus>,
): FinalizeTabsPlan {
  const steps: FinalizeTabPlanStep[] = [];
  const ownedTabIds = new Set<number>();
  for (const [tabId, row] of tabs) {
    ownedTabIds.add(tabId);
    const desiredStatus = keep.get(tabId) ?? defaultDesiredStatus(row.origin);
    steps.push({
      tabId,
      row,
      origin: row.origin,
      desiredStatus,
      effect: effectForDesiredStatus(desiredStatus),
    });
  }
  const unknownKeepTabIds = [...keep.keys()].filter((tabId) => !ownedTabIds.has(tabId));
  return { steps, unknownKeepTabIds };
}

export function finalizeAction(
  tabId: number,
  origin: TabOrigin,
  desiredStatus: FinalizeDesiredStatus,
  outcome: FinalizeTabOutcome,
  errorCode?: string,
  errorMessage?: string,
): FinalizeTabAction {
  return {
    tabId,
    origin,
    desiredStatus,
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

export function finalizeFailure(
  tabId: number | undefined,
  desiredStatus: FinalizeDesiredStatus | undefined,
  outcome: Extract<FinalizeTabOutcome, "failed" | "not_attempted">,
  error: unknown,
  fallbackCode = "failed_to_finalize",
): FinalizeTabFailure {
  const errorCode = finalizeErrorCode(error, fallbackCode);
  return {
    ...(tabId !== undefined ? { tabId } : {}),
    ...(desiredStatus !== undefined ? { desiredStatus } : {}),
    outcome,
    errorCode,
    errorMessage: errorMessage(error),
  };
}

function defaultDesiredStatus(origin: TabOrigin): FinalizeDesiredStatus {
  return origin === "agent" ? "close" : "release";
}

function effectForDesiredStatus(desiredStatus: FinalizeDesiredStatus): FinalizeTabEffect {
  switch (desiredStatus) {
    case "close":
      return "close_agent_tab";
    case "release":
      return "release_user_tab";
    case "handoff":
      return "keep_handoff";
    case "deliverable":
      return "keep_deliverable";
  }
}

function finalizeErrorCode(error: unknown, fallbackCode: string): string {
  const message = errorMessage(error);
  if (/dialog_requires_decision/i.test(message)) return "dialog_requires_decision";
  if (/disallowed|forbidden|denied/i.test(message)) return "command_disallowed";
  return fallbackCode;
}

function requireTabId(params: unknown): number {
  // Accept both casings at both nesting levels: `tabId` is the in-process/camelCase
  // form, `tab_id` is the JSON wire/snake_case form; either may sit at the top level
  // or nested under a `target` command-envelope (e.g. { target: { tabId } }).
  if (!isRecord(params)) throw new Error("request params must be an object");
  const direct = params.tabId ?? params.tab_id;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  const target = isRecord(params.target) ? params.target.tabId ?? params.target.tab_id : undefined;
  if (typeof target === "number" && Number.isInteger(target)) return target;
  throw new Error("tabId must be an integer");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
