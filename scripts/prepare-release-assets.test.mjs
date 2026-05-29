#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "prepare-release-assets.mjs");
const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "linux-x64-musl",
];

test("prepare-release-assets combines target artifacts and validates checksums", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "obu-release-assets-"));
  try {
    const artifactsDir = path.join(temp, "artifacts");
    const outDir = path.join(temp, "release");
    await writeArtifactFixture(artifactsDir);

    const result = runScript(artifactsDir, outDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const files = await readdir(outDir);
    assert(files.includes("install.sh"));
    assert(files.includes("manifest.json"));
    assert(files.includes("manifest.tsv"));
    assert(files.includes("open-browser-use-extension.zip"));
    assert(files.includes("open-browser-use-extension.zip.sha256"));
    for (const target of targets) {
      assert(files.includes(`open-browser-use-1.2.3-${target}.tar.gz`), `missing ${target} tarball`);
      assert(files.includes(`open-browser-use-1.2.3-${target}.tar.gz.sha256`), `missing ${target} checksum`);
    }

    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, "1.2.3");
    assert.deepEqual(manifest.artifacts.map((artifact) => artifact.target), targets);
    assert.equal(manifest.installer, "install.sh");
    assert.equal(manifest.shellManifest, "manifest.tsv");

    const manifestTsv = await readFile(path.join(outDir, "manifest.tsv"), "utf8");
    assert.match(manifestTsv, /^target\tfile\tsha256\tsize\n/);
    assert.equal(manifestTsv.trim().split("\n").length, 6);
    assert.equal((await stat(path.join(outDir, "install.sh"))).mode & 0o111, 0o111);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("prepare-release-assets rejects checksum mismatches before writing a release directory", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "obu-release-assets-"));
  try {
    const artifactsDir = path.join(temp, "artifacts");
    const outDir = path.join(temp, "release");
    await writeArtifactFixture(artifactsDir, { corruptTarget: "linux-x64-gnu" });

    const result = runScript(artifactsDir, outDir);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /checksum mismatch.*linux-x64-gnu/);
    await assert.rejects(() => readdir(outDir));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function runScript(artifactsDir, outDir) {
  return spawnSync(process.execPath, [
    script,
    "--artifacts-dir",
    artifactsDir,
    "--out",
    outDir,
    "--version",
    "1.2.3",
    "--generated-at",
    "2026-05-27T00:00:00.000Z",
  ], {
    cwd: root,
    encoding: "utf8",
  });
}

async function writeArtifactFixture(artifactsDir, options = {}) {
  await writeExtensionArtifact(path.join(artifactsDir, "open-browser-use-extension"));
  for (const target of targets) {
    await writeCurlArtifact(path.join(artifactsDir, `open-browser-use-${target}-curl`), target, {
      corrupt: options.corruptTarget === target,
    });
  }
}

async function writeCurlArtifact(dir, target, options = {}) {
  await mkdir(dir, { recursive: true });
  const file = `open-browser-use-1.2.3-${target}.tar.gz`;
  const bytes = Buffer.from(`payload for ${target}`);
  const sha256 = sha256Buffer(bytes);
  await writeFile(path.join(dir, file), bytes);
  await writeFile(
    path.join(dir, `${file}.sha256`),
    `${options.corrupt ? "0".repeat(64) : sha256}  ${file}\n`,
  );
  await writeFile(path.join(dir, "install.sh"), "#!/bin/sh\nprintf '%s\\n' install\n");
  await chmod(path.join(dir, "install.sh"), 0o755);
  await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-05-27T00:00:00.000Z",
    version: "1.2.3",
    artifactPrefix: "open-browser-use",
    artifacts: [{ target, file, sha256, size: bytes.length }],
    installer: "install.sh",
    shellManifest: "manifest.tsv",
  }, null, 2)}\n`);
  await writeFile(
    path.join(dir, "manifest.tsv"),
    `target\tfile\tsha256\tsize\n${target}\t${file}\t${sha256}\t${bytes.length}\n`,
  );
}

async function writeExtensionArtifact(dir) {
  await mkdir(dir, { recursive: true });
  const file = "open-browser-use-extension.zip";
  const bytes = Buffer.from("extension payload");
  const sha256 = sha256Buffer(bytes);
  await writeFile(path.join(dir, file), bytes);
  await writeFile(path.join(dir, `${file}.sha256`), `${sha256}  ${file}\n`);
  await writeFile(path.join(dir, "extension-artifact.json"), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2026-05-27T00:00:00.000Z",
    extensionChannel: "unpacked-dev",
    extensionId: "fblnfcjnjklpgnmfnngcihbcgojnpadj",
    version: "1.2.3",
    artifact: file,
    sha256,
    size: bytes.length,
  }, null, 2)}\n`);
}

function sha256Buffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
