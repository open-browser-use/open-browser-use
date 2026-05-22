#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payload = path.resolve(parsePayloadArg(process.argv.slice(2)));
const nodeBin = path.join(payload, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const cliEntry = path.join(payload, "cli", "dist", "index.js");
const temp = await mkdtemp(path.join(os.tmpdir(), "obu-cli-runtime-"));

try {
  const runtimeDir = path.join(temp, "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(runtimeDir, 0o700);

  const child = spawn(nodeBin, [cliEntry, "mcp", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      OBU_PAYLOAD_ROOT: payload,
      OBU_NODE_BINARY: nodeBin,
      OBU_COMMAND: path.join(temp, "bin", "obu"),
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
      clientInfo: { name: "obu-cli-runtime-smoke", version: "0.0.0" },
    },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "js",
      arguments: {
        source: "const sdk = await import('@open-browser-use/sdk'); ({ agent: typeof agent, sdkExports: Object.keys(sdk).length })",
      },
    },
  });

  const init = await readJson(lines);
  assert.equal(init.id, 1);
  const tools = await readJson(lines);
  assert.equal(tools.id, 2);
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    "js",
    "browser_status",
    "agent_runtime_status",
    "js_reset",
    "js_add_module_dir",
  ]);
  const exec = await readJson(lines);
  assert.equal(exec.id, 3);
  assert.equal(exec.result.structuredContent.result.agent, "object");
  assert.ok(exec.result.structuredContent.result.sdkExports > 0);

  child.stdin.end();
  const status = await waitForExit(child);
  assert.equal(status, 0, stderr);
  console.log("cli runtime deps smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}

function send(child, value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function readJson(lines) {
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

function parsePayloadArg(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--payload") {
      index += 1;
      if (index >= argv.length) throw new Error("--payload requires a directory");
      return argv[index];
    }
    if (arg === "current") return path.join(root, "dist", "payload", "current");
    throw new Error(`unknown argument: ${arg}`);
  }
  return path.join(root, "dist", "payload", "current");
}
