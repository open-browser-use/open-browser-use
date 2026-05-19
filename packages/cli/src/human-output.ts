import type { AggregateDoctorReport } from "./doctor.js";
import type { DoctorCheck, DoctorReport } from "./doctor-browser.js";
import type { ExtensionUpdateResult } from "./extension-update.js";
import type { InstallHostAction } from "./native-host.js";
import type { SetupJson } from "./setup.js";

type NextAction = SetupJson["nextActions"][number];
type DoctorLike = DoctorReport | AggregateDoctorReport;

export function formatSetupSummary(report: SetupJson): string {
  const rows: string[] = [];
  if (report.dryRun) {
    rows.push("Setup dry run: no changes made.");
    if (report.result === "failed") {
      rows.push(...formatFailedSteps(report.steps));
    } else {
      rows.push(formatPlannedChanges(report.steps));
    }
  } else if (report.result === "complete") {
    rows.push("Setup complete.");
  } else if (report.result === "manual_action_required") {
    rows.push(`Setup needs ${plural(countManualFollowUps(report.steps) || 1, "follow-up step")}.`);
  } else {
    rows.push("Setup failed.");
    rows.push(...formatFailedSteps(report.steps));
  }
  rows.push(...formatNextActions(report.nextActions, report.dryRun ? "After applying, next actions would be:" : undefined));
  return rows.join("\n");
}

export function formatSetupVerbose(report: SetupJson): string {
  return [
    ...report.steps.map((step) => `${step.status.toUpperCase().padEnd(22)} ${step.id}: ${step.message}`),
    ...report.nextActions.map((action) => `${action.kind}: ${action.value}`),
  ].join("\n");
}

export function formatUpdateExtensionSummary(report: ExtensionUpdateResult): string {
  const rows: string[] = [];
  if (report.dryRun) {
    rows.push("Extension update dry run: no changes made.");
    if (report.result === "failed") {
      rows.push(...formatFailedSteps(report.steps));
    } else {
      rows.push(formatPlannedChanges(report.steps));
    }
  } else if (report.result === "complete") {
    rows.push("Extension path refreshed.");
  } else if (report.result === "manual_action_required") {
    rows.push("Extension files refreshed. Browser reload required.");
  } else {
    rows.push("Extension update failed.");
    rows.push(...formatFailedSteps(report.steps));
  }
  rows.push(...formatNextActions(report.nextActions, report.dryRun ? "After applying, next actions would be:" : undefined));
  return rows.join("\n");
}

export function formatUpdateExtensionVerbose(report: ExtensionUpdateResult): string {
  return [
    ...report.steps.map((step) => `${step.status.toUpperCase().padEnd(22)} ${step.id}: ${step.message}`),
    ...report.nextActions.map((action) => `${action.kind}: ${action.value}`),
  ].join("\n");
}

export function formatInstallHostSummary(actions: InstallHostAction[]): string {
  if (actions.length === 0) return "No native-host browser targets selected.";
  if (actions.length === 1) return formatSingleInstallHostAction(actions[0]!);

  const counts = countStatuses(actions);
  const parts = [
    counts.applied > 0 ? `${counts.applied} installed` : undefined,
    counts.skipped > 0 ? `${counts.skipped} already current` : undefined,
    counts.would_apply > 0 ? `${counts.would_apply} would update` : undefined,
    counts.failed > 0 ? `${counts.failed} failed` : undefined,
  ].filter((part): part is string => typeof part === "string");
  const rows = [`Native host install: ${parts.join(", ")} across ${plural(actions.length, "browser")}.`];
  for (const action of actions.filter((candidate) => candidate.status === "failed")) {
    rows.push(`Failed ${action.browser}: ${installHostFailureSummary(action)}`);
  }
  return rows.join("\n");
}

export function formatInstallHostVerbose(actions: InstallHostAction[]): string {
  return actions.map((action) => `${action.status.toUpperCase().padEnd(11)} ${action.browser}: ${action.message}`).join("\n");
}

