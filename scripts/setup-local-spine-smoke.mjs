#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, "dist", "curl");
const manifest = JSON.parse(await readFile(path.join(artifactRoot, "manifest.json"), "utf8"));
const artifactTarget = currentTargetTriple();
const artifact = manifest.artifacts?.find((row) => row.target === artifactTarget);
if (!artifact) throw new Error(`curl manifest has no artifact for ${artifactTarget}`);

const temp = await mkdtemp(path.join(os.tmpdir(), "obu-setup-spine-"));
try {
  const installDir = path.join(temp, "install");
  const home = path.join(temp, "home");
  const runtimeDir = path.join(temp, "runtime");
  run("sh", [
    path.join(artifactRoot, manifest.installer),
    "--artifact",
    path.join(artifactRoot, artifact.file),
    "--checksum",
    artifact.sha256,
    "--install-dir",
    installDir,
    "--no-modify-path",
  ], { HOME: home });

  const obu = path.join(installDir, "bin", "obu");
  const extensionSource = path.join(installDir, "payloads", "current", "extension", "dist");
  const setup = run(obu, [
    "setup",
    "--yes",
    "--browser=chrome-for-testing",
    "--channel=unpacked-dev",
    "--path",
    extensionSource,
    "--skip-agents",
    "--json",
  ], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
  }, { allowFailure: true });
  assert.equal(setup.status, 1, setup.stderr);
  assert.equal(setup.stderr, "");
  const report = JSON.parse(setup.stdout);
  assert.equal(report.result, "manual_action_required");
  assertStep(report, "runtime-dir", "applied");
  assertStep(report, "native-host-chrome-for-testing", "applied");
  assertStep(report, "extension-current", "applied");
  assertStep(report, "runtime-descriptor-probe", "manual_action_required");
  assertStep(report, "agent-adapters", "skipped");

  const config = JSON.parse(await readFile(path.join(home, ".obu", "config.json"), "utf8"));
  assert.equal(config.runtimeDir, runtimeDir);
  await access(path.join(home, ".obu", "extension", "current", "manifest.json"));

  const noExtension = run(obu, [
    "setup",
    "--yes",
    "--browser=chrome-for-testing",
    "--skip-extension",
    "--skip-agents",
    "--json",
  ], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
  });
  const noExtensionReport = JSON.parse(noExtension.stdout);
  assert.equal(noExtensionReport.result, "complete");

  const agentSetup = run(obu, [
    "setup",
    "--yes",
    "--browser=chrome-for-testing",
    "--skip-extension",
    "--agents=codex-cli",
    "--json",
  ], {
    HOME: home,
    PATH: systemPath(),
    OBU_RUNTIME_DIR: runtimeDir,
  });
  const agentReport = JSON.parse(agentSetup.stdout);
  assert.equal(agentReport.result, "complete");
  assertStep(agentReport, "agent-codex-cli", "applied");
  const codexConfig = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(codexConfig, /\[mcp_servers\.open-browser-use\]/);
  assert.match(codexConfig, new RegExp(`command = "${escapeRegExp(obu)}"`));
  assert.match(codexConfig, /args = \["mcp", "stdio"\]/);

  console.log("setup local spine smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function assertStep(report, id, status) {
  assert.equal(report.steps.find((step) => step.id === id)?.status, status, id);
}

function run(command, args, env = {}, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

function currentTargetTriple() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") {
    const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;
    const libc = typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}`;
  }
  return `${process.platform}-${process.arch}`;
}

function systemPath() {
  return process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin:/usr/sbin:/sbin";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
