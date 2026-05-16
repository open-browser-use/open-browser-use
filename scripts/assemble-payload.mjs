#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRequire = createRequire(path.join(root, "packages", "cli", "package.json"));

const args = parseArgs(process.argv.slice(2));
const outDir = args.out ?? path.join(root, "dist", "payload", "current");
const payloadTarget = args.target ?? currentTargetTriple();
assertSupportedPayloadTarget(payloadTarget);
if (payloadTarget !== currentTargetTriple() && (!args.hostBin || !args.nodeReplBin)) {
  throw new Error(`assembling ${payloadTarget} requires --host-bin and --node-repl-bin built for that target`);
}

await rm(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(outDir, { recursive: true });

const nodeInfo = await stageNode(outDir, args);
const binaries = await stageRustBinaries(outDir, args);
await stageCli(outDir);
await stageSdk(outDir);
await stageCliRuntimeDependencies(outDir);
const extension = await stageExtension(outDir);
await cp(path.join(root, "LICENSE"), path.join(outDir, "LICENSE"));
await cp(path.join(root, "LICENSE-THIRD-PARTY.md"), path.join(outDir, "LICENSE-THIRD-PARTY.md"));

const metadata = {
  schemaVersion: 1,
  packageVersion: await packageVersion(path.join(root, "packages", "cli", "package.json")),
  targetTriple: payloadTarget,
  nodeVersion: nodeInfo.version,
  nodeSource: nodeInfo.source,
  binaries,
  sdkHash: await hashTree(path.join(outDir, "node_modules", "@open-browser-use", "sdk", "dist")),
  extensionVersion: extension.version,
  extensionChannel: "unpacked-dev",
  extensionId: extension.id,
  extensionZip: path.relative(outDir, extension.zipPath),
  extensionZipSha256: await hashFile(extension.zipPath),
  cliRuntimeDependencies: ["jsonc-parser"],
};
await writeJson(path.join(outDir, "metadata.json"), metadata);

console.log(`assembled open-browser-use payload at ${outDir}`);

async function stageNode(payloadRoot, options) {
  const nodeRoot = options.nodeRoot;
  if (!nodeRoot && !options.allowCurrentNode) {
    throw new Error("assemble-payload requires --node-root <Node distribution> or --allow-current-node for local smoke payloads");
  }
  const nodeOut = path.join(payloadRoot, "node");
  if (nodeRoot) {
    const nodeBin = path.join(nodeRoot, "bin", "node");
    await assertExecutable(nodeBin, "bundled Node");
    await cp(nodeRoot, nodeOut, { recursive: true, force: true, dereference: true });
  } else {
    await mkdir(path.join(nodeOut, "bin"), { recursive: true });
    await writeFile(path.join(nodeOut, "bin", "node"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, "utf8");
    await chmod(path.join(nodeOut, "bin", "node"), 0o755);
  }
  const stagedNode = path.join(nodeOut, "bin", "node");
  const version = options.nodeVersion ?? nodeVersion(stagedNode);
  if (!isAtLeastNode(version, 22, 22, 0)) {
    throw new Error(`bundled Node must be >=22.22.0, got ${version}`);
  }
  return {
    version,
    source: nodeRoot ? "node-root" : "current-process-node",
  };
}

async function stageRustBinaries(payloadRoot, options) {
  const binOut = path.join(payloadRoot, "bin");
  await mkdir(binOut, { recursive: true });
  if ((options.hostBin && !options.nodeReplBin) || (!options.hostBin && options.nodeReplBin)) {
    throw new Error("--host-bin and --node-repl-bin must be provided together");
  }
  const host = options.hostBin ?? await firstExecutable([
    path.join(root, "target", "release", binaryName("obu-host")),
    path.join(root, "target", "debug", binaryName("obu-host")),
  ], "obu-host");
  const repl = options.nodeReplBin ?? await firstExecutable([
    path.join(root, "target", "release", binaryName("obu-node-repl")),
    path.join(root, "target", "debug", binaryName("obu-node-repl")),
  ], "obu-node-repl");
  await assertExecutable(host, "obu-host");
  await assertExecutable(repl, "obu-node-repl");
  await cp(host, path.join(binOut, binaryName("obu-host")));
  await cp(repl, path.join(binOut, binaryName("obu-node-repl")));
  await chmod(path.join(binOut, binaryName("obu-host")), 0o755);
  await chmod(path.join(binOut, binaryName("obu-node-repl")), 0o755);
  return {
    obuHost: path.relative(payloadRoot, path.join(binOut, binaryName("obu-host"))),
    obuNodeRepl: path.relative(payloadRoot, path.join(binOut, binaryName("obu-node-repl"))),
  };
}

async function stageCli(payloadRoot) {
  const cliOut = path.join(payloadRoot, "cli");
  await mkdir(cliOut, { recursive: true });
  await assertPath(path.join(root, "packages", "cli", "dist", "index.js"), "CLI dist");
  await cp(path.join(root, "packages", "cli", "dist"), path.join(cliOut, "dist"), {
    recursive: true,
    force: true,
    filter: (source) => !/\.test\.(js|d\.ts|js\.map)$/.test(source),
  });
  await cp(path.join(root, "packages", "cli", "package.json"), path.join(cliOut, "package.json"));
}

async function stageSdk(payloadRoot) {
  const sdkOut = path.join(payloadRoot, "node_modules", "@open-browser-use", "sdk");
  await mkdir(sdkOut, { recursive: true });
  await assertPath(path.join(root, "packages", "sdk", "dist", "index.mjs"), "SDK dist");
  await cp(path.join(root, "packages", "sdk", "dist"), path.join(sdkOut, "dist"), { recursive: true, force: true });
  await cp(path.join(root, "packages", "sdk", "package.json"), path.join(sdkOut, "package.json"));
}

async function stageCliRuntimeDependencies(payloadRoot) {
  await copyPackage("jsonc-parser", path.join(payloadRoot, "node_modules", "jsonc-parser"));
}

async function stageExtension(payloadRoot) {
  const extensionOut = path.join(payloadRoot, "extension");
  const extensionDist = path.join(extensionOut, "dist");
  await mkdir(extensionOut, { recursive: true });
  await assertPath(path.join(root, "packages", "extension", "dist", "manifest.json"), "extension dist");
  await cp(path.join(root, "packages", "extension", "dist"), extensionDist, { recursive: true, force: true });
  const manifest = JSON.parse(await readFile(path.join(extensionDist, "manifest.json"), "utf8"));
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  const zipPath = path.join(extensionOut, `open-browser-use-extension-${version}.zip`);
  await zipDirectory(extensionDist, zipPath);
  return {
    version,
    id: extensionIdFromManifestKey(manifest.key),
    zipPath,
  };
}

async function copyPackage(packageName, destination) {
  const packageJson = cliRequire.resolve(`${packageName}/package.json`);
  await cp(path.dirname(packageJson), destination, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

async function zipDirectory(sourceDir, zipPath) {
  const files = await listFiles(sourceDir);
  const result = spawnSync("zip", ["-X", "-q", zipPath, ...files], { cwd: sourceDir, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr || result.stdout}`);
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

async function hashFile(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return `sha256:${hash.digest("hex")}`;
}

async function firstExecutable(candidates, label) {
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error(`${label} binary was not found; build Rust binaries first`);
}

async function assertPath(file, label) {
  await stat(file).catch(() => {
    throw new Error(`${label} was not found at ${file}; build it before assembling the payload`);
  });
}

async function assertExecutable(file, label) {
  await access(file, constants.X_OK).catch(() => {
    throw new Error(`${label} is not executable at ${file}`);
  });
}

function nodeVersion(nodeBin) {
  const result = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`failed to inspect Node version: ${result.stderr}`);
  return result.stdout.trim().replace(/^v/, "");
}

function isAtLeastNode(version, major, minor, patch) {
  const parts = version.split(".").map((part) => Number(part));
  const current = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  const minimum = [major, minor, patch];
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

function currentTargetTriple() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") {
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}`;
  }
  return `${process.platform}-${process.arch}`;
}

function assertSupportedPayloadTarget(target) {
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-x64-gnu",
    "linux-x64-musl",
    "linux-arm64-gnu",
  ]);
  if (!supported.has(target)) {
    throw new Error(`unsupported P4a payload target: ${target}`);
  }
}

function binaryName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function packageVersion(file) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (typeof manifest.version !== "string") throw new Error(`${file} is missing version`);
  return manifest.version;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
    if (flag === "--out") {
      parsed.out = path.resolve(readValue());
    } else if (flag === "--target") {
      parsed.target = readValue();
    } else if (flag === "--node-root") {
      parsed.nodeRoot = path.resolve(readValue());
    } else if (flag === "--node-version") {
      parsed.nodeVersion = readValue();
    } else if (flag === "--host-bin") {
      parsed.hostBin = path.resolve(readValue());
    } else if (flag === "--node-repl-bin") {
      parsed.nodeReplBin = path.resolve(readValue());
    } else if (flag === "--allow-current-node") {
      parsed.allowCurrentNode = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function extensionIdFromManifestKey(key) {
  if (typeof key !== "string" || key.length === 0) throw new Error("manifest key is required");
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...hash].map((byte) => `${nibbleToIdChar(byte >> 4)}${nibbleToIdChar(byte & 0x0f)}`).join("");
}

function nibbleToIdChar(nibble) {
  return String.fromCharCode(97 + nibble);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