export function formatDoctorSummary(
  report: DoctorLike,
  command: "doctor" | "doctor browser",
  strict: boolean,
  verboseCommand = `obu ${command} --verbose`,
): string {
  const counts = countDoctorStatuses(report.checks);
  const rows = [
    command === "doctor browser"
      ? `open-browser-use browser doctor: ${report.browser}`
      : `open-browser-use doctor: ${report.browser}`,
    `${counts.pass} passed, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.fail} failed.`,
    `Extension: ${report.extensionChannel}${report.extensionId ? ` (${report.extensionId})` : ""}`,
  ];
  if (strict && counts.warn > 0 && counts.fail === 0) {
    rows.push("Strict mode treats warnings as failures.");
  }

  if (report.repairs && report.repairs.length > 0) {
    rows.push("", "Repairs:");
    for (const repair of report.repairs) {
      rows.push(`  ${repair.status.toUpperCase().padEnd(7)} ${repair.message}`);
    }
  }

  const visibleChecks = report.checks.filter((check) => check.status !== "pass" || hasActionableDetails(check));
  if (visibleChecks.length === 0) {
    rows.push("", "No problems found.");
  } else {
    rows.push("", "Checks:");
    for (const check of visibleChecks) {
      rows.push(`  ${check.status.toUpperCase().padEnd(4)} ${check.label}: ${check.message}`);
      rows.push(...formatCheckDetails(check).map((row) => `    ${row}`));
    }
  }

  rows.push("", `For full diagnostics, run: ${verboseCommand}`);
  return rows.join("\n");
}

function formatSingleInstallHostAction(action: InstallHostAction): string {
  switch (action.status) {
    case "applied":
      return `Native host installed for ${action.browser}.`;
    case "skipped":
      return `Native host already current for ${action.browser}.`;
    case "would_apply":
      return `Native host dry run: would update ${action.browser}.`;
    case "failed":
      return `Native host install failed for ${action.browser}: ${installHostFailureSummary(action)}`;
  }
}

function installHostFailureSummary(action: InstallHostAction): string {
  if (typeof action.details?.hostBin === "string") {
    return "obu-host is not executable. Run with --verbose for the path.";
  }
  if (typeof action.details?.platform === "string") {
    return `native-host install is not supported on ${action.details.platform}.`;
  }
  return `${action.message.replace(/\s+at\s+\S+/g, "")}. Run with --verbose for details.`;
}

function formatPlannedChanges(steps: Array<{ status: string; message: string }>): string {
  const planned = steps.filter((step) => step.status === "would_apply");
  if (planned.length === 0) return "Planned changes: none.";
  return `Planned changes: ${planned.map((step) => step.message).join("; ")}.`;
}

function formatFailedSteps(steps: Array<{ status: string; id: string; message: string }>): string[] {
  const failed = steps.filter((step) => step.status === "failed");
  if (failed.length === 0) return [];
  return ["Problems:", ...failed.map((step) => `  ${step.id}: ${step.message}`)];
}

function formatNextActions(actions: NextAction[], heading = "Next actions:"): string[] {
  if (actions.length === 0) return [];
  const rows = ["", heading];
  for (const action of actions) {
    const label = action.kind === "command" ? "Run" : action.kind === "manual" ? "Do" : "Read";
    rows.push(`${label}:`);
    rows.push(...indentBlock(action.value, "  "));
  }
  return rows;
}

function countManualFollowUps(steps: SetupJson["steps"]): number {
  return steps.filter((step) => step.status === "manual_action_required").length;
}

function countStatuses(actions: InstallHostAction[]): Record<InstallHostAction["status"], number> {
  return {
    applied: actions.filter((action) => action.status === "applied").length,
    skipped: actions.filter((action) => action.status === "skipped").length,
    would_apply: actions.filter((action) => action.status === "would_apply").length,
    failed: actions.filter((action) => action.status === "failed").length,
  };
}

function countDoctorStatuses(checks: DoctorCheck[]): Record<DoctorCheck["status"], number> {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}

