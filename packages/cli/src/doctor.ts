import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { cleanOpenBrowserUseBackups, DIRECT_EDIT_AGENT_IDS, listOpenBrowserUseBackups } from "./agents/direct-edit.js";
import {
  doctorBrowser,
  formatDoctorReport,
  type DoctorBrowserOptions,
  type DoctorCheck,
  type DoctorRepairAction,
  type DoctorReport,
  type DoctorStatus,
} from "./doctor-browser.js";
import type { ExtensionChannel, ExtensionIdSource } from "./extension-channel.js";
import { type RuntimeLayout } from "./runtime-layout.js";

const execFileAsync = promisify(execFile);

export type AggregateDoctorReport = {
  browser: DoctorReport["browser"];
  extensionChannel: ExtensionChannel;
  extensionId: string | undefined;
  extensionIdSource: ExtensionIdSource | undefined;
  checks: DoctorCheck[];
  repairs?: DoctorRepairAction[];
};

export async function doctorAggregate(input: {
  layout: RuntimeLayout;
  browserOptions?: DoctorBrowserOptions;
  cleanBackups?: boolean;
}): Promise<AggregateDoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(...await payloadChecks(input.layout));
  checks.push(await agentBackupCheck(input.layout, input.cleanBackups === true));
  const browserReport = await doctorBrowser({
    ...input.browserOptions,
    extensionCurrentDir: input.layout.mode === "repo" ? input.layout.extensionDir : input.layout.extensionCurrentDir,
  });
  checks.push(...browserReport.checks);
  const report: AggregateDoctorReport = {
    browser: browserReport.browser,
    extensionChannel: browserReport.extensionChannel,
    extensionId: browserReport.extensionId,
    extensionIdSource: browserReport.extensionIdSource,
    checks,
  };
  const repairs = [...(browserReport.repairs ?? [])];
  const backupCheck = checks.find((check) => check.id === "agent-config-backups");
  if (input.cleanBackups === true && backupCheck?.details?.deletedBackups) {
    repairs.push({
      id: "agent-config-backups",
      status: "applied",
      message: backupCheck.message,
      details: { deletedBackups: backupCheck.details.deletedBackups },
    });
  }
  if (repairs.length > 0) report.repairs = repairs;
  return report;
}

export function formatAggregateDoctorReport(report: AggregateDoctorReport): string {
  return formatDoctorReport({
    browser: report.browser,
    extensionChannel: report.extensionChannel,
    extensionId: report.extensionId,
    extensionIdSource: report.extensionIdSource,
    checks: report.checks,
    ...(report.repairs ? { repairs: report.repairs } : {}),
  }).replace(/^open-browser-use browser doctor:/, "open-browser-use doctor:");
}

async function payloadChecks(layout: RuntimeLayout): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(userConfigCheck(layout));
  checks.push(await fileCheck("payload-cli-entry", "CLI entry", layout.cliEntry, "file"));
  checks.push(await fileCheck("payload-node", "Node runtime", layout.nodeBin, "executable"));
  checks.push(await fileCheck("payload-host", "Native host binary", layout.hostBin, "executable"));
  checks.push(await fileCheck("payload-node-repl", "Node REPL binary", layout.nodeReplBin, "executable"));
  checks.push(await fileCheck("payload-sdk-package", "SDK package", layout.sdkPackageRoot, "directory"));
  checks.push(await fileCheck("payload-sdk-dist", "SDK dist", layout.sdkDistRoot, "directory"));
  checks.push(await fileCheck("extension-payload", "Extension payload", layout.extensionDir, "directory"));
  if (layout.metadataPath) checks.push(...await payloadMetadataChecks(layout));
  return checks;
}

async function payloadMetadataChecks(layout: RuntimeLayout): Promise<DoctorCheck[]> {
  const metadata = await readPayloadMetadata(layout.metadataPath!);
  if (!metadata.ok) return [metadata.check];

  const checks: DoctorCheck[] = [metadata.check];
  checks.push(payloadTargetCheck(metadata.value));
  checks.push(payloadExtensionChannelCheck(metadata.value));
  checks.push(await payloadNodeVersionCheck(layout, metadata.value));
  checks.push(await payloadSdkHashCheck(layout, metadata.value));
  checks.push(await payloadExtensionZipCheck(layout, metadata.value));
  checks.push(await payloadExtensionVersionCheck(layout, metadata.value));
  checks.push(await payloadRuntimeDependencyCheck(layout, metadata.value, "jsonc-parser"));
  return checks;
}

