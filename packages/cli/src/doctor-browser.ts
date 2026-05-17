import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browserInstallPath, browserProfileRoot, nativeMessagingHostDir, type BrowserKind } from "./browser-paths.js";
import { resolveRuntimeLayout, validateRuntimeDir, type RuntimeLayout } from "./runtime-layout.js";

const execFileAsync = promisify(execFile);
const HOST_NAME = "dev.obu.host";
const CLEAR_LIFECYCLE_DIAGNOSTICS = "clearLifecycleDiagnostics";
const EXTENSION_ID_ALPHABET_OFFSET = "a".charCodeAt(0);
const DEFAULT_BROWSER = "chrome";
const REQUIRED_EXTENSION_PERMISSIONS = [
  "nativeMessaging",
  "debugger",
  "tabs",
  "tabGroups",
  "scripting",
  "storage",
  "history",
  "downloads",
  "alarms",
];
const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = path.resolve(packageRoot, "..", "..");

export type { BrowserKind } from "./browser-paths.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  browser: BrowserKind;
  extensionId: string | undefined;
  checks: DoctorCheck[];
  repairs?: DoctorRepairAction[];
};

export type DoctorRepairAction = {
  id: string;
  status: "applied" | "skipped" | "failed";
  message: string;
  details?: Record<string, unknown>;
};

export type DoctorBrowserOptions = {
  browser?: BrowserKind;
  platform?: NodeJS.Platform;
  homeDir?: string;
  repoRoot?: string;
  manifestPath?: string;
  hostBinary?: string;
  nativeManifestDir?: string;
  browserInstallPath?: string;
  profileRoot?: string;
  runtimeDir?: string;
  extensionCurrentDir?: string;
  env?: NodeJS.ProcessEnv;
  repair?: boolean;
};

type RuntimeDescriptorProbeResult =
  | { ok: true; details: Record<string, unknown> }
  | { ok: false; message: string };

export async function doctorBrowser(options: DoctorBrowserOptions = {}): Promise<DoctorReport> {
  const browser = options.browser ?? DEFAULT_BROWSER;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const root = options.repoRoot ?? repoRoot;
  const layout = await resolveRuntimeLayout({
    env,
    homeDir,
    platform,
    repoRoot: root,
    ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
  });
  const manifestPath = options.manifestPath ?? await extensionManifestPath(layout);
  const extensionId = await readExtensionId(manifestPath).catch(() => undefined);
  const checks: DoctorCheck[] = [];
  const repairs: DoctorRepairAction[] = [];
  const runtimeDir = layout.runtimeDir;
  const runtimeDescriptorDir = path.join(runtimeDir, "webextension");
  const nativeManifestDir = options.nativeManifestDir ?? nativeMessagingHostDir(browser, platform, homeDir);
  const nativeManifestPath = path.join(nativeManifestDir, `${HOST_NAME}.json`);
  const hostBinary = options.hostBinary ?? layout.hostBin;
  const extensionCurrentDir = options.extensionCurrentDir ?? (layout.mode === "repo" ? layout.extensionDir : layout.extensionCurrentDir);

  if (options.repair) {
    repairs.push(...await repairNativeHostManifest({
      browser,
      platform,
      extensionId,
      nativeManifestPath,
      hostBinary,
      nativeHostInstallRoot: layout.nativeHostInstallRoot,
      runtimeDir,
    }));
    repairs.push(...await repairRuntimeDescriptors(runtimeDescriptorDir));
  }

  checks.push(await checkExtensionManifest(manifestPath));
  checks.push(await checkBrowserInstalled(browser, platform, options.browserInstallPath));
  const profileRoot = options.profileRoot ?? browserProfileRoot(browser, platform, homeDir);
  checks.push(await checkProfilePath(profileRoot));
  checks.push(await checkExtensionInstalled(profileRoot, extensionId, extensionCurrentDir));
  checks.push(await checkNativeHostManifest(nativeManifestPath, extensionId));
  checks.push(await checkHostVersion(hostBinary));
  checks.push(await checkRuntimeDir(runtimeDir));
  checks.push(await checkRuntimeDescriptorDir(runtimeDescriptorDir));
  checks.push(await checkRuntimeDescriptors(runtimeDescriptorDir));

  return { browser, extensionId, checks, ...(repairs.length > 0 ? { repairs } : {}) };
}

