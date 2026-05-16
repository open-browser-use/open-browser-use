import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { updateExtension } from "./extension-update.js";
import type { RuntimeLayout } from "./runtime-layout.js";

test("updateExtension stages a versioned payload and refreshes stable current path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-extension-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = await extensionSource(root, "0.2.0");
  const currentDir = path.join(root, ".obu", "extension", "current");
  await mkdir(currentDir, { recursive: true });
  await writeFile(path.join(currentDir, "stale.txt"), "old", "utf8");
  const layout = fakeLayout(root);

  const result = await updateExtension({ layout, sourceDir });

  assert.equal(result.result, "manual_action_required");
  assert.equal(result.extensionCurrentDir, currentDir);
  assert.equal(await readFile(path.join(currentDir, "manifest.json"), "utf8").then(JSON.parse).then((row) => row.version), "0.2.0");
  assert.equal(await readFile(path.join(currentDir, "marker.txt"), "utf8"), "0.2.0");
  assert.equal(await readFile(path.join(root, ".obu", "extension", "versions", "0.2.0", "marker.txt"), "utf8"), "0.2.0");
  await assert.rejects(readFile(path.join(currentDir, "stale.txt"), "utf8"));
  assert.ok(result.nextActions.some((action) => action.value.includes(currentDir)));
});

test("updateExtension dry-run reports actions without writing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-extension-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = await extensionSource(root, "0.3.0");
  const layout = fakeLayout(root);

  const result = await updateExtension({ layout, sourceDir, dryRun: true });

  assert.equal(result.result, "manual_action_required");
  assert.equal(result.steps.some((step) => step.status === "would_apply"), true);
  await assert.rejects(readFile(path.join(layout.extensionCurrentDir, "manifest.json"), "utf8"));
});

test("updateExtension reports complete when a runtime descriptor is already active", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-extension-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = await extensionSource(root, "0.4.0");
  const layout = fakeLayout(root);
  await mkdir(path.join(layout.runtimeDir, "webextension"), { recursive: true });
  await writeFile(path.join(layout.runtimeDir, "webextension", "chrome.json"), "{}", "utf8");

  const result = await updateExtension({ layout, sourceDir });

  assert.equal(result.result, "complete");
  assert.equal(result.nextActions[0]?.value, "obu doctor browser");
});

async function extensionSource(root: string, version: string): Promise<string> {
  const sourceDir = path.join(root, "source");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "manifest.json"), JSON.stringify({ manifest_version: 3, version }), "utf8");
  await writeFile(path.join(sourceDir, "marker.txt"), version, "utf8");
  return sourceDir;
}

function fakeLayout(root: string): RuntimeLayout {
  return {
    mode: "repo",
    root,
    openBrowserUseCommand: path.join(root, "obu"),
    cliEntry: path.join(root, "cli", "index.js"),
    hostBin: path.join(root, "bin", "obu-host"),
    nodeReplBin: path.join(root, "bin", "obu-node-repl"),
    nodeBin: process.execPath,
    nodeModulesRoot: path.join(root, "node_modules"),
    sdkPackageRoot: path.join(root, "node_modules", "@open-browser-use", "sdk"),
    sdkDistRoot: path.join(root, "node_modules", "@open-browser-use", "sdk", "dist"),
    extensionDir: path.join(root, "source"),
    extensionInstallRoot: path.join(root, ".obu", "extension"),
    extensionCurrentDir: path.join(root, ".obu", "extension", "current"),
    nativeHostInstallRoot: path.join(root, ".obu", "native-host"),
    userConfigPath: path.join(root, ".obu", "config.json"),
    runtimeDir: path.join(root, "runtime"),
  };
}
