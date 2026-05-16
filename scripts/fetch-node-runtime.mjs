#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, rename, stat } from "node:fs/promises";
import { get } from "node:https";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "scripts", "node-runtime-manifest.json"), "utf8"));
const args = parseArgs(process.argv.slice(2));
const target = args.target === "current" || !args.target ? currentTarget() : args.target;
const source = manifest.sources[target];
if (!source) {
  throw new Error(`unsupported Node runtime target: ${target}`);
}

const outRoot = args.out ?? path.join(root, ".cache", "node-runtime");
const archiveDir = path.join(outRoot, "archives");
const nodeRoot = path.join(outRoot, target, `node-v${manifest.nodeVersion}`);
const archivePath = path.join(archiveDir, source.file);
await mkdir(archiveDir, { recursive: true });

if (!await fileExists(archivePath)) {
  await download(source.url, archivePath);
}
const actual = await sha256File(archivePath);
if (actual !== source.sha256) {
  throw new Error(`checksum mismatch for ${archivePath}: expected ${source.sha256}, got ${actual}`);
}

await rm(path.dirname(nodeRoot), { recursive: true, force: true });
await mkdir(path.dirname(nodeRoot), { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), "obu-node-runtime-"));
try {
  const tar = spawnSync("tar", ["-xzf", archivePath, "-C", temp], { encoding: "utf8" });
  if (tar.error) throw tar.error;
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`);
  const entries = await readdir(temp);
  if (entries.length !== 1) throw new Error(`expected one Node archive root in ${archivePath}, found ${entries.length}`);
  await rename(path.join(temp, entries[0]), nodeRoot);
} finally {
  await rm(temp, { recursive: true, force: true });
}

if (!args.skipVersionCheck) {
  const version = nodeVersion(path.join(nodeRoot, "bin", process.platform === "win32" ? "node.exe" : "node"));
  if (version !== manifest.nodeVersion) {
    throw new Error(`expected Node ${manifest.nodeVersion}, got ${version}`);
  }
}

console.log(nodeRoot);

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`download failed ${response.statusCode}: ${url}`));
        response.resume();
        return;
      }
      const file = createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function fileExists(file) {
  return stat(file).then(() => true).catch(() => false);
}

function nodeVersion(nodeBin) {
  const result = spawnSync(nodeBin, ["--version"], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`failed to run ${nodeBin} --version: ${result.stderr}`);
  return result.stdout.trim().replace(/^v/, "");
}

function currentTarget() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") {
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    if (process.arch === "x64") return `linux-x64-${libc}`;
    if (process.arch === "arm64" && libc === "gnu") return "linux-arm64-gnu";
  }
  throw new Error(`unsupported current Node runtime target: ${process.platform}/${process.arch}`);
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
    if (flag === "--target") {
      parsed.target = readValue();
    } else if (flag === "--out") {
      parsed.out = path.resolve(readValue());
    } else if (flag === "--skip-version-check") {
      parsed.skipVersionCheck = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
