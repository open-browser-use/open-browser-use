import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nativeMessagingHostDir } from "./browser-paths.js";

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

test("update-extension default output is concise and verbose keeps step ids", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.5.1" }), "utf8");
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime") };

  const summary = await runCli(["update-extension", "--path", source, "--no-wait"], env);
  assert.equal(summary.code, 1);
  assert.equal(summary.stderr, "");
  assert.match(summary.stdout, /Extension files refreshed\. Browser reload required\./);
  assert.match(summary.stdout, /Open chrome:\/\/extensions/);
  assert.doesNotMatch(summary.stdout, /extension-current:/);

  const verbose = await runCli(["update-extension", "--path", source, "--no-wait", "--verbose"], env);
  assert.equal(verbose.code, 1);
  assert.match(verbose.stdout, /extension-current:/);
  assert.match(verbose.stdout, /runtime-descriptor-probe:/);
});

test("update-extension CLI rejects a persisted Store channel by default", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".obu", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    runtimeDir: path.join(home, "runtime"),
    extensionCurrentDir: path.join(home, ".obu", "extension", "current"),
    nativeHostInstallRoot: path.join(home, ".obu", "native-host"),
    extensionChannel: "store",
    storeExtensionId: "abcdefghijklmnopabcdefghijklmnop",
  }), "utf8");

  const result = await runCli(["update-extension", "--json"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Chrome Web Store manages Store extension updates/);
});

test("setup default output summarizes dry-run planned work and verbose keeps step ids", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "0.8.1",
    key: Buffer.from("open-browser-use cli dry run key").toString("base64"),
  }), "utf8");
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime"), OBU_HOST_BIN: hostBin };
  const args = ["setup", "--yes", "--path", source, "--skip-agents", "--dry-run"];

  const summary = await runCli(args, env);
  assert.equal(summary.code, 0);
  assert.equal(summary.stderr, "");
  assert.match(summary.stdout, /Setup dry run: no changes made\./);
  assert.match(summary.stdout, /Planned changes: .*would ensure runtime directory/);
  assert.match(summary.stdout, /would write native-host wrapper/);
  assert.doesNotMatch(summary.stdout, /native-host-chrome:/);
  assert.doesNotMatch(summary.stdout, /extension-current:/);

  const verbose = await runCli([...args, "--verbose"], env);
  assert.equal(verbose.code, 0);
  assert.match(verbose.stdout, /WOULD_APPLY\s+runtime-dir:/);
  assert.match(verbose.stdout, /WOULD_APPLY\s+native-host-chrome:/);
  assert.match(verbose.stdout, /WOULD_APPLY\s+extension-current:/);

  const json = await runCli([...args, "--json"], env);
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.steps.find((step: any) => step.id === "runtime-dir")?.status, "would_apply");
  assert.equal(payload.steps.find((step: any) => step.id === "native-host-chrome")?.status, "would_apply");
  assert.equal(payload.steps.find((step: any) => step.id === "extension-current")?.status, "would_apply");
});

test("setup dry-run summary includes planned agent adapter work", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime"), OBU_HOST_BIN: hostBin };
  const args = [
    "setup",
    "--yes",
    "--channel=store",
    "--extension-id",
    "abcdefghijklmnopabcdefghijklmnop",
    "--agents=zed",
    "--dry-run",
  ];

  const summary = await runCli(args, env);
  assert.equal(summary.code, 0);
  assert.match(summary.stdout, /Planned changes: .*would update zed MCP config/);
  assert.doesNotMatch(summary.stdout, /agent-zed:/);

  const verbose = await runCli([...args, "--verbose"], env);
  assert.match(verbose.stdout, /WOULD_APPLY\s+agent-zed: would update zed MCP config/);

  const json = await runCli([...args, "--json"], env);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.steps.find((step: any) => step.id === "agent-zed")?.status, "would_apply");
});

test("setup summary preserves manual agent next actions", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli(["setup", "--yes", "--channel=store", "--extension-id", storeExtensionId, "--agents=continue"], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Setup needs 1 manual step\./);
  assert.match(result.stdout, /obu mcp-config --agent=continue --print/);
  assert.match(result.stdout, /obu doctor browser --channel=store/);
  assert.doesNotMatch(result.stdout, /agent-continue:/);
});

