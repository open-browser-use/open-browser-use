#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const payload = path.resolve(args.payload);
const metadata = JSON.parse(await readFile(path.join(payload, "metadata.json"), "utf8"));

assert.equal(metadata.schemaVersion, 1);
assert.match(metadata.packageVersion, /^\d+\.\d+\.\d+/);
assert.match(metadata.nodeVersion, /^\d+\.\d+\.\d+/);
assert.match(metadata.sdkHash, /^sha256:[0-9a-f]{64}$/);
assert.equal(metadata.extensionChannel, "unpacked-dev");
assert.match(metadata.extensionId, /^[a-p]{32}$/);
assert.match(metadata.extensionZipSha256, /^sha256:[0-9a-f]{64}$/);

await mustExist("bin/obu-host");
await mustExist("bin/obu-node-repl");
await mustExist("node/bin/node");
await mustExist("cli/package.json");
await mustExist("cli/dist/index.js");
await mustExist("node_modules/@open-browser-use/sdk/package.json");
await mustExist("node_modules/@open-browser-use/sdk/dist/index.mjs");
await mustExist("node_modules/jsonc-parser/package.json");
await mustExist("extension/dist/manifest.json");
await mustExist(metadata.extensionZip);
assert.equal(await sha256(path.join(payload, metadata.extensionZip)), metadata.extensionZipSha256);
await mustExist("LICENSE");
await mustExist("LICENSE-THIRD-PARTY.md");

assert.equal(await hashTree(path.join(payload, "node_modules", "@open-browser-use", "sdk", "dist")), metadata.sdkHash);
if (!args.static) {
  assert.equal(readVersion(path.join(payload, "node", "bin", "node"), ["--version"]).replace(/^v/, ""), metadata.nodeVersion);
  assert.match(readVersion(path.join(payload, "bin", "obu-host"), ["--version"]), new RegExp(`\\b${escapeRegExp(metadata.packageVersion)}\\b`));
  assert.match(readVersion(path.join(payload, "bin", "obu-node-repl"), ["--version"]), new RegExp(`\\b${escapeRegExp(metadata.packageVersion)}\\b`));
  assert.equal(
    readVersion(path.join(payload, "node", "bin", "node"), [path.join(payload, "cli", "dist", "index.js"), "--version"], {
      OBU_PAYLOAD_ROOT: payload,
      OBU_NODE_BINARY: path.join(payload, "node", "bin", "node"),
    }),
    metadata.packageVersion,
  );
}
const extensionManifest = JSON.parse(await readFile(path.join(payload, "extension", "dist", "manifest.json"), "utf8"));
assert.equal(extensionManifest.version, metadata.extensionVersion);

console.log(`payload self-check passed for ${payload}`);

async function mustExist(relativePath) {
  await access(path.join(payload, relativePath));
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return `sha256:${hash.digest("hex")}`;
}

async function hashTree(dir) {
  const hash = createHash("sha256");
  for (const file of await listFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
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

function readVersion(command, args, env = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout.trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const parsed = { payload: path.join("dist", "payload", "current"), static: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--payload") {
      index += 1;
      if (index >= argv.length) throw new Error("--payload requires a directory");
      parsed.payload = argv[index];
    } else if (arg === "--static") {
      parsed.static = true;
    } else if (arg === "current") {
      parsed.payload = path.join("dist", "payload", "current");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
