#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
const browser = browserKind(chrome);
const artifactRoot = path.join(root, "dist", "curl");
const manifest = JSON.parse(await readFile(path.join(artifactRoot, "manifest.json"), "utf8"));
const artifactTarget = currentTargetTriple();
const artifact = manifest.artifacts?.find((row) => row.target === artifactTarget);
if (!artifact) throw new Error(`curl manifest has no artifact for ${artifactTarget}`);

const temp = await mkdtemp(e2eTempPrefix());
let chromeProcess;
try {
  const home = path.join(temp, "home");
  const xdg = path.join(home, ".config");
  const runtimeDir = path.join(temp, "runtime");
  const installDir = path.join(temp, "install");
  const fakeBin = path.join(temp, "fake-bin");
  const codexLog = path.join(temp, "codex.log");
  const profileDir = browserProfileRoot(browser, home, xdg);
  const downloadDir = path.join(temp, "downloads");
  await mkdir(fakeBin, { recursive: true });
  await fakeCodex(fakeBin, codexLog);
  await mkdir(path.join(profileDir, "Default"), { recursive: true });
  await mkdir(downloadDir, { recursive: true });
  await writeFile(path.join(profileDir, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: downloadDir, directory_upgrade: true, prompt_for_download: false },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
    safebrowsing: { enabled: false },
  }, null, 2), "utf8");

  run("sh", [
    path.join(artifactRoot, manifest.installer),
    "--artifact",
    path.join(artifactRoot, artifact.file),
    "--checksum",
    artifact.sha256,
    "--install-dir",
    installDir,
    "--no-modify-path",
  ], { HOME: home, XDG_CONFIG_HOME: xdg });

  const obu = path.join(installDir, "bin", "obu");
  const setup = run(obu, [
    "setup",
    "--yes",
    `--browser=${browser}`,
    "--agents=codex-cli",
    "--json",
  ], {
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    OBU_RUNTIME_DIR: runtimeDir,
  }, { allowFailure: true });
  assert.equal(setup.status, 1, setup.stderr);
  const setupJson = JSON.parse(setup.stdout);
  assert.equal(setupJson.result, "manual_action_required");
  assertStep(setupJson, "agent-codex-cli", "applied");
  assert.match(await readFile(codexLog, "utf8"), new RegExp(`mcp add open-browser-use -- ${escapeRegExp(obu)} mcp stdio`));
  const extensionCurrent = path.join(home, ".obu", "extension", "current");
  await access(path.join(extensionCurrent, "manifest.json"));

  chromeProcess = spawn(chrome, chromeArgs(profileDir, extensionCurrent), {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      OBU_RUNTIME_DIR: runtimeDir,
    },
  });
  let chromeStderr = "";
  chromeProcess.stderr.setEncoding("utf8");
  chromeProcess.stderr.on("data", (chunk) => {
    chromeStderr += chunk;
  });

  const descriptor = await waitForDescriptor(runtimeDir, 30_000).catch((error) => {
    throw new Error(`${error.message}\nChrome stderr:\n${chromeStderr}`);
  });
  assert.match(descriptor, /\.json$/);

  const backend = await mcpBrowserCheck(obu, home, xdg, runtimeDir);
  assert.equal(backend.result.structuredContent.result.backend, "webextension");
  assert.equal(backend.result.structuredContent.result.name, "chrome");

  console.log("setup webextension e2e passed");
} finally {
  if (chromeProcess) {
    chromeProcess.kill("SIGTERM");
    await waitForExit(chromeProcess, 3000).catch(() => {
      chromeProcess.kill("SIGKILL");
    });
  }
  if (process.env.OBU_KEEP_E2E_TMP !== "1") {
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else {
    console.error(`Preserved setup WebExtension E2E temp dir: ${temp}`);
  }
}

function assertStep(report, id, status) {
  assert.equal(report.steps.find((step) => step.id === id)?.status, status, id);
}

function findChrome() {
  const explicit = process.env.OBU_WEBEXT_CHROME_BIN || process.env.OBU_CHROME_BIN;
  if (explicit) {
    if (!existsSyncExecutable(explicit)) {
      throw new Error(`Configured Chrome binary is not executable: ${explicit}`);
    }
    return explicit;
  }
  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    : ["google-chrome-for-testing", "chromium", "chromium-browser"];
  for (const candidate of candidates) {
    const resolved = candidate.includes("/") ? candidate : which(candidate);
    if (resolved && existsSyncExecutable(resolved)) return resolved;
  }
  if (process.env.OBU_WEBEXT_E2E_AUTO_INSTALL === "1") {
    const result = spawnSync(path.join(root, "scripts", "ensure-chrome-for-testing.sh"), { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  }
  throw new Error("No Chrome for Testing or Chromium found; set OBU_WEBEXT_CHROME_BIN or OBU_WEBEXT_E2E_AUTO_INSTALL=1");
}

function e2eTempPrefix() {
  const root = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return path.join(root, "obu-setup-webext-");
}

function browserKind(chromePath) {
  if (/Chrome for Testing|chrome-for-testing/i.test(chromePath)) return "chrome-for-testing";
  if (/Google Chrome\.app|google-chrome/i.test(chromePath)) return "chrome";
  if (/Chromium|chromium/i.test(chromePath)) return "chromium";
  return "chrome-for-testing";
}

function browserProfileRoot(kind, home, xdg) {
  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    if (kind === "chrome") return path.join(appSupport, "Google", "Chrome");
    if (kind === "chromium") return path.join(appSupport, "Chromium");
    return path.join(appSupport, "Google", "Chrome for Testing");
  }
  if (kind === "chrome") return path.join(xdg, "google-chrome");
  if (kind === "chromium") return path.join(xdg, "chromium");
  return path.join(xdg, "google-chrome-for-testing");
}

function chromeArgs(profileDir, extensionCurrent) {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionCurrent}`,
    `--disable-extensions-except=${extensionCurrent}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  if (process.platform === "darwin") args.unshift("--use-mock-keychain");
  if (process.platform === "linux") args.unshift("--no-sandbox");
  if (process.env.OBU_WEBEXT_E2E_HEADLESS === "1") args.unshift("--headless=new");
  return args;
}

async function waitForDescriptor(runtimeDir, timeoutMs) {
  const descriptorDir = path.join(runtimeDir, "webextension");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(descriptorDir).catch(() => []);
    const descriptor = entries.find((entry) => entry.endsWith(".json"));
    if (descriptor) return path.join(descriptorDir, descriptor);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`WebExtension descriptor was not written under ${descriptorDir}`);
}

