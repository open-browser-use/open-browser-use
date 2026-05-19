import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
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

test("updateExtension ignores malformed runtime descriptor JSON", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-extension-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = await extensionSource(root, "0.4.0");
  const layout = fakeLayout(root);
  await mkdir(path.join(layout.runtimeDir, "webextension"), { recursive: true });
  await writeFile(path.join(layout.runtimeDir, "webextension", "chrome.json"), "{}", "utf8");

  const result = await updateExtension({ layout, sourceDir });

  assert.equal(result.result, "manual_action_required");
});

test("updateExtension reports complete when a runtime descriptor probes successfully", async (t) => {
  if (process.platform === "win32") {
    t.skip("runtime descriptor socket probing is POSIX-only");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-extension-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = await extensionSource(root, "0.5.0");
  const layout = fakeLayout(root);
  const descriptorDir = path.join(layout.runtimeDir, "webextension");
  const socketPath = path.join(root, "runtime.sock");
  await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
  await chmod(descriptorDir, 0o700);
  await startRuntimeDescriptorServer(t, socketPath, "chrome");
  const descriptorPath = path.join(descriptorDir, "chrome.json");
  await writeFile(
    descriptorPath,
    JSON.stringify({
      schema_version: 1,
      type: "webextension",
      name: "chrome",
      socketPath,
      sdk_auth_token: "token",
      pid: process.pid,
    }),
    "utf8",
  );
  await chmod(descriptorPath, 0o600);

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

async function startRuntimeDescriptorServer(t: { after: (fn: () => void | Promise<void>) => void }, socketPath: string, name: string): Promise<void> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) return;
        const payload = JSON.parse(buffer.subarray(4, 4 + len).toString("utf8"));
        buffer = buffer.subarray(4 + len);
        if (payload.method === "auth") {
          socket.write(encodeTestFrame({ jsonrpc: "2.0", id: payload.id, result: null }));
        } else if (payload.method === "getInfo") {
          socket.write(encodeTestFrame({ jsonrpc: "2.0", id: payload.id, result: { type: "webextension", name } }));
        } else {
          socket.write(encodeTestFrame({
            jsonrpc: "2.0",
            id: payload.id,
            error: { code: -32601, message: "method not found" },
          }));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

function encodeTestFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