export function formatDoctorReport(report: DoctorReport): string {
  const rows = [
    `open-browser-use browser doctor: ${report.browser}`,
    report.extensionId ? `extension id: ${report.extensionId}` : "extension id: unknown",
    "",
  ];
  if (report.repairs && report.repairs.length > 0) {
    rows.push("repairs:");
    for (const repair of report.repairs) {
      rows.push(`  ${repair.status.toUpperCase().padEnd(7)} ${repair.message}`);
    }
    rows.push("");
  }
  for (const check of report.checks) {
    rows.push(`${check.status.toUpperCase().padEnd(4)} ${check.label}: ${check.message}`);
    rows.push(...formatCheckDetails(check));
  }
  return rows.join("\n");
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
    if (parts.length > 0) rows.push(`  lifecycle: ${parts.join(", ")}`);
    const reasonSummary = formatStaleSessionReasons(staleSessionReasons);
    if (reasonSummary.length > 0) rows.push(`  stale session reasons: ${reasonSummary.join(", ")}`);
    const deliverableSummary = formatDeliverableTabSummaries(lifecycle.deliverable_tab_summaries);
    if (deliverableSummary.length > 0) rows.push(`  deliverable tabs: ${deliverableSummary.join(", ")}`);
  }
  const deliverableRecovery = check.details?.deliverable_recovery;
  if (typeof deliverableRecovery === "string" && deliverableRecovery.length > 0) {
    rows.push(`  recover deliverables: ${deliverableRecovery}`);
  }
  const repair = check.details?.repair;
  if (typeof repair === "string" && repair.length > 0) rows.push(`  repair: ${repair}`);
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

export function hasDoctorFailures(report: { checks: DoctorCheck[] }): boolean {
  return report.checks.some((check) => check.status === "fail");
}

type NativeHostRepairInput = {
  browser: BrowserKind;
  platform: NodeJS.Platform;
  extensionId: string | undefined;
  nativeManifestPath: string;
  hostBinary: string;
  nativeHostInstallRoot: string;
  runtimeDir: string;
};

