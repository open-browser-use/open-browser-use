import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureRuntimeDir,
  platformDefaultRuntimeDir,
  readUserConfigResult,
  resolveRuntimeLayout,
  validateRuntimeDir,
  writeUserConfig,
  type UserConfig,
} from "./runtime-layout.js";

test("runtime layout honors OBU_RUNTIME_DIR before user config and platform default", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-layout-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config: UserConfig = {
    schemaVersion: 1,
    runtimeDir: path.join(home, "config-runtime"),
    extensionCurrentDir: path.join(home, ".obu", "extension", "current"),
    nativeHostInstallRoot: path.join(home, ".obu", "native-host"),
  };
  await writeUserConfig(path.join(home, ".obu", "config.json"), config);

  const overrideRuntime = path.join(home, "override-runtime");
  const layout = await resolveRuntimeLayout({
    homeDir: home,
    env: { OBU_RUNTIME_DIR: overrideRuntime },
    platform: "darwin",
    repoRoot: "/repo",
  });

  assert.equal(layout.runtimeDir, overrideRuntime);
  assert.equal(layout.extensionCurrentDir, config.extensionCurrentDir);
  assert.equal(layout.nativeHostInstallRoot, config.nativeHostInstallRoot);
});

test("runtime layout falls back to XDG_RUNTIME_DIR on Linux", async () => {
  assert.equal(
    platformDefaultRuntimeDir({ platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/501" } }),
    "/run/user/501/obu",
  );
});

test("runtime layout uses uid-scoped /tmp fallback for macOS and Linux without XDG", async () => {
  assert.match(platformDefaultRuntimeDir({ platform: "darwin", env: {} }), /^\/tmp\/obu-/);
  assert.match(platformDefaultRuntimeDir({ platform: "linux", env: {} }), /^\/tmp\/obu-/);
});

test("runtime layout surfaces malformed user config without throwing", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-layout-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".obu", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{not-json", "utf8");

  const result = await readUserConfigResult(configPath);
  assert.equal(result.config, undefined);
  assert.equal(result.issue?.code, "malformed-json");

  const layout = await resolveRuntimeLayout({
    homeDir: home,
    env: {},
    platform: "darwin",
    repoRoot: "/repo",
  });
  assert.equal(layout.configIssue?.code, "malformed-json");
  assert.match(layout.runtimeDir, /^\/tmp\/obu-/);
});

test("runtime layout resolves packaged payload roots", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-layout-home-"));
  const payload = await mkdtemp(path.join(os.tmpdir(), "obu-payload-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(payload, { recursive: true, force: true }));
  await mkdir(path.join(payload, "extension"), { recursive: true });
  await writeFile(path.join(payload, "extension", "open-browser-use-extension-0.1.0.zip"), "zip", "utf8");

  const layout = await resolveRuntimeLayout({
    homeDir: home,
    env: {
      OBU_PAYLOAD_ROOT: payload,
      OBU_COMMAND: "/usr/local/bin/obu",
      OBU_NODE_BINARY: path.join(payload, "node", "bin", "node"),
    },
    platform: "darwin",
  });

  assert.equal(layout.mode, "packaged");
  assert.equal(layout.root, payload);
  assert.equal(layout.openBrowserUseCommand, "/usr/local/bin/obu");
  assert.equal(layout.cliEntry, path.join(payload, "cli", "dist", "index.js"));
  assert.equal(layout.hostBin, path.join(payload, "bin", "obu-host"));
  assert.equal(layout.nodeReplBin, path.join(payload, "bin", "obu-node-repl"));
  assert.equal(layout.nodeModulesRoot, path.join(payload, "node_modules"));
  assert.equal(layout.sdkPackageRoot, path.join(payload, "node_modules", "@open-browser-use", "sdk"));
  assert.equal(layout.extensionDir, path.join(payload, "extension", "dist"));
  assert.equal(layout.extensionZip, path.join(payload, "extension", "open-browser-use-extension-0.1.0.zip"));
  assert.equal(layout.metadataPath, path.join(payload, "metadata.json"));
});

test("runtime layout lets OBU_PAYLOAD_ROOT win over repoRoot in packaged mode", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-layout-home-"));
  const payload = await mkdtemp(path.join(os.tmpdir(), "obu-payload-current-"));
  const payloadParent = path.dirname(payload);
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(payload, { recursive: true, force: true }));

  const layout = await resolveRuntimeLayout({
    homeDir: home,
    env: { OBU_PAYLOAD_ROOT: payload },
    platform: "darwin",
    repoRoot: payloadParent,
  });

  assert.equal(layout.mode, "packaged");
  assert.equal(layout.root, payload);
  assert.equal(layout.hostBin, path.join(payload, "bin", "obu-host"));
  assert.equal(layout.extensionDir, path.join(payload, "extension", "dist"));
});

test("runtime directory validator rejects symlinks and group-readable modes", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not meaningful on Windows");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dir = path.join(root, "runtime");
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o755);
  const worldReadable = await validateRuntimeDir(dir);
  assert.equal(worldReadable.ok, false);
  assert.match(worldReadable.message ?? "", /owner-only/);

  const target = path.join(root, "target");
  await mkdir(target, { mode: 0o700 });
  const link = path.join(root, "link");
  await symlink(target, link);
  const symlinkResult = await validateRuntimeDir(link);
  assert.equal(symlinkResult.ok, false);
  assert.match(symlinkResult.message ?? "", /symlink/);

  const file = path.join(root, "file");
  await writeFile(file, "not a directory", "utf8");
  const fileResult = await validateRuntimeDir(file);
  assert.equal(fileResult.ok, false);
  assert.match(fileResult.message ?? "", /not a directory/);
});

test("ensureRuntimeDir rejects a symlink without chmodding its target", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX symlink permissions are not meaningful on Windows");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const target = path.join(root, "target");
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o755);
  const link = path.join(root, "runtime-link");
  await symlink(target, link);

  const result = await ensureRuntimeDir(link);

  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /symlink/);
  assert.equal((await stat(target)).mode & 0o777, 0o755);
});
