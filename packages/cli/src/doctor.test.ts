import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { doctorAggregate } from "./doctor.js";
import { resolveRuntimeLayout } from "./runtime-layout.js";

test("aggregate doctor surfaces malformed user config as a stable check", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-doctor-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-doctor-root-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const configPath = path.join(home, ".obu", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{bad-json", "utf8");

  const runtimeDir = path.join(root, "runtime");
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const layout = await resolveRuntimeLayout({
    homeDir: home,
    repoRoot: root,
    runtimeDir,
    env: {},
    platform: process.platform,
  });
  const report = await doctorAggregate({
    layout,
    browserOptions: {
      browserInstallPath: root,
      manifestPath: path.join(root, "missing-manifest.json"),
      nativeManifestDir: path.join(root, "NativeMessagingHosts"),
      profileRoot: path.join(root, "profile"),
      runtimeDir,
    },
  });

  const userConfig = report.checks.find((check) => check.id === "user-config");
  assert.equal(userConfig?.status, "fail");
  assert.equal(userConfig?.details?.code, "malformed-json");
  assert.match(userConfig?.message ?? "", /not valid JSON/);
});

test("aggregate doctor verifies packaged payload metadata integrity", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-doctor-home-"));
  const payload = await mkdtemp(path.join(os.tmpdir(), "obu-doctor-payload-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(payload, { recursive: true, force: true }));

  await mkdir(path.join(payload, "bin"), { recursive: true });
  await mkdir(path.join(payload, "cli", "dist"), { recursive: true });
  await mkdir(path.join(payload, "extension", "dist"), { recursive: true });
  await mkdir(path.join(payload, "node", "bin"), { recursive: true });
  await mkdir(path.join(payload, "node_modules", "@open-browser-use", "sdk", "dist"), { recursive: true });
  await mkdir(path.join(payload, "node_modules", "jsonc-parser"), { recursive: true });

  await writeExecutable(path.join(payload, "bin", "obu-host"), "#!/bin/sh\necho 0.1.0\n");
  await writeExecutable(path.join(payload, "bin", "obu-node-repl"), "#!/bin/sh\nexit 0\n");
  await writeExecutable(path.join(payload, "node", "bin", "node"), "#!/bin/sh\necho v22.22.0\n");
  await writeFile(path.join(payload, "cli", "dist", "index.js"), "console.log('obu')\n", "utf8");
  await writeFile(path.join(payload, "node_modules", "@open-browser-use", "sdk", "dist", "index.mjs"), "export const ok = true;\n", "utf8");
  await writeFile(path.join(payload, "node_modules", "jsonc-parser", "package.json"), JSON.stringify({ name: "jsonc-parser" }), "utf8");
  await writeFile(path.join(payload, "extension", "dist", "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.1.0" }), "utf8");
  const extensionZip = path.join(payload, "extension", "open-browser-use-extension-0.1.0.zip");
  await writeFile(extensionZip, "zip-bytes", "utf8");
  await writeFile(path.join(payload, "metadata.json"), JSON.stringify({
    schemaVersion: 1,
    packageVersion: "0.1.0",
    targetTriple: currentTargetTriple(),
    nodeVersion: "22.22.0",
    binaries: { obuHost: "bin/obu-host", obuNodeRepl: "bin/obu-node-repl" },
    sdkHash: await hashTree(path.join(payload, "node_modules", "@open-browser-use", "sdk", "dist")),
    extensionVersion: "0.1.0",
    extensionZip: "extension/open-browser-use-extension-0.1.0.zip",
    extensionZipSha256: await hashFile(extensionZip),
    cliRuntimeDependencies: ["jsonc-parser"],
  }), "utf8");

  const runtimeDir = path.join(home, "runtime");
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const layout = await resolveRuntimeLayout({
    homeDir: home,
    runtimeDir,
    env: { OBU_PAYLOAD_ROOT: payload },
    platform: process.platform,
  });
  const report = await doctorAggregate({
    layout,
    browserOptions: {
      browserInstallPath: payload,
      manifestPath: path.join(payload, "extension", "dist", "manifest.json"),
      nativeManifestDir: path.join(payload, "NativeMessagingHosts"),
      profileRoot: path.join(payload, "profile"),
      runtimeDir,
    },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("payload-metadata")?.status, "pass");
  assert.equal(byId.get("payload-target")?.status, "pass");
  assert.equal(byId.get("payload-node-version")?.status, "pass");
  assert.equal(byId.get("payload-sdk-hash")?.status, "pass");
  assert.equal(byId.get("payload-extension-zip")?.status, "pass");
  assert.equal(byId.get("payload-extension-version")?.status, "pass");
  assert.equal(byId.get("payload-runtime-dependency")?.status, "pass");
});

test("aggregate doctor reports and cleans open-browser-use-generated agent config backups", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-doctor-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-doctor-root-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cursorDir = path.join(home, ".cursor");
  await mkdir(cursorDir, { recursive: true });
  const openBrowserUseBackup = path.join(cursorDir, "mcp.json.bak-20260516T120000Z");
  const userBackup = path.join(cursorDir, "mcp.json.backup");
  await writeFile(openBrowserUseBackup, "{}", "utf8");
  await writeFile(userBackup, "{}", "utf8");

  const runtimeDir = path.join(root, "runtime");
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const layout = await resolveRuntimeLayout({
    homeDir: home,
    repoRoot: root,
    runtimeDir,
    env: {},
    platform: process.platform,
  });
  const browserOptions = {
    browserInstallPath: root,
    manifestPath: path.join(root, "missing-manifest.json"),
    nativeManifestDir: path.join(root, "NativeMessagingHosts"),
    profileRoot: path.join(root, "profile"),
    runtimeDir,
  };

  const report = await doctorAggregate({ layout, browserOptions });
  const backupCheck = report.checks.find((check) => check.id === "agent-config-backups");
  assert.equal(backupCheck?.status, "warn");
  assert.equal(backupCheck?.details?.count, 1);

  const cleaned = await doctorAggregate({ layout, browserOptions, cleanBackups: true });
  const cleanedCheck = cleaned.checks.find((check) => check.id === "agent-config-backups");
  assert.equal(cleanedCheck?.status, "pass");
  assert.equal(cleanedCheck?.details?.count, 1);
  await assert.rejects(() => access(openBrowserUseBackup), { code: "ENOENT" });
  await access(userBackup);
});

async function writeExecutable(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

async function hashTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await listFiles(dir)) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, file)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, full));
    }
  }
  return files;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return `sha256:${hash.digest("hex")}`;
}

function currentTargetTriple(): string {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") {
    const report = typeof process.report?.getReport === "function"
      ? process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
      : undefined;
    const libc = typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}`;
  }
  return `${process.platform}-${process.arch}`;
}
