#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, "dist", "curl");
const manifest = JSON.parse(await readFile(path.join(artifactRoot, "manifest.json"), "utf8"));
const artifactTarget = currentTargetTriple();
const artifact = manifest.artifacts?.find((row) => row.target === artifactTarget);
if (!artifact) throw new Error(`curl manifest has no artifact for ${artifactTarget}`);

const temp = await mkdtemp(path.join(os.tmpdir(), "obu-setup-spine-"));
let descriptorServer;
try {
  const installDir = path.join(temp, "install");
  const home = path.join(temp, "home");
  const xdgConfigHome = path.join(home, ".config");
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
  ], { HOME: home, XDG_CONFIG_HOME: xdgConfigHome });

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
    XDG_CONFIG_HOME: xdgConfigHome,
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
    XDG_CONFIG_HOME: xdgConfigHome,
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
    "--write-instructions",
    "--json",
  ], {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
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
  const codexInstructions = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
  assert.match(codexInstructions, /Use open-browser-use as the primary BrowserUse\/browser automation tool/);
  assert.match(codexInstructions, /Check `browser_status`/);

  const profilePath = path.join(browserProfileRoot("chrome-for-testing", home, xdgConfigHome), "Default");
  await writeChromePreferences(profilePath, report.extensionId, extensionSource);
  const descriptorDir = path.join(runtimeDir, "webextension");
  await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
  await chmod(descriptorDir, 0o700);
  const socketPath = path.join(temp, "chrome.sock");
  descriptorServer = await startRuntimeDescriptorServer(socketPath, {
    browserKind: "chrome",
    extensionId: report.extensionId,
    profilePath,
  });
  await writeRuntimeDescriptor(path.join(descriptorDir, "chrome.json"), {
    schema_version: 1,
    type: "webextension",
    name: "chrome",
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: "chrome",
      extension_id: report.extensionId,
      profile_path: profilePath,
    },
  });

  const verify = await runAsync(obu, [
    "verify",
    "--agent=codex-cli",
    "--browser=chrome-for-testing",
    "--channel=unpacked-dev",
    `--extension-id=${report.extensionId}`,
    "--json",
  ], {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    OBU_RUNTIME_DIR: runtimeDir,
  });
  const verifyReport = JSON.parse(verify.stdout);
  assert.equal(verifyReport.result, "ready");
  assert.equal(verifyReport.nextAction, null);
  assert.equal(Object.hasOwn(verifyReport, "nextActions"), false);
  assert.equal(verifyReport.readiness.cli, "ready");
  assert.equal(verifyReport.agent.id, "codex-cli");
  assert.equal(verifyReport.agent.instructions.status, "pass");
  assert.equal(verifyReport.browser.extensionId, report.extensionId);
  assert.equal(verifyReport.mcpRuntime.cli.sdkBootstrap, "available");
  assert.equal(verifyReport.mcpRuntime.cli.backendCount, 1);

  console.log("setup local spine smoke passed");
} finally {
  if (descriptorServer) {
    await new Promise((resolve) => descriptorServer.close(() => resolve()));
  }
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

function runAsync(command, args, env = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (status) => {
      const result = { status, stdout, stderr };
      if (!options.allowFailure && status !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed:\n${stderr}\n${stdout}`));
        return;
      }
      resolve(result);
    });
  });
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

function browserProfileRoot(browser, homeDir, xdgConfigHome) {
  if (process.platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    if (browser === "chrome-for-testing") return path.join(appSupport, "Google", "Chrome for Testing");
    return path.join(appSupport, "Google", "Chrome");
  }
  const configRoot = xdgConfigHome || path.join(homeDir, ".config");
  if (browser === "chrome-for-testing") return path.join(configRoot, "google-chrome-for-testing");
  return path.join(configRoot, "google-chrome");
}

async function writeChromePreferences(profilePath, extensionId, extensionPath) {
  await mkdir(profilePath, { recursive: true });
  await writeFile(path.join(profilePath, "Preferences"), `${JSON.stringify({
    extensions: {
      settings: {
        [extensionId]: {
          state: 1,
          path: extensionPath,
          manifest: { version: "0.1.0" },
        },
      },
    },
  }, null, 2)}\n`, "utf8");
}

async function writeRuntimeDescriptor(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

async function startRuntimeDescriptorServer(socketPath, metadata) {
  const server = net.createServer((socket) => {
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const request = JSON.parse(body.toString("utf8"));
        if (request.method === "auth") {
          authenticated = true;
          socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result: null }));
          continue;
        }
        if (authenticated && request.method === "getInfo") {
          const backendMetadata = {
            browser_kind: metadata.browserKind,
            extension_id: metadata.extensionId,
            profile_path: metadata.profilePath,
          };
          socket.write(encodeFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              type: "webextension",
              name: "chrome",
              metadata: {
                host_version: "0.1.0",
                backend: backendMetadata,
                diagnostics: { lifecycle: {} },
              },
              capabilities: {},
            },
          }));
          socket.end();
          continue;
        }
        socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } }));
        socket.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return server;
}

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function systemPath() {
  return process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin:/usr/sbin:/sbin";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
