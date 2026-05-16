#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseArtifactPrefix = "open-browser-use";
const args = parseArgs(process.argv.slice(2));
const outDir = args.out ?? path.join(root, "dist", "curl");
const payloads = await collectPayloads(args);

await rm(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(outDir, { recursive: true });

const artifacts = [];
const versions = new Set();
for (const payload of payloads.values()) {
  const metadata = await readPayloadMetadata(payload);
  const { version, target } = metadata;
  versions.add(version);
  const artifactName = `${releaseArtifactPrefix}-${version}-${target}.tar.gz`;
  const artifactPath = path.join(outDir, artifactName);

  const tar = spawnSync("tar", ["-czf", artifactPath, "-C", payload, "."], { encoding: "utf8" });
  if (tar.error) throw tar.error;
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`);

  const sha256 = await sha256File(artifactPath);
  await writeFile(path.join(outDir, `${artifactName}.sha256`), `${sha256}  ${artifactName}\n`, "utf8");
  artifacts.push({
    target,
    file: artifactName,
    sha256,
    size: (await stat(artifactPath)).size,
  });
}
if (versions.size !== 1) {
  throw new Error(`all curl payloads must have the same packageVersion, got: ${[...versions].join(", ")}`);
}
await copyFile(path.join(root, "scripts", "install.sh"), path.join(outDir, "install.sh"));
await chmod(path.join(outDir, "install.sh"), 0o755);
await writeJson(path.join(outDir, "manifest.json"), {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  version: [...versions][0],
  artifactPrefix: releaseArtifactPrefix,
  artifacts: artifacts.sort((left, right) => left.target.localeCompare(right.target)),
  installer: "install.sh",
});

console.log(`created ${artifacts.length} curl artifact${artifacts.length === 1 ? "" : "s"} in ${outDir}`);

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function assertPath(file, label) {
  await access(file, constants.R_OK).catch(() => {
    throw new Error(`${label} was not found at ${file}`);
  });
}

async function collectPayloads(options) {
  const payloadDirs = options.payloads.length > 0 || options.payloadRoots.length > 0
    ? [...options.payloads]
    : [path.join(root, "dist", "payload", "current")];
  for (const rootDir of options.payloadRoots) {
    for (const entry of await readdir(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) payloadDirs.push(path.join(rootDir, entry.name));
    }
  }

  const payloads = new Map();
  for (const payloadDir of payloadDirs) {
    const metadata = await readPayloadMetadata(payloadDir);
    if (payloads.has(metadata.target)) {
      throw new Error(`duplicate curl payload for ${metadata.target}: ${payloads.get(metadata.target)} and ${payloadDir}`);
    }
    payloads.set(metadata.target, payloadDir);
  }
  return payloads;
}

async function readPayloadMetadata(payload) {
  await assertPath(path.join(payload, "metadata.json"), "payload metadata");
  const metadata = JSON.parse(await readFile(path.join(payload, "metadata.json"), "utf8"));
  const version = metadata.packageVersion;
  const target = metadata.targetTriple;
  if (typeof version !== "string" || typeof target !== "string") {
    throw new Error(`${path.join(payload, "metadata.json")} must include packageVersion and targetTriple`);
  }
  assertSupportedTarget(target);
  return { version, target };
}

function assertSupportedTarget(target) {
  const supported = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-x64-gnu",
    "linux-x64-musl",
    "linux-arm64-gnu",
  ]);
  if (!supported.has(target)) throw new Error(`unsupported P4a curl target: ${target}`);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const parsed = { payloads: [], payloadRoots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--payload") {
      parsed.payloads.push(path.resolve(readValue()));
    } else if (flag === "--payload-root") {
      parsed.payloadRoots.push(path.resolve(readValue()));
    } else if (flag === "--out") {
      parsed.out = path.resolve(readValue());
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
