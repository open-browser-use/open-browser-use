#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const extensionDist = args.dist ?? path.join(root, "packages", "extension", "dist");
const outDir = args.out ?? path.join(root, "dist", "chrome-web-store");
const storeExtensionId = args.storeExtensionId ?? process.env.OBU_STORE_EXTENSION_ID;

if (!storeExtensionId || !/^[a-p]{32}$/.test(storeExtensionId)) {
  throw new Error("make-extension-store-artifact requires --store-extension-id <32-char a-p Chrome extension id>");
}

const files = await listFiles(extensionDist);
assertStoreContents(files);
const manifest = JSON.parse(await readFile(path.join(extensionDist, "manifest.json"), "utf8"));
const version = assertStoreManifest(manifest, storeExtensionId);
assertStorePopup(await readFile(path.join(extensionDist, "popup.js"), "utf8"));

await rm(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(outDir, { recursive: true });

const zipName = `open-browser-use-chrome-web-store-${version}.zip`;
const zipPath = path.join(outDir, zipName);
const zip = spawnSync("zip", ["-X", "-q", zipPath, ...files], { cwd: extensionDist, encoding: "utf8" });
if (zip.error) throw zip.error;
if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr || zip.stdout}`);

const sha256 = await sha256File(zipPath);
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  extensionChannel: "store",
  storeExtensionId,
  manifestKeyPolicy: "included",
  popupChannel: "store",
  version,
  artifact: zipName,
  sha256,
  size: (await stat(zipPath)).size,
  contents: files,
};
await writeFile(path.join(outDir, "chrome-web-store-artifact.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(`created Chrome Web Store artifact at ${zipPath}`);

function assertStoreManifest(manifest, expectedStoreExtensionId) {
  const issues = [];
  if (manifest.manifest_version !== 3) issues.push("manifest_version must be 3");
  if (typeof manifest.name !== "string" || manifest.name.length === 0) issues.push("name is required");
  if (typeof manifest.description !== "string" || manifest.description.length === 0) issues.push("description is required");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+/.test(manifest.version)) issues.push("version must be semver-like");
  if (typeof manifest.key !== "string" || manifest.key.length === 0) issues.push("Store upload manifest must include key");
  const derivedId = typeof manifest.key === "string" ? extensionIdFromManifestKey(manifest.key) : undefined;
  if (derivedId !== expectedStoreExtensionId) {
    issues.push(`manifest key derives ${derivedId ?? "unknown"}, expected Store extension id ${expectedStoreExtensionId}`);
  }
  if (manifest.background?.service_worker !== "background.js") issues.push("background.service_worker must be background.js");
  if (manifest.action?.default_popup !== "popup.html") issues.push("action.default_popup must be popup.html");
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("nativeMessaging")) {
    issues.push("permissions must include nativeMessaging");
  }
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes("<all_urls>")) {
    issues.push("host_permissions must include <all_urls>");
  }
  if (issues.length > 0) throw new Error(`Store manifest validation failed: ${issues.join("; ")}`);
  return manifest.version;
}

function assertStorePopup(contents) {
  const issues = [];
  if (!/const EXTENSION_CHANNEL = "store";/.test(contents)) {
    issues.push("popup.js must be built with EXTENSION_CHANNEL store");
  }
  if (!contents.includes("--channel=store")) {
    issues.push("popup.js must include Store setup and doctor command suffix");
  }
  if (issues.length > 0) throw new Error(`Store popup validation failed: ${issues.join("; ")}`);
}

function assertStoreContents(files) {
  const expected = [
    "background.js",
    "cursor.js",
    "icons/icon-128.png",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "manifest.json",
    "popup.css",
    "popup.html",
    "popup.js",
  ].sort();
  const actual = [...files].sort();
  const extra = actual.filter((file) => !expected.includes(file));
  const missing = expected.filter((file) => !actual.includes(file));
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