async function repairNativeHostManifest(input: NativeHostRepairInput): Promise<DoctorRepairAction[]> {
  if (input.platform === "win32") {
    return [
      {
        id: "native-host-manifest",
        status: "failed",
        message: "cannot repair native host manifest because Windows repair is not implemented",
        details: { path: input.nativeManifestPath, platform: input.platform, reason: "windows_unsupported" },
      },
    ];
  }
  if (!input.extensionId) {
    return [
      {
        id: "native-host-manifest",
        status: "failed",
        message: "cannot repair native host manifest because extension id could not be derived",
        details: { path: input.nativeManifestPath, reason: "extension_id_unavailable" },
      },
    ];
  }
  const current = await checkNativeHostManifest(input.nativeManifestPath, input.extensionId);
  if (current.status === "pass") {
    return [
      {
        id: "native-host-manifest",
        status: "skipped",
        message: "native host manifest already valid",
        details: { path: input.nativeManifestPath },
      },
    ];
  }
  const executable = await access(input.hostBinary, constants.X_OK).then(() => true).catch(() => false);
  if (!executable) {
    return [
      {
        id: "native-host-manifest",
        status: "failed",
        message: `cannot repair native host manifest because host binary is not executable: ${input.hostBinary}`,
        details: { path: input.hostBinary },
      },
    ];
  }

  const browserKind = input.browser === "chrome-for-testing" ? "chrome" : input.browser;
  const wrapperDir = path.join(input.nativeHostInstallRoot, HOST_NAME, input.browser);
  const wrapperPath = path.join(wrapperDir, "obu-host-wrapper");
  await mkdir(wrapperDir, { recursive: true });
  await writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      "set -eu",
      `export OBU_BROWSER_KIND=${shellQuote(browserKind)}`,
      `export OBU_RUNTIME_DIR=${shellQuote(input.runtimeDir)}`,
      "if [ -L \"$OBU_RUNTIME_DIR\" ]; then",
      "  echo \"open-browser-use runtime directory is a symlink: $OBU_RUNTIME_DIR\" >&2",
      "  exit 1",
      "fi",
      "if [ -e \"$OBU_RUNTIME_DIR\" ] && [ ! -d \"$OBU_RUNTIME_DIR\" ]; then",
      "  echo \"open-browser-use runtime path is not a directory: $OBU_RUNTIME_DIR\" >&2",
      "  exit 1",
      "fi",
      "if [ ! -e \"$OBU_RUNTIME_DIR\" ]; then",
      "  mkdir -m 700 -p \"$OBU_RUNTIME_DIR\"",
      "fi",
      `exec ${shellQuote(input.hostBinary)} --native-messaging`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  await mkdir(path.dirname(input.nativeManifestPath), { recursive: true });
  await writeFile(
    input.nativeManifestPath,
    `${JSON.stringify({
      name: HOST_NAME,
      description: "open-browser-use native messaging host",
      path: wrapperPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${input.extensionId}/`],
    }, null, 2)}\n`,
    "utf8",
  );
  await chmod(input.nativeManifestPath, 0o644);
  return [
    {
      id: "native-host-manifest",
      status: "applied",
      message: `wrote native host manifest ${input.nativeManifestPath}`,
      details: { path: input.nativeManifestPath, wrapperPath },
    },
  ];
}

async function repairRuntimeDescriptors(descriptorDir: string): Promise<DoctorRepairAction[]> {
  const actions: DoctorRepairAction[] = [];
  if (process.platform === "win32") {
    return [
      {
        id: "runtime-descriptor-permissions",
        status: "failed",
        message: "cannot repair runtime descriptor permissions because the repair is POSIX-only",
        details: { path: descriptorDir, platform: process.platform, reason: "posix_only" },
      },
    ];
  }

  const runtimeDir = path.dirname(descriptorDir);
  const runtimeDirStats = await lstat(runtimeDir).catch(() => undefined);
  if (runtimeDirStats?.isSymbolicLink()) {
    return [
      {
        id: "runtime-dir",
        status: "failed",
        message: `cannot repair runtime descriptors because runtime directory is a symlink: ${runtimeDir}`,
        details: { path: runtimeDir, reason: "symlink" },
      },
    ];
  }
  if (runtimeDirStats && !runtimeDirStats.isDirectory()) {
    return [
      {
        id: "runtime-dir",
        status: "failed",
        message: `cannot repair runtime descriptors because runtime path is not a directory: ${runtimeDir}`,
        details: { path: runtimeDir, reason: "not_directory" },
      },
    ];
  }
  if (runtimeDirStats && (runtimeDirStats.mode & 0o077) !== 0) {
    await chmod(runtimeDir, 0o700);
    actions.push({
      id: "runtime-dir",
      status: "applied",
      message: `set runtime directory permissions to 700: ${runtimeDir}`,
      details: { path: runtimeDir },
    });
  }

  const dirStats = await lstat(descriptorDir).catch(() => undefined);
  if (!dirStats) {
    await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
    await chmod(runtimeDir, 0o700);
    await chmod(descriptorDir, 0o700);
    actions.push({
      id: "runtime-descriptor-dir",
      status: "applied",
      message: `created runtime descriptor directory ${descriptorDir}`,
      details: { path: descriptorDir },
    });
    return actions;
  }
  if (dirStats.isSymbolicLink()) {
    actions.push({
      id: "runtime-descriptor-dir",
      status: "failed",
      message: `runtime descriptor path is a symlink: ${descriptorDir}`,
      details: { path: descriptorDir, reason: "symlink" },
    });
    return actions;
  }
  if (!dirStats.isDirectory()) {
    actions.push({
      id: "runtime-descriptor-dir",
      status: "failed",
      message: `runtime descriptor path is not a directory: ${descriptorDir}`,
      details: { path: descriptorDir },
    });
    return actions;
  }
  if ((dirStats.mode & 0o077) !== 0) {
    await chmod(descriptorDir, 0o700);
    actions.push({
      id: "runtime-descriptor-dir",
      status: "applied",
      message: `set runtime descriptor directory permissions to 700: ${descriptorDir}`,
      details: { path: descriptorDir },
    });
  }

  const files = await readdir(descriptorDir).catch(() => []);
  for (const file of files.filter((row) => row.endsWith(".json"))) {
    const descriptorPath = path.join(descriptorDir, file);
    const stats = await lstat(descriptorPath).catch(() => undefined);
    if (!stats || !stats.isFile() || stats.isSymbolicLink()) continue;
    if ((stats.mode & 0o077) === 0) continue;
    await chmod(descriptorPath, 0o600);
    actions.push({
      id: "runtime-descriptor-file",
      status: "applied",
      message: `set runtime descriptor file permissions to 600: ${descriptorPath}`,
      details: { path: descriptorPath },
    });
  }
  actions.push(...await repairStaleRuntimeDescriptors(descriptorDir));
  actions.push(...await repairStaleLifecycleDiagnostics(descriptorDir));

  if (actions.length === 0) {
    actions.push({
      id: "runtime-descriptor-permissions",
      status: "skipped",
      message: "runtime descriptor permissions already owner-only",
      details: { path: descriptorDir },
    });
  }
  return actions;
}

async function repairStaleRuntimeDescriptors(descriptorDir: string): Promise<DoctorRepairAction[]> {
  const actions: DoctorRepairAction[] = [];
  const files = await readdir(descriptorDir).catch(() => []);
  for (const file of files.filter((row) => row.endsWith(".json"))) {
    const descriptorPath = path.join(descriptorDir, file);
    const descriptor = await readJson(descriptorPath).catch(() => undefined);
    if (!isRecord(descriptor) || descriptor.type !== "webextension") continue;
    const staleReason = await staleDescriptorRepairReason(descriptor);
    if (!staleReason) continue;
    await unlink(descriptorPath);
    actions.push({
      id: "runtime-descriptor-stale",
      status: "applied",
      message: `removed stale runtime descriptor ${descriptorPath}: ${staleReason}`,
      details: { path: descriptorPath, reason: staleReason },
    });
  }
  return actions;
}

async function repairStaleLifecycleDiagnostics(descriptorDir: string): Promise<DoctorRepairAction[]> {
  const actions: DoctorRepairAction[] = [];
  const files = await readdir(descriptorDir).catch(() => []);
  for (const file of files.filter((row) => row.endsWith(".json"))) {
    const descriptorPath = path.join(descriptorDir, file);
    const fileIssue = await validateRuntimeDescriptorFile(descriptorPath);
    if (fileIssue) continue;
    const descriptor = await readJson(descriptorPath).catch(() => undefined);
    if (!isRecord(descriptor) || descriptor.type !== "webextension") continue;
    const probe = await probeDescriptor(descriptor);
    if (!probe.ok) continue;
    const staleLifecycle = staleLifecycleSummary(probe.details.lifecycle);
    if (!staleLifecycle) continue;
    const result = await clearLifecycleDiagnostics(descriptor).catch((error) => probeError(String(error)));
    if (!result.ok) {
      actions.push({
        id: "runtime-lifecycle-diagnostics",
        status: "failed",
        message: `could not clear stale lifecycle diagnostics for ${descriptorPath}: ${result.message}`,
        details: { path: descriptorPath, staleLifecycle },
      });
      continue;
    }
    actions.push({
      id: "runtime-lifecycle-diagnostics",
      status: "applied",
      message: `cleared stale lifecycle diagnostics for ${descriptorPath}: ${staleLifecycle}`,
      details: { path: descriptorPath, staleLifecycle, result: result.details },
    });
  }
  return actions;
}

async function staleDescriptorRepairReason(descriptor: Record<string, unknown>): Promise<string | undefined> {
  const processIssue = descriptorProcessIssue(descriptor);
  if (processIssue) return processIssue;
  const socketPath = descriptor.socketPath;
  if (typeof socketPath !== "string") return undefined;
  const socketIssue = await validateDescriptorSocket(socketPath);
  if (socketIssue) {
    if (socketIssue.startsWith("stat descriptor socket failed") || socketIssue === "descriptor socket path is not a socket") {
      return socketIssue;
    }
    return undefined;
  }
  const probe = await probeDescriptor(descriptor);
  if (!probe.ok && isRepairableDescriptorProbeFailure(probe.message)) return probe.message;
  return undefined;
}

async function clearLifecycleDiagnostics(descriptor: Record<string, unknown>): Promise<RuntimeDescriptorProbeResult> {
  if (descriptor.schema_version !== 1) return probeError("schema_version must be 1");
  if (descriptor.type !== "webextension") return probeError("type must be webextension");
  if (typeof descriptor.socketPath !== "string") return probeError("socketPath missing");
  if (typeof descriptor.sdk_auth_token !== "string") return probeError("sdk_auth_token missing");
  const [auth, clear, info] = await rpcSequenceOverUnixSocket(descriptor.socketPath, [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "auth",
      params: { capability_token: descriptor.sdk_auth_token },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: CLEAR_LIFECYCLE_DIAGNOSTICS,
      params: {},
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "getInfo",
      params: {},
    },
  ]);
  if (auth.error) return probeError("auth rejected");
  if (clear.error) return probeError(`clearLifecycleDiagnostics failed: ${JSON.stringify(clear.error)}`);
  if (info.error) return probeError(`getInfo failed: ${JSON.stringify(info.error)}`);
  return { ok: true, details: { clear: clear.result, ...runtimeDescriptorProbeDetails(info.result) } };
}

function isRepairableDescriptorProbeFailure(message: string): boolean {
  return (
    message === "auth rejected" ||
    message === "getInfo type mismatch" ||
    message === "getInfo name mismatch" ||
    message.startsWith("getInfo failed:") ||
    message.startsWith("socket probe failed:")
  );
}

async function checkExtensionManifest(manifestPath: string): Promise<DoctorCheck> {
  const manifest = await readJson(manifestPath).catch(() => undefined);
  if (!manifest) {
    return fail("extension-manifest", "Extension manifest", `manifest not found or invalid at ${manifestPath}`, { path: manifestPath });
  }

  const issues: string[] = [];
  if (manifest.manifest_version !== 3) issues.push("manifest_version must be 3");
  if (typeof manifest.key !== "string" || manifest.key.length === 0) issues.push("key is required for stable extension id");
  if (manifest.background?.service_worker !== "background.js") issues.push("background.service_worker must be background.js");
  if (manifest.action?.default_popup !== "popup.html") issues.push("action.default_popup must be popup.html");
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const permission of REQUIRED_EXTENSION_PERMISSIONS) {
    if (!permissions.includes(permission)) issues.push(`permissions must include ${permission}`);
  }
  const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  if (!hostPermissions.includes("<all_urls>")) issues.push("host_permissions must include <all_urls>");
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const hasCursorScript = contentScripts.some((script: any) => {
    const matches = Array.isArray(script?.matches) ? script.matches : [];
    const js = Array.isArray(script?.js) ? script.js : [];
    return matches.includes("<all_urls>") && js.includes("cursor.js") && script?.run_at === "document_start";
  });
  if (!hasCursorScript) issues.push("content_scripts must include cursor.js for <all_urls> at document_start");
  const minChrome = Number.parseInt(String(manifest.minimum_chrome_version ?? "0"), 10);
  if (!Number.isFinite(minChrome) || minChrome < 116) issues.push("minimum_chrome_version must be 116 or newer");

  if (issues.length > 0) {
    return fail("extension-manifest", "Extension manifest", issues.join("; "), { path: manifestPath });
  }
  return pass("extension-manifest", "Extension manifest", manifestPath, { path: manifestPath });
}

async function extensionManifestPath(layout: RuntimeLayout): Promise<string> {
  const distManifest = path.join(layout.extensionDir, "manifest.json");
  if (await access(distManifest, constants.R_OK).then(() => true).catch(() => false)) {
    return distManifest;
  }
  if (layout.mode === "repo") {
    return path.join(layout.root, "packages", "extension", "public", "manifest.json");
  }
  return distManifest;
}

async function checkBrowserInstalled(
  browser: BrowserKind,
  platform: NodeJS.Platform,
  overridePath: string | undefined,
): Promise<DoctorCheck> {
  const installPath = overridePath ?? browserInstallPath(browser, platform);
  if (!installPath) {
    return warn("browser-installed", "Browser installed", `automatic install check is not implemented on ${platform}`);
  }
  if (await exists(installPath)) {
    return pass("browser-installed", "Browser installed", installPath, { path: installPath });
  }
  return fail("browser-installed", "Browser installed", `not found at ${installPath}`, { path: installPath });
}

async function checkProfilePath(profileRoot: string): Promise<DoctorCheck> {
  if (await exists(profileRoot)) {
    return pass("profile-path", "Profile path", profileRoot, { path: profileRoot });
  }
  return warn("profile-path", "Profile path", `profile root not found at ${profileRoot}`, { path: profileRoot });
}

async function checkExtensionInstalled(
  profileRoot: string,
  extensionId: string | undefined,
  extensionCurrentDir?: string,
): Promise<DoctorCheck> {
  if (!extensionId) {
    return warn("extension-installed", "Extension installed/enabled", "extension id could not be derived");
  }
  const expectedPath = extensionCurrentDir ? await normalizeExistingOrResolvedPath(extensionCurrentDir) : undefined;
  const preferenceFiles = await findPreferenceFiles(profileRoot);
  for (const file of preferenceFiles) {
    const preferences = await readJson(file).catch(() => undefined);
    const settings = preferences?.extensions?.settings?.[extensionId];
    if (!settings) continue;
    const details = await extensionSettingsDetails(settings, file, expectedPath);
    if (settings.state === 0 || hasDisableReasons(settings.disable_reasons)) {
      return warn("extension-installed", "Extension installed/enabled", `extension is present but disabled in ${file}`, details);
    }
    if (expectedPath) {
      if (!details.path) {
        return warn(
          "extension-installed",
          "Extension installed/enabled",
          `extension is present in ${file}, but Chrome Preferences do not record the loaded unpacked path`,
          details,
        );
      }
      if (details.path !== expectedPath) {
        return warn(
          "extension-installed",
          "Extension installed/enabled",
          `extension is loaded from ${details.path}, expected ${expectedPath}`,
          details,
        );
      }
    }
    return pass("extension-installed", "Extension installed/enabled", `extension is present in ${file}`, details);
  }
  return warn("extension-installed", "Extension installed/enabled", `extension ${extensionId} was not found in profile preferences`);
}

async function checkNativeHostManifest(
  manifestPath: string,
  extensionId: string | undefined,
): Promise<DoctorCheck> {
  const manifest = await readJson(manifestPath).catch(() => undefined);
  if (!manifest) {
    return fail("native-host-manifest", "Native host manifest", `manifest not found or invalid at ${manifestPath}`, { path: manifestPath });
  }
  const issues: string[] = [];
  if (manifest.name !== HOST_NAME) issues.push(`name must be ${HOST_NAME}`);
  if (manifest.type !== "stdio") issues.push("type must be stdio");
  if (typeof manifest.path !== "string" || !path.isAbsolute(manifest.path)) issues.push("path must be absolute");
  const allowedOrigin = extensionId ? `chrome-extension://${extensionId}/` : undefined;
  if (allowedOrigin && !Array.isArray(manifest.allowed_origins)) issues.push("allowed_origins must be an array");
  if (allowedOrigin && Array.isArray(manifest.allowed_origins) && !manifest.allowed_origins.includes(allowedOrigin)) {
    issues.push(`allowed_origins must include ${allowedOrigin}`);
  }
  if (typeof manifest.path === "string") {
    const executable = await access(manifest.path, constants.X_OK).then(() => true).catch(() => false);
    if (!executable) issues.push(`native host path is not executable: ${manifest.path}`);
  }
  if (issues.length > 0) {
    return fail("native-host-manifest", "Native host manifest", issues.join("; "), { path: manifestPath });
  }
  return pass("native-host-manifest", "Native host manifest", manifestPath, { path: manifestPath });
}

