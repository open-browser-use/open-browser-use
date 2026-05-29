#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "linux-x64-musl",
];
const args = parseArgs(process.argv.slice(2));
const artifactsDir = args.artifactsDir ?? path.join(root, "dist", "release-artifacts");
const outDir = args.out ?? path.join(root, "dist", "release");
const generatedAt = args.generatedAt ?? new Date().toISOString();

assertSafeOutDir(outDir, artifactsDir);

const curlArtifacts = await collectCurlArtifacts(artifactsDir, args.version);
const version = assertSingleVersion(curlArtifacts.map((artifact) => artifact.version));
if (args.version !== undefined && version !== args.version) {
  throw new Error(`release artifact version ${version} does not match requested version ${args.version}`);
}
const extensionArtifact = await readExtensionArtifact(artifactsDir, version);

await rm(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await mkdir(outDir, { recursive: true });

await copyFile(curlArtifacts[0].installPath, path.join(outDir, "install.sh"));
await chmod(path.join(outDir, "install.sh"), 0o755);
for (const artifact of curlArtifacts) {
  await copyFile(artifact.path, path.join(outDir, artifact.file));
  await copyFile(artifact.shaPath, path.join(outDir, `${artifact.file}.sha256`));
}
await copyFile(extensionArtifact.path, path.join(outDir, extensionArtifact.file));
await copyFile(extensionArtifact.shaPath, path.join(outDir, `${extensionArtifact.file}.sha256`));

const manifestArtifacts = curlArtifacts
  .map(({ target, file, sha256, size }) => ({ target, file, sha256, size }))
  .sort((left, right) => supportedTargets.indexOf(left.target) - supportedTargets.indexOf(right.target));
await writeJson(path.join(outDir, "manifest.json"), {
  schemaVersion: 1,
  generatedAt,
  version,
  artifactPrefix: "open-browser-use",
  artifacts: manifestArtifacts,
  installer: "install.sh",
  shellManifest: "manifest.tsv",
});
await writeManifestTsv(path.join(outDir, "manifest.tsv"), manifestArtifacts);

console.log(`prepared release assets for v${version} in ${outDir}`);

async function collectCurlArtifacts(parent, requestedVersion) {
  const entries = await readdir(parent, { withFileTypes: true }).catch((error) => {
    throw new Error(`release artifacts directory is not readable: ${parent}: ${error.message}`);
  });
  const artifactDirs = entries
    .filter((entry) => entry.isDirectory() && /^open-browser-use-.+-curl$/.test(entry.name))
    .map((entry) => path.join(parent, entry.name))
    .sort();
  if (artifactDirs.length === 0) {
    throw new Error(`no curl artifact directories found under ${parent}`);
  }

  const artifacts = [];
  const seenTargets = new Set();
  for (const dir of artifactDirs) {
    const manifest = await readJson(path.join(dir, "manifest.json"));
    if (manifest.schemaVersion !== 1) throw new Error(`${dir}/manifest.json has unsupported schemaVersion`);
    if (requestedVersion !== undefined && manifest.version !== requestedVersion) {
      throw new Error(`${dir}/manifest.json version ${manifest.version} does not match requested version ${requestedVersion}`);
    }
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) {
      throw new Error(`${dir}/manifest.json must contain exactly one target artifact`);
    }
    const artifact = manifest.artifacts[0];
    assertSupportedTarget(artifact.target);
    if (seenTargets.has(artifact.target)) throw new Error(`duplicate release artifact target: ${artifact.target}`);
    seenTargets.add(artifact.target);
    artifacts.push(await validateCurlArtifact(dir, manifest.version, artifact));
  }

  const missingTargets = supportedTargets.filter((target) => !seenTargets.has(target));
  if (missingTargets.length > 0) {
    throw new Error(`missing release artifact target${missingTargets.length === 1 ? "" : "s"}: ${missingTargets.join(", ")}`);
  }
  return artifacts.sort((left, right) => supportedTargets.indexOf(left.target) - supportedTargets.indexOf(right.target));
}

async function validateCurlArtifact(dir, version, artifact) {
  const { target, file, sha256, size } = artifact;
  assertBasename(file, `curl artifact file for ${target}`);
  assertHexSha(sha256, `curl artifact sha256 for ${target}`);
  assertPositiveSize(size, `curl artifact size for ${target}`);
  const filePath = path.join(dir, file);
  const shaPath = path.join(dir, `${file}.sha256`);
  const installPath = path.join(dir, "install.sh");

  await assertReadable(installPath, `installer for ${target}`);
  await validateChecksumFile(shaPath, file, sha256, target);
  await validateFileDigest(filePath, sha256, size, target);
  return { version, target, file, sha256, size, path: filePath, shaPath, installPath };
}

