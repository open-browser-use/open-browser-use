import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { RuntimeLayout, UserConfig } from "./runtime-layout.js";

export type ExtensionChannel = "unpacked-dev" | "store";

export type ExtensionIdSource =
  | "explicit-argument"
  | "environment"
  | "user-config"
  | "payload-metadata"
  | "repo-release-metadata"
  | "manifest-key";

export type ExtensionTarget = {
  channel: ExtensionChannel;
  extensionId: string;
  extensionIdSource: ExtensionIdSource;
  manifestPath?: string;
};

export type ResolveExtensionTargetOptions = {
  layout: RuntimeLayout;
  channel?: string | undefined;
  explicitExtensionId?: string | undefined;
  manifestPath?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
};

type PayloadMetadata = {
  extensionChannel?: unknown;
  extensionId?: unknown;
  storeExtensionId?: unknown;
};

type RepoReleaseMetadata = {
  store?: {
    storeExtensionId?: unknown;
    storeDraftVerified?: unknown;
    status?: unknown;
  };
};

export function parseExtensionChannel(value: string | undefined, fallback?: ExtensionChannel): ExtensionChannel {
  const channel = value ?? fallback ?? "unpacked-dev";
  if (channel === "unpacked-dev" || channel === "store") return channel;
  throw new Error(`unsupported extension channel: ${channel}. Supported channels: unpacked-dev, store.`);
}

export async function resolveExtensionTarget(options: ResolveExtensionTargetOptions): Promise<ExtensionTarget> {
  const channel = parseExtensionChannel(options.channel, options.layout.userConfig?.extensionChannel);
  if (channel === "unpacked-dev") {
    return resolveUnpackedDevTarget(options.layout, options.explicitExtensionId, options.manifestPath);
  }
  return resolveStoreTarget(options);
}

export function assertExtensionId(value: string, label: string): void {
  if (!isExtensionId(value)) {
    throw new Error(`${label} must be a 32-character Chrome extension id using letters a-p`);
  }
}

export function isExtensionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
}

export function extensionIdFromManifestKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) throw new Error("manifest key is required");
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...hash].map((byte) => `${nibbleToIdChar(byte >> 4)}${nibbleToIdChar(byte & 0x0f)}`).join("");
}

export async function readExtensionIdFromManifest(manifestPath: string): Promise<string> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { key?: unknown };
  return extensionIdFromManifestKey(manifest.key);
}

export async function extensionManifestPath(layout: RuntimeLayout, overridePath?: string): Promise<string> {
  if (overridePath) return overridePath;
  const distManifest = path.join(layout.extensionDir, "manifest.json");
  if (await access(distManifest, constants.R_OK).then(() => true).catch(() => false)) {
    return distManifest;
  }
  return path.join(layout.root, "packages", "extension", "public", "manifest.json");
}

async function resolveUnpackedDevTarget(
  layout: RuntimeLayout,
  explicitExtensionId: string | undefined,
  manifestOverride: string | undefined,
): Promise<ExtensionTarget> {
  if (explicitExtensionId) {
    assertExtensionId(explicitExtensionId, "--extension-id");
    return {
      channel: "unpacked-dev",
      extensionId: explicitExtensionId,
      extensionIdSource: "explicit-argument",
    };
  }
  const manifestPath = await extensionManifestPath(layout, manifestOverride);
  return {
    channel: "unpacked-dev",
    extensionId: await readExtensionIdFromManifest(manifestPath),
    extensionIdSource: "manifest-key",
    manifestPath,
  };
}

async function resolveStoreTarget(options: ResolveExtensionTargetOptions): Promise<ExtensionTarget> {
  const explicit = options.explicitExtensionId;
  if (explicit) {
    assertExtensionId(explicit, "--extension-id");
    return {
      channel: "store",
      extensionId: explicit,
      extensionIdSource: "explicit-argument",
    };
  }

  const envId = options.env?.OBU_STORE_EXTENSION_ID;
  if (envId) {
    assertExtensionId(envId, "OBU_STORE_EXTENSION_ID");
    return {
      channel: "store",
      extensionId: envId,
      extensionIdSource: "environment",
    };
  }

  const configId = options.layout.userConfig?.storeExtensionId;
  if (configId) {
    assertExtensionId(configId, "user config storeExtensionId");
    return {
      channel: "store",
      extensionId: configId,
      extensionIdSource: "user-config",
    };
  }

  const payloadId = await readPayloadStoreExtensionId(options.layout.metadataPath);
  if (payloadId) {
    return {
      channel: "store",
      extensionId: payloadId,
      extensionIdSource: "payload-metadata",
    };
  }

  const releaseId = await readVerifiedRepoStoreExtensionId(options.layout.root);
  if (releaseId) {
    return {
      channel: "store",
      extensionId: releaseId,
      extensionIdSource: "repo-release-metadata",
    };
  }

  throw new Error(
    "store extension id is not configured. Pass --extension-id <id>, set OBU_STORE_EXTENSION_ID, or assemble a payload with --store-extension-id.",
  );
}

async function readPayloadStoreExtensionId(metadataPath: string | undefined): Promise<string | undefined> {
  if (!metadataPath) return undefined;
  const metadata = await readJson<PayloadMetadata>(metadataPath);
  if (!metadata) return undefined;
  const storeExtensionId = metadata.storeExtensionId;
  if (isExtensionId(storeExtensionId)) return storeExtensionId;
  if (metadata.extensionChannel === "store" && isExtensionId(metadata.extensionId)) return metadata.extensionId;
  return undefined;
}

async function readVerifiedRepoStoreExtensionId(root: string): Promise<string | undefined> {
  const file = path.join(root, "packages", "extension", "release-metadata.json");
  const metadata = await readJson<RepoReleaseMetadata>(file);
  const store = metadata?.store;
  if (!store) return undefined;
  if (store.storeDraftVerified !== true && store.status !== "verified") return undefined;
  return isExtensionId(store.storeExtensionId) ? store.storeExtensionId : undefined;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function nibbleToIdChar(nibble: number): string {
  return String.fromCharCode("a".charCodeAt(0) + nibble);
}

export function userConfigForExtensionTarget(layout: RuntimeLayout, target: ExtensionTarget): UserConfig {
  return {
    schemaVersion: 1,
    runtimeDir: layout.runtimeDir,
    extensionCurrentDir: layout.extensionCurrentDir,
    nativeHostInstallRoot: layout.nativeHostInstallRoot,
    extensionChannel: target.channel,
    ...(target.channel === "store" ? { storeExtensionId: target.extensionId } : {}),
  };
}
