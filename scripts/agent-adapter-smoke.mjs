#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(root, "packages", "cli", "dist", "index.js");
const temp = await mkdtemp(path.join(os.tmpdir(), "obu-agent-smoke-"));

try {
  const home = path.join(temp, "home");
  const bin = path.join(temp, "bin");
  const hostBin = path.join(temp, "obu-host");
  const obuShim = path.join(bin, "obu");
  await mkdir(bin, { recursive: true });
  await writeFile(hostBin, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(hostBin, 0o755);
  await writeFile(obuShim, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(obuShim, 0o755);
  await fakeAgent(bin, "codex", "codex");
  await fakeAgent(bin, "claude", "claude");
  await fakeAgent(bin, "gemini", "gemini");
  await fakeAddOnly(bin, "code", "vscode");
  await fakeCursor(bin);

  const result = spawnSync(process.execPath, [
    cliEntry,
    "setup",
    "--yes",
    "--skip-extension",
    "--agents=codex-cli,claude-code,gemini-cli,vscode,cursor,cline,windsurf,claude-desktop,zed,continue",
    "--json",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: bin,
      OBU_HOST_BIN: hostBin,
      OBU_COMMAND: obuShim,
      OBU_RUNTIME_DIR: path.join(temp, "runtime"),
    },
  });
  if (result.status !== 1) {
    throw new Error(`setup smoke expected manual boundary exit 1:\n${result.stderr}\n${result.stdout}`);
  }
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, "manual_action_required");
  assertStep(report, "agent-codex-cli", "applied");
  assertStep(report, "agent-claude-code", "applied");
  assertStep(report, "agent-gemini-cli", "applied");
  assertStep(report, "agent-vscode", "applied");
  assertStep(report, "agent-cursor", "applied");
  assertStep(report, "agent-cline", "applied");
  assertStep(report, "agent-windsurf", "applied");
  assertStep(report, "agent-claude-desktop", "applied");
  assertStep(report, "agent-zed", "applied");
  assertStep(report, "agent-continue", "manual_action_required");

  // codex-cli is configured by writing its config file directly (no `codex` binary
  // invocation), so assert the written config at the path the CLI reported.
  const codexConfigPath = report.steps.find((step) => step.id === "agent-codex-cli")?.details?.path;
  assert.ok(codexConfigPath, "codex-cli step should report its written config path");
  assert.match(await readFile(codexConfigPath, "utf8"), /\[mcp_servers\.open-browser-use\]/);
  assert.match(await readFile(path.join(temp, "claude.log"), "utf8"), /mcp add -s user open-browser-use -- .* mcp stdio/);
  assert.match(await readFile(path.join(temp, "gemini.log"), "utf8"), /mcp add --scope user open-browser-use .* mcp stdio/);
  assert.match(await readFile(path.join(temp, "vscode.log"), "utf8"), /--add-mcp/);
  // cursor is configured by writing .cursor/mcp.json directly (no `cursor --add-mcp`
  // invocation), so assert the written config at the path the CLI reported.
  const cursorConfigPath = report.steps.find((step) => step.id === "agent-cursor")?.details?.path;
  assert.ok(cursorConfigPath, "cursor step should report its written config path");
  const cursorConfig = JSON.parse(await readFile(cursorConfigPath, "utf8"));
  assert.equal(cursorConfig.mcpServers["open-browser-use"].command, obuShim);
  assert.deepEqual(cursorConfig.mcpServers["open-browser-use"].args, ["mcp", "stdio"]);

  const cline = JSON.parse(await readFile(directEditPath(home, "cline"), "utf8"));
  const windsurf = JSON.parse(await readFile(directEditPath(home, "windsurf"), "utf8"));
  const zed = JSON.parse(await readFile(directEditPath(home, "zed"), "utf8"));
  assert.equal(cline.mcpServers["open-browser-use"].command, obuShim);
  assert.deepEqual(cline.mcpServers["open-browser-use"].args, ["mcp", "stdio"]);
  assert.equal(windsurf.mcpServers["open-browser-use"].command, obuShim);
  assert.deepEqual(windsurf.mcpServers["open-browser-use"].args, ["mcp", "stdio"]);
  assert.equal(zed.context_servers["open-browser-use"].command, obuShim);
  assert.deepEqual(zed.context_servers["open-browser-use"].args, ["mcp", "stdio"]);

  console.log("agent adapter smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function fakeAgent(bin, executable, logName) {
  await writeFile(path.join(bin, executable), `#!/bin/sh
if [ "$1 $2" = "mcp list" ]; then
  exit 0
fi
echo "$@" > ${shellQuote(path.join(temp, `${logName}.log`))}
`, "utf8");
  await chmod(path.join(bin, executable), 0o755);
}

async function fakeAddOnly(bin, executable, logName) {
  await writeFile(path.join(bin, executable), `#!/bin/sh
echo "$@" > ${shellQuote(path.join(temp, `${logName}.log`))}
`, "utf8");
  await chmod(path.join(bin, executable), 0o755);
}

async function fakeCursor(bin) {
  await writeFile(path.join(bin, "cursor"), `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "usage: cursor --add-mcp"
  exit 0
fi
echo "$@" > ${shellQuote(path.join(temp, "cursor.log"))}
`, "utf8");
  await chmod(path.join(bin, "cursor"), 0o755);
}

function assertStep(report, id, status) {
  assert.equal(report.steps.find((step) => step.id === id)?.status, status, id);
}

function directEditPath(home, agent) {
  if (agent === "cline") {
    return process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
      : path.join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
  }
  if (agent === "windsurf") return path.join(home, ".codeium", "windsurf", "mcp_config.json");
  if (agent === "zed") return path.join(home, ".config", "zed", "settings.json");
  throw new Error(`unsupported direct edit path: ${agent}`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
