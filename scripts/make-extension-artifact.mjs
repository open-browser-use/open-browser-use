#!/usr/bin/env node
// Builds the standalone, directly-loadable unpacked extension artifact published
// as a GitHub Release asset (`open-browser-use-extension.zip`). Users download it,
// unzip it, and load it via chrome://extensions -> Load unpacked. The zip must be
// the unpacked-dev build (manifest `key` present) so the extension id stays fixed
// and matches the native-host wiring the agent installs from the popup handoff.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const extensionDist = args.dist ?? path.join(root, "packages", "extension", "dist");
const outDir = args.out ?? path.join(root, "dist", "extension");
const artifactName = "open-browser-use-extension.zip";

// `outDir` is wiped (rm -rf) before the zip is written, so refuse paths that
// would delete the repo root or the extension build itself.
const resolvedDist = path.resolve(extensionDist);
const resolvedOut = path.resolve(outDir);
if (resolvedOut === root || resolvedDist === resolvedOut || resolvedDist.startsWith(`${resolvedOut}${path.sep}`)) {
  throw new Error(
    `refusing --out "${outDir}": it is the repo root or contains the extension build, which is deleted before the zip is written`,
  );
}

const releaseMetadata = JSON.parse(
  await readFile(path.join(root, "packages", "extension", "release-metadata.json"), "utf8"),
);
const expectedId = releaseMetadata.unpackedDev.extensionId;

const manifestPath = path.join(extensionDist, "manifest.json");
let manifestRaw;
try {
  manifestRaw = await readFile(manifestPath, "utf8");
} catch {
  throw new Error(
    `extension build not found at ${path.relative(root, extensionDist)}; run \`pnpm -C packages/extension build\` first`,
  );
}
const manifest = JSON.parse(manifestRaw);

if (typeof manifest.key !== "string" || manifest.key.length === 0) {
  throw new Error(
    "extension manifest.json has no `key`; the standalone download must be the unpacked-dev build (`pnpm -C packages/extension build`), not the store-channel build",
  );
}
const id = extensionIdFromManifestKey(manifest.key);
if (id !== expectedId) {
  throw new Error(
    `derived unpacked extension id ${id} does not match release-metadata unpackedDev.extensionId ${expectedId}`,
  );
}
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";

const files = await listFiles(extensionDist);
if (!files.includes("manifest.json")) throw new Error("manifest.json missing from extension dist");

await rm(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, artifactName);
const zip = spawnSync("zip", ["-X", "-q", zipPath, ...files], { cwd: extensionDist, encoding: "utf8" });
if (zip.error) throw zip.error;
if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr || zip.stdout}`);

const sha256 = await sha256File(zipPath);
await writeFile(`${zipPath}.sha256`, `${sha256}  ${artifactName}\n`, "utf8");
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  extensionChannel: "unpacked-dev",
  extensionId: id,
  version,
  artifact: artifactName,
  sha256,
  size: (await stat(zipPath)).size,
  contents: files,
};
await writeFile(path.join(outDir, "extension-artifact.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(`created unpacked extension artifact at ${zipPath} (id ${id}, version ${version})`);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dist" || arg === "--out") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      parsed[arg === "--dist" ? "dist" : "out"] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

// Chrome derives an unpacked extension id from the SHA-256 of the DER public key:
// the first 16 bytes, each nibble mapped to a-p.
function extensionIdFromManifestKey(keyBase64) {
  const der = Buffer.from(keyBase64, "base64");
  const hash = createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}
