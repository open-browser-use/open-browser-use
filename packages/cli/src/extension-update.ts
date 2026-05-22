import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { hasActiveWebExtensionRuntimeDescriptor } from "./doctor-browser.js";
import { extensionIdFromManifestKey, type ExtensionChannel } from "./extension-channel.js";
import type { RuntimeLayout } from "./runtime-layout.js";

export type ExtensionUpdateStatus = "applied" | "skipped" | "would_apply" | "manual_action_required" | "failed";

export type ExtensionUpdateStep = {
  id: string;
  status: ExtensionUpdateStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type ExtensionUpdateResult = {
  schemaVersion: 1;
  command: "update-extension";
  dryRun: boolean;
  result: "complete" | "manual_action_required" | "failed";
  extensionCurrentDir: string;
  steps: ExtensionUpdateStep[];
  nextActions: Array<{ kind: "command" | "manual" | "docs"; value: string }>;
};

export type UpdateExtensionOptions = {
  layout: RuntimeLayout;
  sourceDir?: string;
  dryRun?: boolean;
  noWait?: boolean;
  verifyTarget?: {
    channel: ExtensionChannel;
    extensionId?: string;
  };
};

export async function updateExtension(options: UpdateExtensionOptions): Promise<ExtensionUpdateResult> {
  const dryRun = options.dryRun === true;
  const noWait = options.noWait === true;
  const sourceDir = path.resolve(options.sourceDir ?? options.layout.extensionDir);
  const currentDir = options.layout.extensionCurrentDir;
  const steps: ExtensionUpdateStep[] = [];

  let manifest: ExtensionManifest;
  try {
    manifest = await readExtensionManifest(sourceDir);
    steps.push({
      id: "extension-source",
      status: "applied",
      message: `validated extension payload ${sourceDir}`,
      details: { sourceDir, version: manifest.version },
    });
  } catch (error) {
    return result("failed", dryRun, options.layout, [
      {
        id: "extension-source",
        status: "failed",
        message: `could not validate extension payload ${sourceDir}`,
        details: { sourceDir, error: String(error) },
      },
    ], options.verifyTarget);
  }

  const versionDir = extensionVersionDir(options.layout.extensionInstallRoot, manifest.version);
  if (dryRun) {
    steps.push({
      id: "extension-stage",
      status: "would_apply",
      message: `would stage extension payload ${manifest.version}`,
      details: { sourceDir, versionDir },
    });
    steps.push({
      id: "extension-current",
      status: "would_apply",
      message: `would refresh stable extension path ${currentDir}`,
      details: { currentDir },
    });
    return result("manual_action_required", dryRun, options.layout, steps, options.verifyTarget, manifest);
  }

  try {
    await stageVersion(sourceDir, versionDir, options.layout.extensionInstallRoot);
    steps.push({
      id: "extension-stage",
      status: "applied",
      message: `staged extension payload ${manifest.version}`,
      details: { versionDir },
    });
    await replaceCurrentDir(versionDir, currentDir);
    steps.push({
      id: "extension-current",
      status: "applied",
      message: `refreshed stable extension path ${currentDir}`,
      details: { currentDir },
    });
  } catch (error) {
    steps.push({
      id: "extension-current",
      status: "failed",
      message: `could not refresh stable extension path ${currentDir}`,
      details: { currentDir, error: String(error) },
    });
    return result("failed", dryRun, options.layout, steps, options.verifyTarget, manifest);
  }

  if (noWait) {
    steps.push({
      id: "runtime-descriptor-probe",
      status: "skipped",
      message: "skipped runtime descriptor wait",
      details: { runtimeDir: options.layout.runtimeDir },
    });
    return result("manual_action_required", dryRun, options.layout, steps, options.verifyTarget, manifest);
  }

  if (await hasActiveWebExtensionRuntimeDescriptor(options.layout.runtimeDir, descriptorTarget(options.verifyTarget, manifest))) {
    steps.push({
      id: "runtime-descriptor-probe",
      status: "applied",
      message: "found an active WebExtension runtime descriptor",
      details: { runtimeDir: options.layout.runtimeDir },
    });
    return result("complete", dryRun, options.layout, steps, options.verifyTarget, manifest);
  }

  steps.push({
    id: "runtime-descriptor-probe",
    status: "manual_action_required",
    message: "no active WebExtension runtime descriptor found",
    details: { runtimeDir: options.layout.runtimeDir },
  });
  return result("manual_action_required", dryRun, options.layout, steps, options.verifyTarget, manifest);
}

type ExtensionManifest = {
  manifest_version: number;
  version: string;
  key?: string;
};

async function readExtensionManifest(sourceDir: string): Promise<ExtensionManifest> {
  const raw = JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8")) as Partial<ExtensionManifest>;
  if (raw.manifest_version !== 3) throw new Error("manifest_version must be 3");
  if (typeof raw.version !== "string" || raw.version.length === 0) throw new Error("manifest version is required");
  validateChromeManifestVersion(raw.version);
  return raw as ExtensionManifest;
}

function validateChromeManifestVersion(version: string): void {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4) {
    throw new Error("manifest version must contain one to four dot-separated integers");
  }
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part)) {
      throw new Error("manifest version must contain only non-negative integer segments without path characters");
    }
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value > 65535) {
      throw new Error("manifest version segments must be integers between 0 and 65535");
    }
  }
}