type PayloadMetadata = {
  targetTriple?: unknown;
  nodeVersion?: unknown;
  sdkHash?: unknown;
  extensionVersion?: unknown;
  extensionChannel?: unknown;
  extensionId?: unknown;
  storeExtensionId?: unknown;
  extensionZip?: unknown;
  extensionZipSha256?: unknown;
  cliRuntimeDependencies?: unknown;
};

async function readPayloadMetadata(metadataPath: string): Promise<
  | { ok: true; value: PayloadMetadata; check: DoctorCheck }
  | { ok: false; check: DoctorCheck }
> {
  try {
    const value = JSON.parse(await readFile(metadataPath, "utf8")) as PayloadMetadata;
    return {
      ok: true,
      value,
      check: check("payload-metadata", "Payload metadata", "pass", metadataPath, { path: metadataPath }),
    };
  } catch (error) {
    return {
      ok: false,
      check: check("payload-metadata", "Payload metadata", "fail", `could not read payload metadata at ${metadataPath}`, {
        path: metadataPath,
        error: String(error),
        repair: "Reinstall or rebuild the open-browser-use payload, then rerun obu doctor.",
      }),
    };
  }
}

function payloadTargetCheck(metadata: PayloadMetadata): DoctorCheck {
  const target = typeof metadata.targetTriple === "string" ? metadata.targetTriple : undefined;
  const expected = currentTargetTriple();
  if (target !== expected) {
    return check("payload-target", "Payload target", "fail", `payload target is ${target ?? "missing"}, expected ${expected}`, {
      target,
      expected,
      repair: "Install the open-browser-use platform package or curl artifact that matches this machine.",
    });
  }
  return check("payload-target", "Payload target", "pass", target, { target });
}

function payloadExtensionChannelCheck(metadata: PayloadMetadata): DoctorCheck {
  const channel = typeof metadata.extensionChannel === "string" ? metadata.extensionChannel : undefined;
  const id = typeof metadata.extensionId === "string" ? metadata.extensionId : undefined;
  const storeExtensionId = typeof metadata.storeExtensionId === "string" ? metadata.storeExtensionId : undefined;
  if (channel !== "unpacked-dev" && channel !== "store") {
    return check("payload-extension-channel", "Payload extension channel", "fail", `payload extensionChannel is ${channel ?? "missing"}`, {
      channel,
      repair: "Rebuild the open-browser-use payload so metadata records extensionChannel.",
    });
  }
  if (!/^[a-p]{32}$/.test(id ?? "")) {
    return check("payload-extension-channel", "Payload extension channel", "fail", "payload metadata is missing a valid extensionId", {
      channel,
      extensionId: id,
    });
  }
  if (channel === "store" && !/^[a-p]{32}$/.test(storeExtensionId ?? "")) {
    return check("payload-extension-channel", "Payload extension channel", "fail", "store payload metadata is missing a valid storeExtensionId", {
      channel,
      storeExtensionId,
    });
  }
  return check("payload-extension-channel", "Payload extension channel", "pass", channel, {
    channel,
    extensionId: id,
    ...(storeExtensionId ? { storeExtensionId } : {}),
  });
}

async function payloadNodeVersionCheck(layout: RuntimeLayout, metadata: PayloadMetadata): Promise<DoctorCheck> {
  const recorded = typeof metadata.nodeVersion === "string" ? metadata.nodeVersion : undefined;
  const inspected = await inspectNodeVersion(layout.nodeBin);
  if (!inspected.ok) {
    return check("payload-node-version", "Payload Node version", "fail", inspected.message, {
      path: layout.nodeBin,
      repair: "Reinstall or rebuild the open-browser-use payload, then rerun obu doctor.",
    });
  }
  if (!isAtLeastNode(inspected.version, 22, 22, 0)) {
    return check("payload-node-version", "Payload Node version", "fail", `bundled Node ${inspected.version} is below 22.22.0`, {
      path: layout.nodeBin,
      version: inspected.version,
      minimum: "22.22.0",
    });
  }
  if (recorded && recorded !== inspected.version) {
    return check("payload-node-version", "Payload Node version", "warn", `metadata records ${recorded}, binary reports ${inspected.version}`, {
      path: layout.nodeBin,
      recorded,
      inspected: inspected.version,
    });
  }
  return check("payload-node-version", "Payload Node version", "pass", inspected.version, {
    path: layout.nodeBin,
    version: inspected.version,
  });
}

