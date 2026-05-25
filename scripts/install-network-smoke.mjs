#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { makeArtifact, run, installerPath } from "./lib/curl-install-harness.mjs";

// Async sibling of the harness's synchronous run(). The retry test serves the
// installer from an in-process HTTP server, so it cannot use spawnSync: that
// would block this event loop and the server could never answer curl. Awaiting
// an async spawn keeps the loop free to serve manifest + artifact requests.
function runAsync(command, args, env = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => {
      if (!options.allowFailure && status !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed:\n${stderr}\n${stdout}`));
        return;
      }
      resolve({ status, stdout, stderr });
    });
  });
}

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

async function downloadRetriesTransientFailure() {
  const dir = path.join(temp, "retry");
  await mkdir(dir, { recursive: true });
  const artifact = await makeArtifact(dir, "open-browser-use-retry", "v1");
  const bytes = await readFile(artifact);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const fileName = "open-browser-use-retry.tar.gz";

  let artifactHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/manifest.tsv") {
      res.writeHead(200, { "content-type": "text/tab-separated-values" });
      res.end(`target\tfile\tsha256\tsize\ndarwin-arm64\t${fileName}\t${sha}\t${bytes.length}\n`);
      return;
    }
    if (req.url === `/${fileName}`) {
      artifactHits += 1;
      if (artifactHits === 1) { res.writeHead(503); res.end("try later"); return; }
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(bytes);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await runAsync("sh", [
      installerPath, "--install-dir", path.join(dir, "install"), "--no-modify-path",
    ], {
      HOME: path.join(dir, "home"),
      OBU_RELEASE_BASE_URL: `http://127.0.0.1:${port}`,
      OBU_TARGET: "darwin-arm64",
    });
    await access(path.join(dir, "install", "bin", "obu"));
    assert.ok(artifactHits >= 2, `expected a retry, saw ${artifactHits} artifact request(s)`);
  } finally {
    server.close();
  }
}