test("setup recovery mode exits zero for manual action but not failed setup", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "0.8.2",
    key: Buffer.from("open-browser-use cli recovery key").toString("base64"),
  }), "utf8");
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime"), OBU_HOST_BIN: hostBin };

  const manualDefault = await runCli(["setup", "--yes", "--path", source, "--skip-agents"], env);
  assert.equal(manualDefault.code, 1);
  assert.match(manualDefault.stdout, /Setup needs 1 manual step\./);

  const manualRecovery = await runCli(["setup", "--yes", "--path", source, "--skip-agents", "--recovery"], env);
  assert.equal(manualRecovery.code, 0);
  assert.match(manualRecovery.stdout, /Setup needs 1 manual step\./);

  const failedHome = await mkdtemp(path.join(os.tmpdir(), "obu-cli-failed-home-"));
  t.after(() => rm(failedHome, { recursive: true, force: true }));
  const failedRecovery = await runCli([
    "setup",
    "--yes",
    "--channel=store",
    "--extension-id",
    "abcdefghijklmnopabcdefghijklmnop",
    "--skip-agents",
    "--recovery",
  ], {
    HOME: failedHome,
    OBU_RUNTIME_DIR: path.join(failedHome, "runtime"),
    OBU_HOST_BIN: path.join(bin, "missing-obu-host"),
  });
  assert.equal(failedRecovery.code, 1);
  assert.match(failedRecovery.stdout, /Setup failed\./);
});

test("setup CLI runs deterministic steps before extension manual boundary", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "0.8.0",
    key: Buffer.from("open-browser-use cli setup test key").toString("base64"),
  }), "utf8");
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

test("setup CLI supports Store channel without staging an unpacked extension", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const runtimeDir = path.join(home, "runtime");
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli(["setup", "--yes", "--channel=store", "--extension-id", storeExtensionId, "--skip-agents", "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "complete");
  assert.equal(payload.extensionChannel, "store");
  assert.equal(payload.extensionId, storeExtensionId);
  assert.equal(payload.steps.some((step: any) => step.id === "extension-update" && step.status === "skipped"), true);
  assert.equal(payload.steps.some((step: any) => step.id === "extension-current"), false);
  const config = JSON.parse(await readFile(path.join(home, ".obu", "config.json"), "utf8"));
  assert.equal(config.extensionChannel, "store");
  assert.equal(config.storeExtensionId, storeExtensionId);
});

test("setup CLI rejects unknown requested agents before writing", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["setup", "--agents=unknown", "--json"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unsupported agent/);
});

test("Store channel fails loudly when no Store extension id is configured", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["doctor", "browser", "--channel=store"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /store extension id is not configured/);
});

test("aggregate doctor CLI honors Store channel and extension id source", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli(["doctor", "--channel=store", "--extension-id", storeExtensionId, "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
  });

  assert.notEqual(result.code, 2);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "doctor");
  assert.equal(payload.extension.channel, "store");
  assert.equal(payload.extension.id, storeExtensionId);
  assert.equal(payload.extension.idSource, "explicit-argument");
  assert.equal(payload.checks.some((check: any) =>
    check.id === "extension-installed" &&
    check.details?.channel === "store" &&
    check.details?.extensionId === storeExtensionId
  ), true);
});

test("commands reject unknown extension channels explicitly", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["install-host", "--channel=bogus"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Supported channels: unpacked-dev, store/);
});

test("install-host default output is summarized and verbose keeps details", async (t) => {
  if (process.platform === "win32") {
    t.skip("native host install is not supported on Windows");
    return;
  }
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
  };

  const summary = await runCli(["install-host", "--browser=chrome", "--dry-run"], env);
  assert.equal(summary.code, 0);
  assert.equal(summary.stdout, "Native host dry run: would update chrome.\n");

  const verbose = await runCli(["install-host", "--browser=chrome", "--dry-run", "--verbose"], env);
  assert.equal(verbose.code, 0);
  assert.match(verbose.stdout, /WOULD_APPLY chrome: would write native-host wrapper and manifest/);

  const failed = await runCli(["install-host", "--browser=chrome"], {
    HOME: home,
    OBU_HOST_BIN: path.join(bin, "missing-obu-host"),
    OBU_RUNTIME_DIR: path.join(home, "failed-runtime"),
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /Native host install failed for chrome: obu-host is not executable\. Run with --verbose for the path\./);
  assert.doesNotMatch(failed.stdout, new RegExp(escapeRegExp(path.join(bin, "missing-obu-host"))));

  const failedVerbose = await runCli(["install-host", "--browser=chrome", "--verbose"], {
    HOME: home,
    OBU_HOST_BIN: path.join(bin, "missing-obu-host"),
    OBU_RUNTIME_DIR: path.join(home, "failed-runtime-verbose"),
  });
  assert.equal(failedVerbose.code, 1);
  assert.match(failedVerbose.stdout, new RegExp(escapeRegExp(path.join(bin, "missing-obu-host"))));
});

test("install-host CLI writes Store native host manifest for Store extension id", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli(["install-host", "--channel=store", "--extension-id", storeExtensionId, "--json"], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.extensionChannel, "store");
  assert.equal(payload.extensionId, storeExtensionId);
  const nativeHost = JSON.parse(await readFile(path.join(nativeMessagingHostDir("chrome", process.platform, home), "dev.obu.host.json"), "utf8"));
  assert.deepEqual(nativeHost.allowed_origins, [`chrome-extension://${storeExtensionId}/`]);
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