async function payloadSdkHashCheck(layout: RuntimeLayout, metadata: PayloadMetadata): Promise<DoctorCheck> {
  const expected = typeof metadata.sdkHash === "string" ? metadata.sdkHash : undefined;
  if (!expected) {
    return check("payload-sdk-hash", "Payload SDK hash", "fail", "payload metadata is missing sdkHash", {
      repair: "Rebuild the open-browser-use payload so metadata records the SDK hash.",
    });
  }
  const actual = await hashTree(layout.sdkDistRoot).catch((error) => `error:${String(error)}`);
  if (actual !== expected) {
    return check("payload-sdk-hash", "Payload SDK hash", "fail", "SDK dist hash does not match payload metadata", {
      path: layout.sdkDistRoot,
      expected,
      actual,
      repair: "Reinstall or rebuild the open-browser-use payload, then rerun obu doctor.",
    });
  }
  return check("payload-sdk-hash", "Payload SDK hash", "pass", actual, { path: layout.sdkDistRoot, hash: actual });
}

async function payloadExtensionZipCheck(layout: RuntimeLayout, metadata: PayloadMetadata): Promise<DoctorCheck> {
  const relativeZip = typeof metadata.extensionZip === "string" ? metadata.extensionZip : undefined;
  const expected = typeof metadata.extensionZipSha256 === "string" ? metadata.extensionZipSha256 : undefined;
  if (!relativeZip || !expected) {
    return check("payload-extension-zip", "Extension zip checksum", "fail", "payload metadata is missing extension zip checksum fields", {
      repair: "Rebuild the open-browser-use payload so metadata records extensionZip and extensionZipSha256.",
    });
  }
  const zipPath = path.join(layout.root, relativeZip);
  const actual = await hashFile(zipPath).catch((error) => `error:${String(error)}`);
  if (actual !== expected) {
    return check("payload-extension-zip", "Extension zip checksum", "fail", "extension zip checksum does not match payload metadata", {
      path: zipPath,
      expected,
      actual,
      repair: "Reinstall or rebuild the open-browser-use payload, then rerun obu doctor.",
    });
  }
  return check("payload-extension-zip", "Extension zip checksum", "pass", actual, { path: zipPath, hash: actual });
}

async function payloadExtensionVersionCheck(layout: RuntimeLayout, metadata: PayloadMetadata): Promise<DoctorCheck> {
  const recorded = typeof metadata.extensionVersion === "string" ? metadata.extensionVersion : undefined;
  if (!recorded) {
    return check("payload-extension-version", "Extension payload version", "fail", "payload metadata is missing extensionVersion", {
      repair: "Rebuild the open-browser-use payload so metadata records the extension version.",
    });
  }
  const manifestPath = path.join(layout.extensionDir, "manifest.json");
  const manifest = await readJsonObject(manifestPath).catch((error) => ({ error: String(error) }));
  if ("error" in manifest) {
    return check("payload-extension-version", "Extension payload version", "fail", `could not read extension manifest at ${manifestPath}`, {
      path: manifestPath,
      error: manifest.error,
    });
  }
  const actual = typeof manifest.version === "string" ? manifest.version : undefined;
  if (actual !== recorded) {
    return check("payload-extension-version", "Extension payload version", "fail", `extension manifest version is ${actual ?? "missing"}, metadata records ${recorded}`, {
      path: manifestPath,
      expected: recorded,
      actual,
    });
  }
  return check("payload-extension-version", "Extension payload version", "pass", actual, { path: manifestPath, version: actual });
}

async function payloadRuntimeDependencyCheck(layout: RuntimeLayout, metadata: PayloadMetadata, dependency: string): Promise<DoctorCheck> {
  const dependencies = Array.isArray(metadata.cliRuntimeDependencies) ? metadata.cliRuntimeDependencies : [];
  if (!dependencies.includes(dependency)) {
    return check("payload-runtime-dependency", "CLI runtime dependency", "fail", `payload metadata does not record ${dependency}`, {
      dependency,
      repair: "Rebuild the open-browser-use payload so CLI runtime dependencies are bundled and recorded.",
    });
  }
  const packageJson = path.join(layout.nodeModulesRoot, dependency, "package.json");
  const exists = await access(packageJson, constants.F_OK).then(() => true).catch(() => false);
  if (!exists) {
    return check("payload-runtime-dependency", "CLI runtime dependency", "fail", `${dependency} is not bundled in the payload`, {
      path: packageJson,
      dependency,
      repair: "Reinstall or rebuild the open-browser-use payload, then rerun obu doctor.",
    });
  }
  return check("payload-runtime-dependency", "CLI runtime dependency", "pass", dependency, { path: packageJson, dependency });
}

