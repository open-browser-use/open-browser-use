#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

if (args.mode !== "all-static") {
  throw new Error("package-local-smoke currently supports --target all --static");
}

const expected = {
  "@open-browser-use/cli-darwin-arm64": { dir: "cli-darwin-arm64", p4Target: "darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
  "@open-browser-use/cli-darwin-x64": { dir: "cli-darwin-x64", p4Target: "darwin-x64", os: ["darwin"], cpu: ["x64"] },
  "@open-browser-use/cli-linux-x64-gnu": { dir: "cli-linux-x64-gnu", p4Target: "linux-x64-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"], nodeTarget: "linux-x64-gnu" },
  "@open-browser-use/cli-linux-x64-musl": { dir: "cli-linux-x64-musl", p4Target: "linux-x64-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"], nodeTarget: "linux-x64-musl" },
  "@open-browser-use/cli-linux-arm64-gnu": { dir: "cli-linux-arm64-gnu", p4Target: "linux-arm64-gnu", os: ["linux"], cpu: ["arm64"], libc: ["glibc"], nodeTarget: "linux-arm64-gnu" },
};

const wrapper = await readJson(path.join(root, "dist", "npm", "cli", "package.json"));
assert.equal(wrapper.name, "@open-browser-use/cli");
assert.equal(wrapper.private, false);
assert.equal(wrapper.engines, undefined);
assert.deepEqual(Object.keys(wrapper.optionalDependencies).sort(), Object.keys(expected).sort());
assert.equal(Object.keys(wrapper.optionalDependencies).some((name) => /win32|windows|msvc/.test(name)), false);

const nodeManifest = await readJson(path.join(root, "scripts", "node-runtime-manifest.json"));
const payloadTargets = [];
for (const [packageName, spec] of Object.entries(expected)) {
  const packageRoot = path.join(root, "dist", "npm", spec.dir);
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.private, false);
  assert.deepEqual(manifest.os, spec.os);
  assert.deepEqual(manifest.cpu, spec.cpu);
  assert.deepEqual(manifest.libc, spec.libc);
  assert.deepEqual(manifest.bundledDependencies, ["@open-browser-use/sdk", "jsonc-parser"]);
  assert.equal(manifest.dependencies["jsonc-parser"], "3.3.1");
  const nodeTarget = spec.nodeTarget ?? spec.dir.replace(/^cli-/, "");
  assert.ok(nodeManifest.sources[nodeTarget], `missing Node runtime source for ${nodeTarget}`);
  assert.match(nodeManifest.sources[nodeTarget].sha256, /^[0-9a-f]{64}$/);

  const metadataPath = path.join(packageRoot, "metadata.json");
  if (await exists(metadataPath)) {
    const metadata = await readJson(metadataPath);
    assert.equal(metadata.targetTriple, spec.p4Target, `${spec.dir} contains a payload for the wrong target`);
    assert.equal(metadata.packageVersion, manifest.version);
    assert.match(metadata.sdkHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(metadata.extensionZipSha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(metadata.binaries?.obuHost, "bin/obu-host");
    assert.equal(metadata.binaries?.obuNodeRepl, "bin/obu-node-repl");
    for (const required of [
      "bin/obu-host",
      "bin/obu-node-repl",
      "cli/dist/index.js",
      "extension/dist/manifest.json",
      metadata.extensionZip,
      "LICENSE",
      "LICENSE-THIRD-PARTY.md",
      "node/bin/node",
      "node_modules/@open-browser-use/sdk/dist/index.mjs",
      "node_modules/jsonc-parser/package.json",
    ]) {
      assert.ok(await exists(path.join(packageRoot, required)), `${spec.dir} payload missing ${required}`);
    }
    payloadTargets.push(spec.p4Target);
  }
}

if (args.expectedPayloads) {
  assert.deepEqual(payloadTargets.sort(), args.expectedPayloads.flatMap(resolvePayloadExpectation).sort());
}

console.log("package local static smoke passed");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file) {
  return access(file).then(() => true, () => false);
}

function parseArgs(argv) {
  let target = "current";
  let staticOnly = false;
  let expectedPayloads;
  let expectsNoPayloads = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--target") {
      target = readValue();
      continue;
    }
    if (flag === "--static") {
      staticOnly = true;
      continue;
    }
    if (flag === "--expect-payload") {
      const value = readValue();
      expectedPayloads ??= [];
      if (value === "none") {
        if (expectedPayloads.length > 0) throw new Error("--expect-payload none cannot be combined with other payload expectations");
        expectsNoPayloads = true;
      } else {
        if (expectsNoPayloads) throw new Error("--expect-payload none cannot be combined with other payload expectations");
        expectedPayloads.push(value);
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return {
    mode: target === "all" && staticOnly ? "all-static" : `${target}${staticOnly ? "-static" : ""}`,
    expectedPayloads,
  };
}

function resolvePayloadExpectation(value) {
  if (value === "current") return currentTargetTriple();
  if (value === "all") return Object.values(expected).map((spec) => spec.p4Target);
  if (!Object.values(expected).some((spec) => spec.p4Target === value)) {
    throw new Error(`unsupported payload expectation: ${value}`);
  }
  return value;
}

function currentTargetTriple() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") {
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}`;
  }
  return `${process.platform}-${process.arch}`;
}