async function readExtensionArtifact(parent, version) {
  const dir = path.join(parent, "open-browser-use-extension");
  const summary = await readJson(path.join(dir, "extension-artifact.json"));
  if (summary.schemaVersion !== 1) throw new Error(`${dir}/extension-artifact.json has unsupported schemaVersion`);
  if (summary.version !== version) {
    throw new Error(`extension artifact version ${summary.version} does not match curl artifact version ${version}`);
  }
  if (summary.artifact !== "open-browser-use-extension.zip") {
    throw new Error(`extension artifact must be open-browser-use-extension.zip, got ${summary.artifact}`);
  }
  assertHexSha(summary.sha256, "extension artifact sha256");
  assertPositiveSize(summary.size, "extension artifact size");
  const filePath = path.join(dir, summary.artifact);
  const shaPath = path.join(dir, `${summary.artifact}.sha256`);
  await validateChecksumFile(shaPath, summary.artifact, summary.sha256, "extension");
  await validateFileDigest(filePath, summary.sha256, summary.size, "extension");
  return { file: summary.artifact, path: filePath, shaPath };
}

async function validateChecksumFile(shaPath, expectedFile, expectedSha, label) {
  const raw = await readFile(shaPath, "utf8").catch((error) => {
    throw new Error(`checksum file for ${label} is not readable: ${shaPath}: ${error.message}`);
  });
  const [actualSha, actualFile] = raw.trim().split(/\s+/);
  if (actualSha !== expectedSha) {
    throw new Error(`checksum mismatch for ${label}: ${path.basename(shaPath)} says ${actualSha}, manifest says ${expectedSha}`);
  }
  if (actualFile !== expectedFile) {
    throw new Error(`checksum file name mismatch for ${label}: expected ${expectedFile}, got ${actualFile}`);
  }
}

async function validateFileDigest(file, expectedSha, expectedSize, label) {
  const actualSize = (await stat(file).catch((error) => {
    throw new Error(`release asset for ${label} is not readable: ${file}: ${error.message}`);
  })).size;
  if (actualSize !== expectedSize) {
    throw new Error(`size mismatch for ${label}: expected ${expectedSize}, got ${actualSize}`);
  }
  const actualSha = await sha256File(file);
  if (actualSha !== expectedSha) {
    throw new Error(`checksum mismatch for ${label}: expected ${expectedSha}, got ${actualSha}`);
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function assertReadable(file, label) {
  await stat(file).catch((error) => {
    throw new Error(`${label} is not readable: ${file}: ${error.message}`);
  });
}

function assertSingleVersion(versions) {
  const unique = new Set(versions);
  if (unique.size !== 1) throw new Error(`release artifacts must have one version, got: ${[...unique].join(", ")}`);
  return [...unique][0];
}

function assertSupportedTarget(target) {
  if (!supportedTargets.includes(target)) throw new Error(`unsupported release artifact target: ${target}`);
}

function assertBasename(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== path.basename(value)) {
    throw new Error(`${label} must be a basename`);
  }
}

function assertHexSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be 64 lowercase hex characters`);
  }
}

function assertPositiveSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeManifestTsv(file, artifacts) {
  const lines = [
    "target\tfile\tsha256\tsize",
    ...artifacts.map((artifact) => `${artifact.target}\t${artifact.file}\t${artifact.sha256}\t${artifact.size}`),
  ];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

function assertSafeOutDir(out, input) {
  const resolvedOut = path.resolve(out);
  const resolvedInput = path.resolve(input);
  if (resolvedOut === root || resolvedOut === resolvedInput || resolvedInput.startsWith(`${resolvedOut}${path.sep}`)) {
    throw new Error(`refusing --out "${out}": it is the repo root or contains the input artifact directory`);
  }
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
    if (flag === "--artifacts-dir") {
      parsed.artifactsDir = path.resolve(readValue());
    } else if (flag === "--out") {
      parsed.out = path.resolve(readValue());
    } else if (flag === "--version") {
      parsed.version = stripVersionPrefix(readValue());
    } else if (flag === "--generated-at") {
      parsed.generatedAt = readValue();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function stripVersionPrefix(value) {
  return value.startsWith("v") ? value.slice(1) : value;
}