async function checkHostVersion(hostBinary: string): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync(hostBinary, ["--version"], { timeout: 1000 });
    return pass("native-host-version", "Native host version", stdout.trim() || hostBinary, { path: hostBinary });
  } catch (error) {
    return warn("native-host-version", "Native host version", `could not execute ${hostBinary} --version`, { error: String(error) });
  }
}

async function checkRuntimeDir(runtimeDir: string): Promise<DoctorCheck> {
  const result = await validateRuntimeDir(runtimeDir);
  if (result.ok) {
    return pass("runtime-dir", "Runtime directory", runtimeDir, result.details);
  }
  const details = result.details ?? { path: runtimeDir };
  if (result.message?.includes("stat runtime directory failed")) {
    return warn("runtime-dir", "Runtime directory", `not found at ${runtimeDir}`, details);
  }
  return fail("runtime-dir", "Runtime directory", result.message ?? `invalid runtime directory: ${runtimeDir}`, details);
}

async function checkRuntimeDescriptorDir(descriptorDir: string): Promise<DoctorCheck> {
  const stats = await lstat(descriptorDir).catch(() => undefined);
  if (!stats) {
    return warn("runtime-descriptor-dir", "Runtime descriptor directory", `not found at ${descriptorDir}`, { path: descriptorDir });
  }
  if (stats.isSymbolicLink()) {
    return fail("runtime-descriptor-dir", "Runtime descriptor directory", "runtime descriptor directory is a symlink", { path: descriptorDir });
  }
  if (!stats.isDirectory()) {
    return fail("runtime-descriptor-dir", "Runtime descriptor directory", `not a directory: ${descriptorDir}`, { path: descriptorDir });
  }
  const uid = currentUid();
  if (process.platform !== "win32" && uid !== undefined && stats.uid !== uid) {
    return fail("runtime-descriptor-dir", "Runtime descriptor directory", "directory is not owned by current user", {
      path: descriptorDir,
      uid: stats.uid,
      expectedUid: uid,
    });
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    return fail("runtime-descriptor-dir", "Runtime descriptor directory", "permissions must be owner-only", {
      path: descriptorDir,
      mode: (stats.mode & 0o777).toString(8),
    });
  }
  return pass("runtime-descriptor-dir", "Runtime descriptor directory", descriptorDir, { path: descriptorDir });
}