function hasActionableDetails(check: DoctorCheck): boolean {
  const repair = check.details?.repair;
  const deliverableRecovery = check.details?.deliverable_recovery;
  const resumeRequired = check.details?.resume_required;
  return (
    (typeof repair === "string" && repair.length > 0) ||
    (typeof deliverableRecovery === "string" && deliverableRecovery.length > 0) ||
    typeof resumeRequired === "boolean"
  );
}

function formatCheckDetails(check: DoctorCheck): string[] {
  const rows: string[] = [];
  const lifecycle = check.details?.lifecycle;
  if (isRecord(lifecycle)) {
    const parts: string[] = [];
    for (const key of ["stale_sessions", "stale_tabs", "stale_file_choosers", "stale_downloads", "deliverable_tabs"]) {
      const value = lifecycle[key];
      if (typeof value === "number") parts.push(`${key}=${value}`);
    }
    const staleSessionReasons = lifecycle.stale_session_reasons;
    if (Array.isArray(staleSessionReasons)) parts.push(`stale_session_reasons=${staleSessionReasons.length}`);
    if (parts.length > 0) rows.push(`lifecycle: ${parts.join(", ")}`);
    const reasonSummary = formatStaleSessionReasons(staleSessionReasons);
    if (reasonSummary.length > 0) rows.push(`stale session reasons: ${reasonSummary.join(", ")}`);
    const deliverableSummary = formatDeliverableTabSummaries(lifecycle.deliverable_tab_summaries);
    if (deliverableSummary.length > 0) rows.push(`deliverable tabs: ${deliverableSummary.join(", ")}`);
  }
  const deliverableRecovery = check.details?.deliverable_recovery;
  if (typeof deliverableRecovery === "string" && deliverableRecovery.length > 0) {
    rows.push(`recover deliverables: ${deliverableRecovery}`);
  }
  const resumeRequired = check.details?.resume_required;
  if (typeof resumeRequired === "boolean") {
    rows.push(`resume required: ${resumeRequired ? "yes" : "no"}`);
  }
  const resumeAction = check.details?.resume_action;
  if (typeof resumeAction === "string" && resumeAction.length > 0) {
    rows.push(`resume action: ${resumeAction}`);
  }
  const repair = check.details?.repair;
  if (typeof repair === "string" && repair.length > 0) rows.push(`repair: ${repair}`);
  return rows;
}

function formatStaleSessionReasons(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const reasons = value
    .map((row) => {
      if (!isRecord(row)) return undefined;
      const sessionId = typeof row.session_id === "string" && row.session_id.length > 0 ? row.session_id : "unknown-session";
      const reason = typeof row.reason === "string" && row.reason.length > 0 ? row.reason : "unknown";
      return `${sessionId}:${reason}`;
    })
    .filter((row): row is string => typeof row === "string");
  const visible = reasons.slice(0, 3);
  if (reasons.length > visible.length) visible.push(`+${reasons.length - visible.length} more`);
  return visible;
}

function formatDeliverableTabSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tabs = value
    .map((row) => {
      if (!isRecord(row)) return undefined;
      const tabId = typeof row.tab_id === "string" && row.tab_id.length > 0 ? row.tab_id : "unknown-tab";
      const title = typeof row.title === "string" && row.title.length > 0 ? row.title : undefined;
      const url = typeof row.url === "string" && row.url.length > 0 ? row.url : undefined;
      const sessionId = typeof row.session_id === "string" && row.session_id.length > 0 ? row.session_id : undefined;
      const label = title ?? url ?? "untitled";
      return `${tabId}:${label}${sessionId ? ` (${sessionId})` : ""}`;
    })
    .filter((row): row is string => typeof row === "string");
  const visible = tabs.slice(0, 3);
  if (tabs.length > visible.length) visible.push(`+${tabs.length - visible.length} more`);
  return visible;
}

function indentBlock(value: string, prefix: string): string[] {
  return value.split("\n").map((line) => `${prefix}${line}`);
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
