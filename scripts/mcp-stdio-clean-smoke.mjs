#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const payload = path.resolve(parsePayloadArg(process.argv.slice(2)));
const cliEntry = path.join(payload, "cli", "dist", "index.js");
const nodeBin = path.join(payload, "node", "bin", process.platform === "win32" ? "node.exe" : "node");
const temp = await mkdtemp(path.join(os.tmpdir(), "obu-mcp-clean-"));

try {
  const home = path.join(temp, "home");
  const missingRuntime = path.join(temp, "missing-runtime");
  const missing = runMcp(home, missingRuntime);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /open-browser-use runtime is not ready/);

  const configPath = path.join(home, ".obu", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{bad-json", "utf8");
  const malformed = runMcp(home, missingRuntime);
  assert.equal(malformed.status, 2);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /user config is invalid/);

  console.log("mcp stdio clean smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}

function runMcp(home, runtimeDir) {
  const result = spawnSync(nodeBin, [cliEntry, "mcp", "stdio"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      OBU_PAYLOAD_ROOT: payload,
      OBU_NODE_BINARY: nodeBin,
      OBU_COMMAND: path.join(temp, "bin", "obu"),
      OBU_RUNTIME_DIR: runtimeDir,
    },
  });
  if (result.error) throw result.error;
  return result;
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
