import os from "node:os";

import type { DoctorCheck, DoctorStatus } from "./doctor-browser.js";
import type { RuntimeLayout } from "./runtime-layout.js";

export type DoctorJson = {
  schemaVersion: 1;
  generatedAt: string;
  obuVersion: string;
  command: "doctor" | "doctor browser";
  strict: boolean;
  platform: { os: string; arch: string; libc?: "gnu" | "musl" | "unknown" };
  layout: {
    mode: "repo" | "packaged";
    root: string;
    openBrowserUseCommand: string;
    runtimeDir: string;
  };
  summary: { pass: number; warn: number; fail: number };
  checks: Array<{
    id: string;
    scope: "payload" | "runtime" | "browser" | "native-host" | "agent" | "cleanup";
    status: DoctorStatus;
    message: string;
    details?: Record<string, unknown>;
    remediation?: { kind: "command" | "manual" | "docs"; value: string };
  }>;
};

export function doctorJson(input: {
  report: { checks: DoctorCheck[] };
  layout: RuntimeLayout;
  obuVersion: string;
  command: "doctor" | "doctor browser";
  strict: boolean;
  generatedAt?: Date;
}): DoctorJson {
  const checks = input.report.checks.map((check) => doctorJsonCheck(check));
  return {
    schemaVersion: 1,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    obuVersion: input.obuVersion,
    command: input.command,
    strict: input.strict,
    platform: {
      os: process.platform,
      arch: process.arch,
      ...(process.platform === "linux" ? { libc: detectLibc() } : {}),
    },
    layout: {
      mode: input.layout.mode,
      root: input.layout.root,
      openBrowserUseCommand: input.layout.openBrowserUseCommand,
      runtimeDir: input.layout.runtimeDir,
    },
    summary: summarize(input.report.checks),
    checks,
  };
}

function doctorJsonCheck(check: DoctorCheck): DoctorJson["checks"][number] {
  const repair = typeof check.details?.repair === "string" ? check.details.repair : undefined;
  const details = check.details === undefined ? undefined : { ...check.details };
  if (details) delete details.repair;
  return {
    id: check.id,
    scope: checkScope(check.id),
    status: check.status,
    message: check.message,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
    ...(repair ? { remediation: { kind: "manual", value: repair } } : {}),
  };
}

function summarize(checks: DoctorCheck[]): DoctorJson["summary"] {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

function checkScope(id: string): DoctorJson["checks"][number]["scope"] {
  if (id === "user-config") return "runtime";
  if (id.startsWith("runtime")) return "runtime";
  if (id.startsWith("browser") || id.startsWith("profile") || id.startsWith("extension")) return "browser";
  if (id.startsWith("native-host")) return "native-host";
  if (id.startsWith("payload") || id.endsWith("version")) return "payload";
  if (id.startsWith("agent")) return "agent";
  if (id.includes("backup") || id.includes("cleanup")) return "cleanup";
  return "payload";
}

function detectLibc(): "gnu" | "musl" | "unknown" {
  const report = typeof process.report?.getReport === "function"
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
    : undefined;
  const header = report?.header;
  if (typeof header?.glibcVersionRuntime === "string") return "gnu";
  if (os.platform() === "linux") return "musl";
  return "unknown";
}
