#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, symlink, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeArtifact, run, installerPath } from "./lib/curl-install-harness.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "obu-net-"));

// Build a PATH that mirrors the system bins minus one tool, so `command -v
// <tool>` fails deterministically while everything else still resolves.
async function curatedPathExcluding(tool) {
  const binDir = await mkdtemp(path.join(temp, "curated-"));
  for (const sysdir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
    let entries = [];
    try { entries = await readdir(sysdir); } catch { continue; }
    for (const name of entries) {
      if (name === tool) continue;
      try { await symlink(path.join(sysdir, name), path.join(binDir, name)); } catch { /* dup */ }
    }
  }
  return binDir;
}

try {
  await missingTarAborts();
  await missingCurlAbortsForRemote();
  await missingCurlOkForLocalArtifact();
  await unwritableRootAborts();
  await downloadRetriesTransientFailure();
  console.log("install network smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function missingTarAborts() {
  const dir = path.join(temp, "no-tar");
  await mkdir(dir, { recursive: true });
  const artifact = await makeArtifact(dir, "open-browser-use-notar", "v1");
  const pathNoTar = await curatedPathExcluding("tar");
  const result = run("sh", [
    installerPath, "--artifact", artifact, "--install-dir", path.join(dir, "install"), "--no-modify-path",
  ], { HOME: path.join(dir, "home"), PATH: pathNoTar }, { allowFailure: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tar is required/);
}

async function missingCurlAbortsForRemote() {
  const dir = path.join(temp, "no-curl-remote");
  await mkdir(dir, { recursive: true });
  const pathNoCurl = await curatedPathExcluding("curl");
  const result = run("sh", [
    installerPath, "--install-dir", path.join(dir, "install"), "--no-modify-path",
  ], {
    HOME: path.join(dir, "home"),
    PATH: pathNoCurl,
    OBU_RELEASE_BASE_URL: "https://example.invalid/download",
    OBU_TARGET: "darwin-arm64",
  }, { allowFailure: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /curl is required/);
}

async function missingCurlOkForLocalArtifact() {
  const dir = path.join(temp, "no-curl-local");
  await mkdir(dir, { recursive: true });
  const artifact = await makeArtifact(dir, "open-browser-use-localart", "v1");
  const pathNoCurl = await curatedPathExcluding("curl");
  run("sh", [
    installerPath, "--artifact", artifact, "--install-dir", path.join(dir, "install"), "--no-modify-path",
  ], { HOME: path.join(dir, "home"), PATH: pathNoCurl });
  await access(path.join(dir, "install", "bin", "obu"));
}

async function unwritableRootAborts() {
  const dir = path.join(temp, "ro-root");
  await mkdir(dir, { recursive: true });
  const locked = path.join(dir, "locked");
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o555);
  const artifact = await makeArtifact(dir, "open-browser-use-ro", "v1");
  const result = run("sh", [
    installerPath, "--artifact", artifact, "--install-dir", path.join(locked, "obu"), "--no-modify-path",
  ], { HOME: path.join(dir, "home") }, { allowFailure: true });
  await chmod(locked, 0o755); // allow cleanup
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not writable/);
}

// Implemented in Task 6 (download retry/resume). Stubbed here so the preflight
// cases run; replaced with a real fail-then-succeed HTTP test next task.
async function downloadRetriesTransientFailure() {}
