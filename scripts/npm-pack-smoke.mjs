#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const platformDir = path.join(root, "dist", "npm", args.target);
const wrapperDir = path.join(root, "dist", "npm", "cli");
const temp = await mkdtemp(path.join(os.tmpdir(), "obu-npm-pack-"));

try {
  const platformTarball = npmPack(platformDir, temp);
  const wrapperTarball = npmPack(wrapperDir, temp);
  if (args.staticOnly) {
    assertStaticTarballs(platformTarball, wrapperTarball);
    console.log("npm pack static smoke passed");
  } else {
    const prefix = path.join(temp, "prefix");
    run("npm", ["install", "--prefix", prefix, "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", platformTarball, wrapperTarball]);
    const obu = path.join(prefix, "node_modules", ".bin", "obu");

    const version = run(obu, ["--version"]);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);

    const home = path.join(temp, "home");
    const mcpConfig = run(obu, ["mcp-config", "--agent=codex-cli", "--print"], { HOME: home });
    const config = JSON.parse(mcpConfig.stdout);
    assert.equal(config.server.name, "open-browser-use");
    assert.equal(config.server.command, obu);
    assert.deepEqual(config.server.args, ["mcp", "stdio"]);

    const doctor = run(obu, ["doctor", "--json"], { HOME: home }, { allowFailure: true });
    const doctorJson = JSON.parse(doctor.stdout);
    assert.equal(doctorJson.schemaVersion, 1);
    assert.equal(doctorJson.layout.mode, "packaged");
    const doctorChecks = new Map(doctorJson.checks.map((check) => [check.id, check]));
    for (const id of [
      "payload-metadata",
      "payload-target",
      "payload-node-version",
      "payload-sdk-hash",
      "payload-extension-zip",
      "payload-extension-version",
      "payload-runtime-dependency",
    ]) {
      assert.equal(doctorChecks.get(id)?.status, "pass", `${id} did not pass in packaged doctor output`);
    }

    await runMcpListToolsSmoke(obu, home);

    console.log("npm pack smoke passed");
  }
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function npmPack(packageDir, destination) {
  const result = run("npm", ["pack", packageDir, "--json", "--pack-destination", destination]);
  const records = JSON.parse(result.stdout);
  if (!Array.isArray(records) || typeof records[0]?.filename !== "string") {
    throw new Error(`unexpected npm pack output: ${result.stdout}`);
  }
  return path.join(destination, records[0].filename);
}

function assertStaticTarballs(platformTarball, wrapperTarball) {
  const wrapperFiles = tarList(wrapperTarball);
  assert.ok(wrapperFiles.includes("package/bin/obu"));
  assert.ok(wrapperFiles.includes("package/bin/open-browser-use"));
  assert.ok(wrapperFiles.includes("package/LICENSE"));
  assert.ok(wrapperFiles.includes("package/package.json"));
  assert.equal(wrapperFiles.some((file) => file.includes("dist/index.js")), false);

  const platformFiles = tarList(platformTarball);
  for (const required of [
    "package/bin/obu-host",
    "package/bin/obu-node-repl",
    "package/cli/dist/index.js",
    "package/extension/dist/manifest.json",
    "package/LICENSE",
    "package/LICENSE-THIRD-PARTY.md",
    "package/metadata.json",
    "package/node/bin/node",
    "package/node_modules/@open-browser-use/sdk/dist/index.mjs",
    "package/node_modules/jsonc-parser/package.json",
    "package/package.json",
  ]) {
    assert.ok(platformFiles.includes(required), `${path.basename(platformTarball)} missing ${required}`);
  }
  assert.ok(
    platformFiles.some((file) => /^package\/extension\/open-browser-use-extension-.+\.zip$/.test(file)),
    `${path.basename(platformTarball)} missing extension zip`,
  );
}

async function runMcpListToolsSmoke(obu, home) {
  const runtimeDir = path.join(temp, "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(runtimeDir, 0o700);

  const child = spawn(obu, ["mcp", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      OBU_RUNTIME_DIR: runtimeDir,
    },
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
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "obu-npm-pack-smoke", version: "0.0.0" },
    },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  const init = await readJsonLine(lines);
  assert.equal(init.id, 1);
  const tools = await readJsonLine(lines);
  assert.equal(tools.id, 2);
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    "js",
    "browser_status",
    "agent_runtime_status",
    "js_reset",
    "js_add_module_dir",
  ]);

  child.stdin.end();
  const status = await waitForExit(child);
  assert.equal(status, 0, stderr);
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

function tarList(tarball) {
  const result = run("tar", ["-tf", tarball]);
  return result.stdout.trim().split("\n").filter(Boolean);
}

function send(child, value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function readJsonLine(lines) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for MCP stdout")), 5000);
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

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for MCP process exit"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function parseArgs(argv) {
  let target = currentTargetDir();
  let staticOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a target dir or current`);
      return argv[index];
    };
    if (flag === "--target") {
      const value = readValue();
      target = value === "current" ? currentTargetDir() : value;
      continue;
    }
    if (flag === "--static") {
      staticOnly = true;
      continue;
    }
    if (arg === "current") {
      target = currentTargetDir();
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { target, staticOnly };
}

function currentTargetDir() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "cli-darwin-arm64" : "cli-darwin-x64";
  if (process.platform === "linux") {
    const libc = process.report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
    if (process.arch === "x64") return `cli-linux-x64-${libc}`;
    if (process.arch === "arm64" && libc === "gnu") return "cli-linux-arm64-gnu";
  }
  throw new Error(`unsupported current npm target: ${process.platform}/${process.arch}`);
}
