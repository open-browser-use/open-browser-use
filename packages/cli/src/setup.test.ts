import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setupOpenBrowserUse } from "./setup.js";
import type { RuntimeLayout } from "./runtime-layout.js";

const EXTENSION_KEY = Buffer.from("open-browser-use setup test key").toString("base64");

test("setupOpenBrowserUse composes runtime, native host, extension update, and manual agent boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostBin = path.join(root, "bin", "obu-host");
  await mkdir(path.dirname(hostBin), { recursive: true });
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const sourceDir = await extensionSource(root, "0.6.0");
  const layout = fakeLayout(root, hostBin, sourceDir);

  const result = await setupOpenBrowserUse({
    layout,
    obuVersion: "0.1.0",
    browsers: ["chrome"],
    agents: ["codex-cli"],
    server: mcpServer(root),
    extensionChannel: "unpacked-dev",
    extensionId: extensionIdFromManifestKey(EXTENSION_KEY),
    extensionIdSource: "manifest-key",
    extensionPath: sourceDir,
    env: { PATH: "" },
  });

  assert.equal(result.result, "manual_action_required");
  assert.equal(result.steps.find((step) => step.id === "runtime-dir")?.status, "applied");
  assert.equal(result.steps.find((step) => step.id === "native-host-chrome")?.status, "applied");
  assert.equal(result.steps.find((step) => step.id === "extension-current")?.status, "applied");
  assert.equal(result.steps.find((step) => step.id === "agent-codex-cli")?.status, "applied");
  assert.match(await readFile(path.join(root, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.open-browser-use\]/);
  assert.equal(await readFile(path.join(layout.extensionCurrentDir, "marker.txt"), "utf8"), "0.6.0");
  assert.equal(result.nextActions.some((action) => action.value === "obu mcp-config --agent=codex-cli --print"), false);
  assert.ok(result.nextActions.some((action) =>
    action.kind === "command" &&
    action.value === `${layout.openBrowserUseCommand} verify --agent=codex-cli --browser=chrome --channel=unpacked-dev --extension-id=${extensionIdFromManifestKey(EXTENSION_KEY)}`
  ));
});

test("setupOpenBrowserUse can complete deterministic setup when extension and agents are skipped", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostBin = path.join(root, "bin", "obu-host");
  await mkdir(path.dirname(hostBin), { recursive: true });
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const sourceDir = await extensionSource(root, "0.7.0");
  const layout = fakeLayout(root, hostBin, sourceDir);

  const result = await setupOpenBrowserUse({
    layout,
    obuVersion: "0.1.0",
    browsers: ["chrome"],
    agents: [],
    server: mcpServer(root),
    extensionChannel: "unpacked-dev",
    extensionId: extensionIdFromManifestKey(EXTENSION_KEY),
    extensionIdSource: "manifest-key",
    skipExtension: true,
    skipAgents: true,
  });

  assert.equal(result.result, "complete");
  assert.equal(result.steps.find((step) => step.id === "extension-update")?.status, "skipped");
  assert.equal(result.steps.find((step) => step.id === "agent-adapters")?.status, "skipped");
});

test("setupOpenBrowserUse skips extension staging for Store channel", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostBin = path.join(root, "bin", "obu-host");
  await mkdir(path.dirname(hostBin), { recursive: true });
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const sourceDir = await extensionSource(root, "0.8.0");
  const layout = fakeLayout(root, hostBin, sourceDir);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await setupOpenBrowserUse({
    layout,
    obuVersion: "0.1.0",
    browsers: ["chrome"],
    agents: [],
    server: mcpServer(root),
    extensionChannel: "store",
    extensionId: storeExtensionId,
    extensionIdSource: "explicit-argument",
    skipAgents: true,
  });

  assert.equal(result.result, "complete");
  assert.equal(result.extensionChannel, "store");
  assert.equal(result.extensionId, storeExtensionId);
  assert.equal(result.steps.find((step) => step.id === "extension-update")?.status, "skipped");
  assert.match(result.steps.find((step) => step.id === "extension-update")?.message ?? "", /Chrome Web Store/);
  await assert.rejects(readFile(path.join(layout.extensionCurrentDir, "marker.txt"), "utf8"));
  const nativeHostStep = result.steps.find((step) => step.id === "native-host-chrome");
  assert.equal(nativeHostStep?.details?.extensionId, storeExtensionId);
  assert.equal(result.nextActions.some((action) => action.value.includes("doctor")), false);
  assert.ok(result.nextActions.some((action) =>
    action.kind === "manual" &&
    action.value.includes(`${layout.openBrowserUseCommand} verify '--agent=<agent-id>' --browser=chrome --channel=store --extension-id=${storeExtensionId}`)
  ));
});

async function extensionSource(root: string, version: string): Promise<string> {
  const sourceDir = path.join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), JSON.stringify({ manifest_version: 3, version, key: EXTENSION_KEY }), "utf8");
  await writeFile(path.join(sourceDir, "marker.txt"), version, "utf8");
  return sourceDir;
}

function mcpServer(root: string) {
  return {
    name: "open-browser-use" as const,
    command: path.join(root, "obu"),
    args: ["mcp", "stdio"],
  };
}

function fakeLayout(root: string, hostBin: string, extensionDir: string): RuntimeLayout {
  return {
    mode: "repo",
    root,
    openBrowserUseCommand: path.join(root, "obu"),
    cliEntry: path.join(root, "cli", "index.js"),
    hostBin,
    nodeReplBin: path.join(root, "bin", "obu-node-repl"),
    nodeBin: process.execPath,
    nodeModulesRoot: path.join(root, "node_modules"),
    sdkPackageRoot: path.join(root, "node_modules", "@open-browser-use", "sdk"),
    sdkDistRoot: path.join(root, "node_modules", "@open-browser-use", "sdk", "dist"),
    extensionDir,
    extensionInstallRoot: path.join(root, ".obu", "extension"),
    extensionCurrentDir: path.join(root, ".obu", "extension", "current"),
    nativeHostInstallRoot: path.join(root, ".obu", "native-host"),
    userConfigPath: path.join(root, ".obu", "config.json"),
    runtimeDir: path.join(root, "runtime"),
  };
}

function extensionIdFromManifestKey(key: string): string {
  const der = Buffer.from(key, "base64");
  return [...createHash("sha256").update(der).digest().subarray(0, 16)]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 0x0f))}`)
    .join("");
}
