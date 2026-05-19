#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const extensionDist = args.dist ?? path.join(root, "packages", "extension", "dist");
const outDir = args.out ?? path.join(root, "dist", "chrome-web-store");
const storeExtensionId = args.storeExtensionId ?? process.env.OBU_STORE_EXTENSION_ID ?? undefined;

if (storeExtensionId !== undefined && !/^[a-p]{32}$/.test(storeExtensionId)) {
  throw new Error("--store-extension-id must be a 32-char a-p Chrome extension id");
}

const files = await listFiles(extensionDist);
assertStoreContents(files);
const manifest = JSON.parse(await readFile(path.join(extensionDist, "manifest.json"), "utf8"));
const { sourceManifestKeyId, version } = assertStoreManifest(manifest);
assertStorePopup(await readFile(path.join(extensionDist, "popup.js"), "utf8"));

await rm(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(outDir, { recursive: true });

const stagingDir = path.join(outDir, "__store-staging");
await stageStoreUpload(extensionDist, stagingDir, files, manifest);

const zipName = `open-browser-use-chrome-web-store-${version}.zip`;
const zipPath = path.join(outDir, zipName);
const zip = spawnSync("zip", ["-X", "-q", zipPath, ...files], { cwd: stagingDir, encoding: "utf8" });
if (zip.error) throw zip.error;
if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr || zip.stdout}`);
await rm(stagingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const sha256 = await sha256File(zipPath);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  extensionChannel: "store",
  storeExtensionId: storeExtensionId ?? null,
  storeExtensionIdStatus: storeExtensionId ? "provided" : "pending-chrome-web-store-draft",
  sourceManifestKeyId: sourceManifestKeyId ?? null,
  manifestKeyPolicy: "omitted-for-store-upload",
  popupChannel: "store",
  version,
  artifact: zipName,
  sha256,
  size: (await stat(zipPath)).size,
  contents: files,
};
await writeFile(path.join(outDir, "chrome-web-store-artifact.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(`created Chrome Web Store artifact at ${zipPath}`);
if (!storeExtensionId) {
  console.warn("warning: Store extension id is not recorded yet; upload this draft zip, copy the Dashboard item id, then regenerate with --store-extension-id <id>.");
}

function assertStoreManifest(manifest) {
  const issues = [];
  if (manifest.manifest_version !== 3) issues.push("manifest_version must be 3");
  if (typeof manifest.name !== "string" || manifest.name.length === 0) issues.push("name is required");
  if (typeof manifest.description !== "string" || manifest.description.length === 0) issues.push("description is required");
  if (
    (manifest.name.startsWith("__MSG_") || manifest.description.startsWith("__MSG_")) &&
    typeof manifest.default_locale !== "string"
  ) {
    issues.push("default_locale is required for localized manifest fields");
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.version)) issues.push("version must be semver-like");
  if (manifest.background?.service_worker !== "background.js") issues.push("background.service_worker must be background.js");
  if (manifest.action?.default_popup !== "popup.html") issues.push("action.default_popup must be popup.html");
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("nativeMessaging")) {
    issues.push("permissions must include nativeMessaging");
  }
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes("<all_urls>")) {
    issues.push("host_permissions must include <all_urls>");
  }
  if (issues.length > 0) throw new Error(`Store manifest validation failed: ${issues.join("; ")}`);
  return {
    sourceManifestKeyId: typeof manifest.key === "string" && manifest.key.length > 0
      ? extensionIdFromManifestKey(manifest.key)
      : undefined,
    version: manifest.version,
  };
}

function assertStorePopup(contents) {
  const issues = [];
  if (!/const EXTENSION_CHANNEL = "store";/.test(contents)) {
    issues.push("popup.js must be built with EXTENSION_CHANNEL store");
  }
  if (!contents.includes("prompts/agent-install-prompt.md")) {
    issues.push("popup.js must include the agent install prompt handoff");
  }
  if (!contents.includes("Extension channel:") || !contents.includes("Extension id:")) {
    issues.push("popup.js must include extension channel/id handoff fields");
  }
  if (/curl -fsSL|obu bootstrap|Terminal command|Bootstrap:|Verify:/.test(contents)) {
    issues.push("popup.js must not expose a Terminal setup command");
  }
  if (issues.length > 0) throw new Error(`Store popup validation failed: ${issues.join("; ")}`);
}

function assertStoreContents(files) {
  const expectedLocales = [
    "ar",
    "de",
    "en",
    "es",
    "fr",
    "hi",
    "id",
    "it",
    "ja",
    "ko",
    "nl",
    "pl",
    "pt_BR",
    "ru",
    "tr",
    "vi",
    "zh_CN",
    "zh_TW",
  ];
  const expectedBase = [
    "background.js",
    "cursor.js",
    "i18n.js",
    "icons/icon-128.png",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "manifest.json",
    "options.css",
    "options.html",
    "options.js",
    "popup.css",
    "popup.html",
    "popup.js",
  ].sort();
  const expectedLocaleFiles = expectedLocales.map((locale) => `_locales/${locale}/messages.json`).sort();
  const actual = [...files].sort();
  const localeFiles = actual.filter((file) => file.startsWith("_locales/")).sort();
  const actualBase = actual.filter((file) => !file.startsWith("_locales/"));
  const extra = actualBase.filter((file) => !expectedBase.includes(file));
  const missing = expectedBase.filter((file) => !actualBase.includes(file));
  extra.push(...localeFiles.filter((file) => !expectedLocaleFiles.includes(file)));
  missing.push(...expectedLocaleFiles.filter((file) => !localeFiles.includes(file)));
  if (extra.length > 0 || missing.length > 0) {
    throw new Error(`Store artifact contents mismatch; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
  }
  for (const file of actual) {
    if (/(\.test\.|\.map$|^assets\/|logo-preview|logo-transparent|\.ts$|\.d\.ts$)/.test(file)) {
      throw new Error(`Store artifact must not include source/test/preview file: ${file}`);
    }
  }
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
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

async function stageStoreUpload(extensionDist, stagingDir, files, manifest) {
  await mkdir(stagingDir, { recursive: true });
  for (const file of files) {
    const source = path.join(extensionDist, file);
    const destination = path.join(stagingDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }

  const uploadManifest = { ...manifest };
  delete uploadManifest.key;
  await writeFile(path.join(stagingDir, "manifest.json"), `${JSON.stringify(uploadManifest, null, 2)}\n`, "utf8");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return `sha256:${hash.digest("hex")}`;
}

function extensionIdFromManifestKey(key) {
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...hash].map((byte) => `${nibbleToIdChar(byte >> 4)}${nibbleToIdChar(byte & 0x0f)}`).join("");
}

function nibbleToIdChar(nibble) {
  return String.fromCharCode(97 + nibble);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--dist") {
      parsed.dist = path.resolve(readValue());
    } else if (flag === "--out") {
      parsed.out = path.resolve(readValue());
    } else if (flag === "--store-extension-id") {
      parsed.storeExtensionId = readValue();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