function extensionVersionDir(installRoot: string, version: string): string {
  const versionsRoot = path.resolve(installRoot, "versions");
  const versionDir = path.resolve(versionsRoot, version);
  if (!isPathInside(versionDir, versionsRoot)) {
    throw new Error("manifest version resolved outside extension versions directory");
  }
  return versionDir;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function descriptorTarget(
  target: UpdateExtensionOptions["verifyTarget"],
  manifest: ExtensionManifest | undefined,
): { extensionId?: string } | undefined {
  const extensionId = target?.extensionId ?? extensionIdForVerify(manifest);
  return extensionId ? { extensionId } : undefined;
}

async function stageVersion(sourceDir: string, versionDir: string, installRoot: string): Promise<void> {
  await mkdir(path.dirname(versionDir), { recursive: true, mode: 0o700 });
  const tempDir = path.join(installRoot, `.stage-${process.pid}-${Date.now()}`);
  await rm(tempDir, { recursive: true, force: true });
  await cp(sourceDir, tempDir, { recursive: true, force: true });
  await rm(versionDir, { recursive: true, force: true });
  await rename(tempDir, versionDir);
}

async function replaceCurrentDir(versionDir: string, currentDir: string): Promise<void> {
  await mkdir(path.dirname(currentDir), { recursive: true, mode: 0o700 });
  const tempDir = `${currentDir}.tmp-${process.pid}-${Date.now()}`;
  const oldDir = `${currentDir}.old-${process.pid}-${Date.now()}`;
  await rm(tempDir, { recursive: true, force: true });
  await rm(oldDir, { recursive: true, force: true });
  await cp(versionDir, tempDir, { recursive: true, force: true });
  try {
    await rename(currentDir, oldDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  try {
    await rename(tempDir, currentDir);
  } catch (error) {
    await rename(oldDir, currentDir).catch(() => undefined);
    throw error;
  }
  await rm(oldDir, { recursive: true, force: true });
}

function result(
  state: ExtensionUpdateResult["result"],
  dryRun: boolean,
  layout: RuntimeLayout,
  steps: ExtensionUpdateStep[],
  verifyTarget?: UpdateExtensionOptions["verifyTarget"],
  manifest?: ExtensionManifest,
): ExtensionUpdateResult {
  const verifyAction = verifyNextAction(verifyTarget, manifest);
  const nextActions: ExtensionUpdateResult["nextActions"] = state === "complete"
    ? [verifyAction]
    : [
      {
        kind: "manual",
        value: `Open chrome://extensions, enable Developer mode, then Load unpacked or Reload the open-browser-use extension from ${layout.extensionCurrentDir}`,
      },
      verifyAction,
    ];
  return {
    schemaVersion: 1,
    command: "update-extension",
    dryRun,
    result: state,
    extensionCurrentDir: layout.extensionCurrentDir,
    steps,
    nextActions,
  };
}

function verifyNextAction(
  verifyTarget: UpdateExtensionOptions["verifyTarget"],
  manifest?: ExtensionManifest,
): ExtensionUpdateResult["nextActions"][number] {
  const channel = verifyTarget?.channel ?? "unpacked-dev";
  const extensionId = verifyTarget?.extensionId ?? extensionIdForVerify(manifest) ?? "<extension-id>";
  return {
    kind: "manual",
    value: `Choose the agent and browser target, then run obu verify --agent=<agent-id> --browser=<browser> --channel=${channel} --extension-id=${extensionId}.`,
  };
}

function extensionIdForVerify(manifest: ExtensionManifest | undefined): string | undefined {
  if (!manifest?.key) return undefined;
  try {
    return extensionIdFromManifestKey(manifest.key);
  } catch {
    return undefined;
  }
}
