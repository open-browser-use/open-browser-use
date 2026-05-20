import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { hasActiveWebExtensionRuntimeDescriptor } from "./doctor-browser.js";
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
    ]);
  }

  const versionDir = path.join(options.layout.extensionInstallRoot, "versions", manifest.version);
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
    return result("manual_action_required", dryRun, options.layout, steps);
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
    return result("failed", dryRun, options.layout, steps);
  }

  if (noWait) {
    steps.push({
      id: "runtime-descriptor-probe",
      status: "skipped",
      message: "skipped runtime descriptor wait",
      details: { runtimeDir: options.layout.runtimeDir },
    });
    return result("manual_action_required", dryRun, options.layout, steps);
  }

  if (await hasActiveWebExtensionRuntimeDescriptor(options.layout.runtimeDir)) {
    steps.push({
      id: "runtime-descriptor-probe",
      status: "applied",
      message: "found an active WebExtension runtime descriptor",
      details: { runtimeDir: options.layout.runtimeDir },
    });
    return result("complete", dryRun, options.layout, steps);
  }

  steps.push({
    id: "runtime-descriptor-probe",
    status: "manual_action_required",
    message: "no active WebExtension runtime descriptor found",
    details: { runtimeDir: options.layout.runtimeDir },
  });
  return result("manual_action_required", dryRun, options.layout, steps);
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
  return raw as ExtensionManifest;
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
): ExtensionUpdateResult {
  const verifyAction = verifyNextAction(layout);
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

function verifyNextAction(layout: RuntimeLayout): ExtensionUpdateResult["nextActions"][number] {
  const channel = layout.userConfig?.extensionChannel ?? "<channel>";
  const extensionId = layout.userConfig?.extensionChannel === "store" && layout.userConfig.storeExtensionId
    ? layout.userConfig.storeExtensionId
    : "<extension-id>";
  return {
    kind: "manual",
    value: `Choose the agent and browser target, then run obu verify --agent=<agent-id> --browser=<browser> --channel=${channel} --extension-id=${extensionId}.`,
  };
}
