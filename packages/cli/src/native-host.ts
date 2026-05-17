import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nativeMessagingHostDir, type BrowserKind } from "./browser-paths.js";
import type { RuntimeLayout } from "./runtime-layout.js";

const HOST_NAME = "dev.obu.host";
const EXTENSION_ID_ALPHABET_OFFSET = "a".charCodeAt(0);

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
  const extensionId = options.extensionId ?? await readExtensionId(await extensionManifestPath(options.layout, options.manifestPath));
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
  const wrapperDir = path.join(input.layout.nativeHostInstallRoot, HOST_NAME, input.browser);
  const wrapperPath = path.join(wrapperDir, "obu-host-wrapper");
  const nativeManifestDir = nativeMessagingHostDir(input.browser, input.platform, input.homeDir);
  const nativeManifestPath = path.join(nativeManifestDir, `${HOST_NAME}.json`);
  const wrapper = nativeHostWrapper({
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
      details: { wrapperPath, nativeManifestPath },
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
    details: { wrapperPath, nativeManifestPath },
  };
}

function nativeHostWrapper(input: { hostBin: string; browser: BrowserKind; runtimeDir: string }): string {
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

async function writeIfChanged(file: string, content: string, mode: number): Promise<boolean> {
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current === content) {
    await chmod(file, mode);
    return false;
  }
  await writeFile(file, content, { encoding: "utf8", mode });
  await chmod(file, mode);
  return true;
}

async function extensionManifestPath(layout: RuntimeLayout, overridePath?: string): Promise<string> {
  if (overridePath) return overridePath;
  const distManifest = path.join(layout.extensionDir, "manifest.json");
  if (await access(distManifest, constants.R_OK).then(() => true).catch(() => false)) {
    return distManifest;
  }
  return path.join(layout.root, "packages", "extension", "public", "manifest.json");
}

async function readExtensionId(manifestPath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { key?: unknown };
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

function browserRuntimeKind(browser: BrowserKind): string {
  return browser === "chrome-for-testing" ? "chrome" : browser;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