async function checkRuntimeDescriptors(descriptorDir: string): Promise<DoctorCheck> {
  const files = await readdir(descriptorDir).catch(() => []);
  const descriptors = files.filter((file) => file.endsWith(".json"));
  if (descriptors.length === 0) {
    return warn("runtime-descriptor-probe", "Runtime descriptor probe", "no active WebExtension descriptor found");
  }
  const errors: string[] = [];
  for (const file of descriptors) {
    const descriptorPath = path.join(descriptorDir, file);
    const fileIssue = await validateRuntimeDescriptorFile(descriptorPath);
    if (fileIssue) {
      errors.push(`${file}: ${fileIssue}`);
      continue;
    }
    const descriptor = await readJson(descriptorPath).catch((error) => {
      errors.push(`${file}: invalid json (${error})`);
      return undefined;
    });
    if (!descriptor) continue;
    const result = await probeDescriptor(descriptor);
    if (result.ok) {
      const details = {
        descriptor: file,
        ...result.details,
      };
      const staleLifecycle = staleLifecycleSummary(result.details.lifecycle);
      if (staleLifecycle) {
        return warn(
          "runtime-descriptor-probe",
          "Runtime descriptor probe",
          `${file} responded to getInfo with stale lifecycle state: ${staleLifecycle}`,
          details,
        );
      }
      return pass("runtime-descriptor-probe", "Runtime descriptor probe", `${file} responded to getInfo`, details);
    }
    errors.push(`${file}: ${result.message}`);
  }
  return fail("runtime-descriptor-probe", "Runtime descriptor probe", errors.join("; "));
}