async function mcpBrowserCheck(obu, home, xdg, runtimeDir) {
  const child = spawn(obu, ["mcp", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, OBU_RUNTIME_DIR: runtimeDir },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout });
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "setup-webext-e2e", version: "0.0.0" } },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "js",
      arguments: {
        source: "const browser = await agent.browsers.get('chrome'); ({ backend: browser.info.type, name: browser.info.name })",
      },
    },
  });
  const init = await readJson(lines);
  assert.equal(init.id, 1);
  const result = await readJson(lines);
  assert.equal(result.id, 2, stderr);
  child.stdin.end();
  const code = await waitForExit(child, 5000);
  assert.equal(code, 0, stderr);
  return result;
}

function send(child, value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function readJson(lines) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for MCP stdout")), 10000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process exit timeout")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function run(command, args, env = {}, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

function which(command) {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function existsSyncExecutable(file) {
  return spawnSync("test", ["-x", file]).status === 0;
}

async function fakeCodex(bin, logPath) {
  await writeFile(path.join(bin, "codex"), `#!/bin/sh
if [ "$1 $2" = "mcp list" ]; then
  exit 0
fi
echo "$@" > ${shellQuote(logPath)}
`, "utf8");
  await chmod(path.join(bin, "codex"), 0o755);
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

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
