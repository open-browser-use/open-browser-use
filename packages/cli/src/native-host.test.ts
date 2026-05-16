import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installNativeHosts } from "./native-host.js";
import type { RuntimeLayout } from "./runtime-layout.js";

const EXTENSION_KEY = Buffer.from("open-browser-use native host install test key").toString("base64");

test("installNativeHosts writes stable production wrapper and manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-native-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostBin = path.join(root, "bin", "obu-host");
  await mkdir(path.dirname(hostBin), { recursive: true });
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ key: EXTENSION_KEY }), "utf8");
  const runtimeDir = path.join(root, "runtime");
  const layout = fakeLayout(root, hostBin, runtimeDir);

  const actions = await installNativeHosts({
    layout,
    browsers: ["chrome"],
    platform: "darwin",
    homeDir: root,
    manifestPath,
  });

  assert.equal(actions[0]?.status, "applied");
  const wrapperPath = path.join(layout.nativeHostInstallRoot, "dev.obu.host", "chrome", "obu-host-wrapper");
  const nativeManifestPath = path.join(root, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "dev.obu.host.json");
  const wrapper = await readFile(wrapperPath, "utf8");
  const manifest = JSON.parse(await readFile(nativeManifestPath, "utf8"));
  assert.match(wrapper, new RegExp(`OBU_RUNTIME_DIR='${escapeRegExp(runtimeDir)}'`));
  assert.match(wrapper, /exec .*obu-host' --native-messaging/);
  assert.equal((await stat(wrapperPath)).mode & 0o777, 0o755);
  assert.equal(manifest.path, wrapperPath);
  assert.equal(manifest.type, "stdio");
  assert.match(manifest.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);

  const second = await installNativeHosts({
    layout,
    browsers: ["chrome"],
    platform: "darwin",
    homeDir: root,
    manifestPath,
  });
  assert.equal(second[0]?.status, "skipped");
});

test("installNativeHosts dry-run does not write wrapper or manifest", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-native-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostBin = path.join(root, "bin", "obu-host");
  await mkdir(path.dirname(hostBin), { recursive: true });
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ key: EXTENSION_KEY }), "utf8");
  const layout = fakeLayout(root, hostBin, path.join(root, "runtime"));

  const actions = await installNativeHosts({
    layout,
    browsers: ["chrome"],
    platform: "darwin",
    homeDir: root,
    manifestPath,
    dryRun: true,
  });

  assert.equal(actions[0]?.status, "would_apply");
  const wrapperPath = path.join(layout.nativeHostInstallRoot, "dev.obu.host", "chrome", "obu-host-wrapper");
  await assert.rejects(readFile(wrapperPath, "utf8"));
});

test("installNativeHosts writes Chrome for Testing manifest under its profile root on macOS", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-native-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostBin = path.join(root, "bin", "obu-host");
  await mkdir(path.dirname(hostBin), { recursive: true });
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ key: EXTENSION_KEY }), "utf8");
  const layout = fakeLayout(root, hostBin, path.join(root, "runtime"));

  const actions = await installNativeHosts({
    layout,
    browsers: ["chrome-for-testing"],
    platform: "darwin",
    homeDir: root,
    manifestPath,
  });

  assert.equal(actions[0]?.status, "applied");
  await readFile(
    path.join(root, "Library", "Application Support", "Google", "Chrome for Testing", "NativeMessagingHosts", "dev.obu.host.json"),
    "utf8",
  );
});

function fakeLayout(root: string, hostBin: string, runtimeDir: string): RuntimeLayout {
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
    extensionDir: path.join(root, "extension", "dist"),
    extensionInstallRoot: path.join(root, "extension"),
    extensionCurrentDir: path.join(root, "extension", "current"),
    nativeHostInstallRoot: path.join(root, ".obu", "native-host"),
    userConfigPath: path.join(root, ".obu", "config.json"),
    runtimeDir,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