async function probeDescriptor(descriptor: Record<string, unknown>): Promise<RuntimeDescriptorProbeResult> {
  if (descriptor.schema_version !== 1) return probeError("schema_version must be 1");
  if (descriptor.type !== "webextension") return probeError("type must be webextension");
  if (typeof descriptor.socketPath !== "string") return probeError("socketPath missing");
  if (typeof descriptor.sdk_auth_token !== "string") return probeError("sdk_auth_token missing");
  const processIssue = descriptorProcessIssue(descriptor);
  if (processIssue) return probeError(processIssue);
  if (process.platform === "win32") return probeError("socket probe is not implemented on Windows");
  const socketIssue = await validateDescriptorSocket(descriptor.socketPath);
  if (socketIssue) return probeError(socketIssue);
  try {
    const [auth, info] = await rpcSequenceOverUnixSocket(descriptor.socketPath, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "auth",
        params: { capability_token: descriptor.sdk_auth_token },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "getInfo",
        params: {},
      },
    ]);
    if (auth.error) return probeError("auth rejected");
    if (info.error) return probeError(`getInfo failed: ${JSON.stringify(info.error)}`);
    if (info.result?.type !== "webextension") return probeError("getInfo type mismatch");
    if (info.result?.name !== descriptor.name) return probeError("getInfo name mismatch");
    return {
      ok: true,
      details: runtimeDescriptorProbeDetails(info.result),
    };
  } catch (error) {
    return probeError(`socket probe failed: ${String(error)}`);
  }
}

