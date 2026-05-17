import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));

test("mcp-config print emits a runnable repo-mode invocation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await runCli(["mcp-config", "--agent=codex-cli", "--print"], { HOME: home });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.server.name, "open-browser-use");
  assert.equal(payload.server.command, process.execPath);
  assert.deepEqual(payload.server.args, [cliEntry, "mcp", "stdio"]);
  assert.equal(payload.mode, "shell");
  assert.match(payload.shellCommand, /codex mcp add open-browser-use -- /);
});

test("mcp-config print emits agent-specific config shapes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const vscode = JSON.parse((await runCli(["mcp-config", "--agent=vscode", "--print"], { HOME: home })).stdout);
  assert.equal(vscode.executable, "code");
  assert.deepEqual(vscode.args[0], "--add-mcp");
  assert.equal(JSON.parse(vscode.args[1]).name, "open-browser-use");

  const zed = JSON.parse((await runCli(["mcp-config", "--agent=zed", "--print"], { HOME: home })).stdout);
  assert.equal(zed.mode, "json");
  assert.equal(zed.config.context_servers["open-browser-use"].command, process.execPath);

  const manual = JSON.parse((await runCli(["mcp-config", "--agent=continue", "--print"], { HOME: home })).stdout);
  assert.equal(manual.mode, "manual");
  assert.match(manual.instructions, /MCP server named open-browser-use/);
});

test("mcp-config rejects unknown agents", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["mcp-config", "--agent=unknown", "--print"], { HOME: home });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unsupported agent/);
});

test("mcp stdio missing setup fails before writing stdout", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["mcp", "stdio"], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "missing-runtime"),
  });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /open-browser-use runtime is not ready/);
});

test("mcp stdio malformed config fails before writing stdout", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".obu", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{bad-json", "utf8");

  const result = await runCli(["mcp", "stdio"], { HOME: home });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /user config is invalid/);
});

test("update-extension CLI refreshes current path and reports manual action", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.5.0" }), "utf8");
  await writeFile(path.join(source, "marker.txt"), "extension", "utf8");
  const runtimeDir = path.join(home, "runtime");

  const result = await runCli(["update-extension", "--path", source, "--no-wait", "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "manual_action_required");
  const currentDir = path.join(home, ".obu", "extension", "current");
  assert.equal(payload.extensionCurrentDir, currentDir);
  assert.equal(await readFile(path.join(currentDir, "marker.txt"), "utf8"), "extension");
});

test("setup CLI runs deterministic steps before extension manual boundary", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.8.0" }), "utf8");
  await writeFile(path.join(source, "marker.txt"), "setup-extension", "utf8");
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const runtimeDir = path.join(home, "runtime");

  const result = await runCli(["setup", "--yes", "--path", source, "--skip-agents", "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "manual_action_required");
  assert.equal(payload.steps.some((step: any) => step.id === "native-host-chrome" && step.status === "applied"), true);
  const nativeHost = payload.steps.find((step: any) => step.id === "native-host-chrome");
  assert.match(nativeHost.details.nativeManifestPath, new RegExp(`^${escapeRegExp(home)}`));
  assert.equal(payload.steps.some((step: any) => step.id === "extension-current" && step.status === "applied"), true);
  assert.equal(await readFile(path.join(home, ".obu", "extension", "current", "marker.txt"), "utf8"), "setup-extension");
});

test("setup CLI rejects unknown requested agents before writing", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["setup", "--agents=unknown", "--json"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unsupported agent/);
});

test("commands reject unsupported extension channels explicitly", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["install-host", "--channel=store"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /supports only unpacked-dev/);
});

test("repl command is explicitly deferred in P4a", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["repl"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /repl is deferred in P4a/);
});

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
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
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
