import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nativeMessagingHostDir, type BrowserKind } from "./browser-paths.js";
import { extensionManifestPath, readExtensionIdFromManifest } from "./extension-channel.js";
import type { RuntimeLayout } from "./runtime-layout.js";

const HOST_NAME = "dev.obu.host";

export type InstallHostStatus = "applied" | "skipped" | "would_apply" | "failed";

export type InstallHostAction = {
  id: string;
  browser: BrowserKind;
  status: InstallHostStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type InstallNativeHostsOptions = {
  layout: RuntimeLayout;
  browsers: BrowserKind[];
  platform?: NodeJS.Platform;
  homeDir?: string;
  manifestPath?: string;
  extensionId?: string;
  dryRun?: boolean;
};

export function supportedNativeHostBrowsers(platform: NodeJS.Platform = process.platform): BrowserKind[] {
  if (platform === "darwin") return ["chrome", "chrome-for-testing", "edge", "brave", "arc", "chromium"];
  if (platform === "linux") return ["chrome", "chrome-for-testing", "edge", "brave", "chromium"];
  return [];
}

export async function installNativeHosts(options: InstallNativeHostsOptions): Promise<InstallHostAction[]> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homeDirFromLayout(options.layout) ?? os.homedir();
  if (platform !== "darwin" && platform !== "linux") {
    return options.browsers.map((browser) => ({
      id: "native-host-install",
      browser,
      status: "failed",
      message: `native-host install is not supported on ${platform}`,
      details: { platform },
    }));
  }
  const hostExecutable = await access(options.layout.hostBin, constants.X_OK)
    .then(() => true)
    .catch(() => false);
  if (!hostExecutable) {
    return options.browsers.map((browser) => ({
      id: "native-host-install",
      browser,
      status: "failed",
      message: `obu-host is not executable at ${options.layout.hostBin}`,
      details: { hostBin: options.layout.hostBin },
    }));
  }
  const extensionId = options.extensionId ?? await readExtensionIdFromManifest(await extensionManifestPath(options.layout, options.manifestPath));
  const actions: InstallHostAction[] = [];
  for (const browser of options.browsers) {
    actions.push(await installNativeHost({
      layout: options.layout,
      browser,
      platform,
      homeDir,
      extensionId,
      dryRun: options.dryRun === true,
    }));
  }
  return actions;
}

function homeDirFromLayout(layout: RuntimeLayout): string | undefined {
  const obuDir = path.dirname(layout.userConfigPath);
  return path.basename(obuDir) === ".obu" ? path.dirname(obuDir) : undefined;
}

async function installNativeHost(input: {
  layout: RuntimeLayout;
  browser: BrowserKind;
  platform: NodeJS.Platform;
  homeDir: string;
  extensionId: string;
  dryRun: boolean;
}): Promise<InstallHostAction> {
  const wrapperPath = nativeHostWrapperPath({
    nativeHostInstallRoot: input.layout.nativeHostInstallRoot,
    browser: input.browser,
  });
  const wrapperDir = path.dirname(wrapperPath);
  const nativeManifestDir = nativeMessagingHostDir(input.browser, input.platform, input.homeDir);
  const nativeManifestPath = path.join(nativeManifestDir, `${HOST_NAME}.json`);
  const wrapper = nativeHostWrapperContent({
    hostBin: input.layout.hostBin,
    browser: input.browser,
    runtimeDir: input.layout.runtimeDir,
  });
  const manifest = `${JSON.stringify({
    name: HOST_NAME,
    description: "open-browser-use native messaging host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${input.extensionId}/`],
  }, null, 2)}\n`;

  if (input.dryRun) {
    return {
      id: "native-host-install",
      browser: input.browser,
      status: "would_apply",
      message: `would write native-host wrapper and manifest for ${input.browser}`,
      details: { wrapperPath, nativeManifestPath, extensionId: input.extensionId },
    };
  }

  await mkdir(wrapperDir, { recursive: true, mode: 0o700 });
  await mkdir(nativeManifestDir, { recursive: true });
  const wrapperChanged = await writeIfChanged(wrapperPath, wrapper, 0o755);
  const manifestChanged = await writeIfChanged(nativeManifestPath, manifest, 0o644);
  return {
    id: "native-host-install",
    browser: input.browser,
    status: wrapperChanged || manifestChanged ? "applied" : "skipped",
    message: wrapperChanged || manifestChanged
      ? `installed native-host wrapper and manifest for ${input.browser}`
      : `native-host wrapper and manifest already current for ${input.browser}`,
    details: { wrapperPath, nativeManifestPath, extensionId: input.extensionId },
  };
}

export function nativeHostWrapperPath(input: { nativeHostInstallRoot: string; browser: BrowserKind }): string {
  return path.join(input.nativeHostInstallRoot, HOST_NAME, input.browser, "obu-host-wrapper");
}

export function nativeHostWrapperContent(input: { hostBin: string; browser: BrowserKind; runtimeDir: string }): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `export OBU_BROWSER_KIND=${shellQuote(browserRuntimeKind(input.browser))}`,
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
    `exec ${shellQuote(input.hostBin)} --native-messaging`,
    "",
  ].join("\n");
}

export async function writeIfChanged(file: string, content: string, mode: number): Promise<boolean> {
  const existing = await lstat(file).catch((error) => error as NodeJS.ErrnoException);
  const exists = !(existing instanceof Error);
  if (exists) {
    if (existing.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${file}`);
    if (!existing.isFile()) throw new Error(`refusing to overwrite non-file path: ${file}`);
  } else if (existing.code !== "ENOENT") {
    throw existing;
  }
  const current = exists ? await readFile(file, "utf8") : undefined;
  if (current === content) {
    const latest = await lstat(file);
    if (latest.isSymbolicLink()) throw new Error(`refusing to chmod symlink: ${file}`);
    if (!latest.isFile()) throw new Error(`refusing to chmod non-file path: ${file}`);
    await chmod(file, mode);
    return false;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await writeFile(temp, content, { encoding: "utf8", mode });
    await chmod(temp, mode);
    const latest = await lstat(file).catch((error) => error as NodeJS.ErrnoException);
    if (!(latest instanceof Error)) {
      if (latest.isSymbolicLink()) throw new Error(`refusing to replace symlink: ${file}`);
      if (!latest.isFile()) throw new Error(`refusing to replace non-file path: ${file}`);
    } else if (latest.code !== "ENOENT") {
      throw latest;
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

function browserRuntimeKind(browser: BrowserKind): string {
  return browser === "chrome-for-testing" ? "chrome" : browser;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