function probeError(message: string): RuntimeDescriptorProbeResult {
  return { ok: false, message };
}

function runtimeDescriptorProbeDetails(infoResult: Record<string, any>): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const lifecycle = infoResult.metadata?.diagnostics?.lifecycle;
  if (isRecord(lifecycle)) {
    details.lifecycle = lifecycle;
    const deliverableCount = lifecycle.deliverable_tabs;
    const deliverableSummaries = lifecycle.deliverable_tab_summaries;
    if (
      (typeof deliverableCount === "number" && deliverableCount > 0)
      || (Array.isArray(deliverableSummaries) && deliverableSummaries.length > 0)
    ) {
      details.deliverable_recovery = "run await browser.deliverables(), then call claim() on the tab to recover";
    }
  }
  return details;
}

function staleLifecycleSummary(lifecycle: unknown): string | undefined {
  if (!isRecord(lifecycle)) return undefined;
  const parts: string[] = [];
  for (const key of ["stale_sessions", "stale_tabs", "stale_file_choosers", "stale_downloads"]) {
    const value = lifecycle[key];
    if (typeof value === "number" && value > 0) parts.push(`${key}=${value}`);
  }
  const staleSessionReasons = lifecycle.stale_session_reasons;
  if (Array.isArray(staleSessionReasons) && staleSessionReasons.length > 0) {
    parts.push(`stale_session_reasons=${staleSessionReasons.length}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateRuntimeDescriptorFile(descriptorPath: string): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const stats = await lstat(descriptorPath).catch((error) => `stat descriptor failed: ${String(error)}`);
  if (typeof stats === "string") return stats;
  if (stats.isSymbolicLink()) return "descriptor is a symlink";
  if (!stats.isFile()) return "descriptor is not a file";
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) return "descriptor is not owned by current user";
  if ((stats.mode & 0o077) !== 0) return "descriptor permissions must be owner-only";
  return undefined;
}

function descriptorProcessIssue(descriptor: Record<string, unknown>): string | undefined {
  if (process.platform === "win32") return undefined;
  const pid = descriptor.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || Number(pid) > 2_147_483_647) {
    return "descriptor pid missing or invalid";
  }
  try {
    process.kill(Number(pid), 0);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return undefined;
    return "descriptor process is not alive";
  }
}

async function validateDescriptorSocket(socketPath: string): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const stats = await stat(socketPath).catch((error) => `stat descriptor socket failed: ${String(error)}`);
  if (typeof stats === "string") return stats;
  if (!stats.isSocket()) return "descriptor socket path is not a socket";
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) return "descriptor socket is not owned by current user";
  if ((stats.mode & 0o077) !== 0) return "descriptor socket permissions must be owner-only";
  return undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function rpcSequenceOverUnixSocket(
  socketPath: string,
  payloads: Record<string, unknown>[],
): Promise<Record<string, any>[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, 500);
    let buffer = Buffer.alloc(0);
    let nextRequest = 0;
    const responses: Record<string, any>[] = [];
    const finish = (value: Record<string, any>[]) => {
      clearTimeout(timer);
      socket.end();
      resolve(value);
    };
    const fail = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const writeNext = () => {
      if (nextRequest >= payloads.length) {
        finish(responses);
        return;
      }
      socket.write(encodeFrame(payloads[nextRequest]!));
    };
    socket.once("error", (error) => {
      fail(error);
    });
    socket.once("connect", writeNext);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        try {
          responses.push(JSON.parse(body.toString("utf8")));
        } catch (error) {
          fail(error);
          return;
        }
        nextRequest += 1;
        writeNext();
      }
    });
  });
}

function encodeFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

async function readExtensionId(manifestPath: string): Promise<string> {
  const manifest = await readJson(manifestPath);
  return extensionIdFromManifestKey(manifest.key);
}

function extensionIdFromManifestKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) throw new Error("manifest key is required");
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...hash].map((byte) => `${nibbleToIdChar(byte >> 4)}${nibbleToIdChar(byte & 0x0f)}`).join("");
}

function nibbleToIdChar(nibble: number): string {
  return String.fromCharCode(EXTENSION_ID_ALPHABET_OFFSET + nibble);
}

async function findPreferenceFiles(profileRoot: string): Promise<string[]> {
  const entries = await readdir(profileRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile ")))
    .flatMap((entry) => [
      path.join(profileRoot, entry.name, "Preferences"),
      path.join(profileRoot, entry.name, "Secure Preferences"),
    ]);
}

function hasDisableReasons(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

async function extensionSettingsDetails(
  settings: Record<string, unknown>,
  preferenceFile: string,
  expectedPath: string | undefined,
): Promise<Record<string, unknown>> {
  const rawPath = typeof settings.path === "string" && settings.path.length > 0
    ? settings.path
    : undefined;
  const loadedPath = rawPath ? await normalizeExistingOrResolvedPath(resolvePreferencePath(rawPath, preferenceFile)) : undefined;
  const manifest = isRecord(settings.manifest) ? settings.manifest : undefined;
  const details: Record<string, unknown> = {
    file: preferenceFile,
    state: settings.state,
    ...(settings.disable_reasons === undefined ? {} : { disable_reasons: settings.disable_reasons }),
    ...(loadedPath === undefined ? {} : { path: loadedPath }),
    ...(rawPath === undefined ? {} : { rawPath }),
    ...(typeof manifest?.version === "string" ? { version: manifest.version } : {}),
    ...(expectedPath === undefined ? {} : { expectedPath }),
  };
  return details;
}

async function normalizeExistingOrResolvedPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const canonical = await realpath(resolved).catch(() => resolved);
  return caseNormalizePath(canonical);
}

function caseNormalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function resolvePreferencePath(value: string, preferenceFile: string): string {
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(preferenceFile), value);
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true).catch(() => false);
}

function pass(id: string, label: string, message: string, details?: Record<string, unknown>): DoctorCheck {
  return check(id, label, "pass", message, details);
}

function warn(id: string, label: string, message: string, details?: Record<string, unknown>): DoctorCheck {
  return check(id, label, "warn", message, details);
}

function fail(id: string, label: string, message: string, details?: Record<string, unknown>): DoctorCheck {
  return check(id, label, "fail", message, details);
}

function check(
  id: string,
  label: string,
  status: DoctorStatus,
  message: string,
  details?: Record<string, unknown>,
): DoctorCheck {
  const result: DoctorCheck = { id, label, status, message };
  const repair = repairHint(id, status);
  const mergedDetails = details === undefined ? {} : { ...details };
  if (repair) mergedDetails.repair = repair;
  if (Object.keys(mergedDetails).length > 0) result.details = mergedDetails;
  return result;
}

function repairHint(id: string, status: DoctorStatus): string | undefined {
  if (status === "pass") return undefined;
  switch (id) {
    case "extension-manifest":
      return "Rebuild and reload packages/extension so the installed manifest has the required permissions and cursor content script.";
    case "browser-installed":
      return "Install the selected browser, or rerun with --browser for a browser that is installed.";
    case "profile-path":
      return "Launch the selected browser once with the profile you want open-browser-use to inspect.";
    case "extension-installed":
      return "Load packages/extension/dist as an unpacked extension, keep it enabled, then reopen the popup.";
    case "native-host-manifest":
      return "Regenerate the native messaging manifest and confirm it points at an executable obu-host for this extension id.";
    case "native-host-version":
      return "Build obu-host and make sure the doctor is checking the intended host binary.";
    case "runtime-dir":
      return "Repair the runtime directory to an owner-only real directory, then rerun doctor.";
    case "runtime-descriptor-dir":
      return "Repair the runtime descriptor directory to owner-only, then open the extension popup and click Resume.";
    case "runtime-descriptor-probe":
      return "Run --repair if offered, then open the extension popup and click Resume to retry the native-host connection; rerun doctor after it reconnects.";
    default:
      return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