async function agentBackupCheck(layout: RuntimeLayout, cleanBackups: boolean): Promise<DoctorCheck> {
  const homeDir = path.dirname(path.dirname(layout.userConfigPath));
  if (cleanBackups) {
    const deletedBackups = await cleanOpenBrowserUseBackups(DIRECT_EDIT_AGENT_IDS, { homeDir });
    return check(
      "agent-config-backups",
      "Agent config backups",
      "pass",
      deletedBackups.length === 0
        ? "no open-browser-use agent config backups found"
        : `deleted ${deletedBackups.length} open-browser-use agent config backup${deletedBackups.length === 1 ? "" : "s"}`,
      { count: deletedBackups.length, deletedBackups },
    );
  }
  const backups = await listOpenBrowserUseBackups(DIRECT_EDIT_AGENT_IDS, { homeDir });
  if (backups.length === 0) {
    return check("agent-config-backups", "Agent config backups", "pass", "no open-browser-use agent config backups found", { count: 0 });
  }
  return check(
    "agent-config-backups",
    "Agent config backups",
    "warn",
    `${backups.length} open-browser-use agent config backup${backups.length === 1 ? "" : "s"} found`,
    {
      count: backups.length,
      backups: backups.map((backup) => backup.backupPath),
      repair: "Run `obu doctor --clean-backups` to remove open-browser-use-generated agent config backups.",
    },
  );
}

function userConfigCheck(layout: RuntimeLayout): DoctorCheck {
  if (layout.configIssue) {
    return check("user-config", "User config", "fail", layout.configIssue.message, {
      path: layout.configIssue.path,
      code: layout.configIssue.code,
      ...(layout.configIssue.details ? { error: layout.configIssue.details.error } : {}),
      repair: `Fix or remove ${layout.configIssue.path}, then rerun obu doctor.`,
    });
  }
  return check("user-config", "User config", "pass", layout.userConfigPath, { path: layout.userConfigPath });
}

async function fileCheck(
  id: string,
  label: string,
  target: string,
  expectation: "file" | "directory" | "executable",
): Promise<DoctorCheck> {
  const exists = await access(target, expectation === "executable" ? constants.X_OK : constants.F_OK)
    .then(() => true)
    .catch(() => false);
  const stats = exists ? await lstat(target).catch(() => undefined) : undefined;
  const matchesType = expectation === "directory" ? stats?.isDirectory() === true : expectation === "file" ? stats?.isFile() === true : true;
  if (!exists || !matchesType) {
    return check(id, label, expectation === "executable" ? "fail" : "warn", `not found at ${target}`, {
      path: target,
      expected: expectation,
      repair: "Build or install the open-browser-use payload, then rerun obu doctor.",
    });
  }
  return check(id, label, "pass", target, { path: target });
}

async function inspectNodeVersion(nodeBin: string): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  try {
    const result = await execFileAsync(nodeBin, ["--version"], { timeout: 2000, encoding: "utf8" });
    return { ok: true, version: result.stdout.trim().replace(/^v/, "") };
  } catch (error) {
    return { ok: false, message: `failed to inspect bundled Node version: ${String(error)}` };
  }
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function hashTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, full));
    }
  }
  return files;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return `sha256:${hash.digest("hex")}`;
}

function isAtLeastNode(version: string, major: number, minor: number, patch: number): boolean {
  const parts = version.split(".").map((part) => Number(part));
  const current = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  const minimum = [major, minor, patch];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function currentTargetTriple(): string {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") {
    const report = typeof process.report?.getReport === "function"
      ? process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
      : undefined;
    const libc = typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}`;
  }
  return `${process.platform}-${process.arch}`;
}

function check(
  id: string,
  label: string,
  status: DoctorStatus,
  message: string,
  details?: Record<string, unknown>,
): DoctorCheck {
  return { id, label, status, message, ...(details ? { details } : {}) };
}
