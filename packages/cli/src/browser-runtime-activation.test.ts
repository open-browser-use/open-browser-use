import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { activateBrowserRuntime } from "./browser-runtime-activation.js";
import { browserProfileRoot } from "./browser-paths.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

test("activateBrowserRuntime opens only enabled extension profiles up to the default limit", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "obu-activation-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  withIsolatedXdgConfigHome(t, homeDir);
  const profileRoot = browserProfileRoot("chrome", process.platform, homeDir);
  await writeChromePreferences(path.join(profileRoot, "Default"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 2"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 3"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 4"), EXTENSION_ID, 1);

  const clock = fakeClock();
  const opened: string[] = [];
  const result = await activateBrowserRuntime({
    browser: "chrome",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir: path.join(homeDir, "runtime"),
    hasActiveDescriptor: async () => opened.length >= 2,
    openPopup: async (target) => {
      assert.equal(target.url, `chrome-extension://${EXTENSION_ID}/pairing.html`);
      opened.push(path.basename(target.profilePath));
    },
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.result, "ready");
  assert.deepEqual(opened, ["Default", "Profile 2"]);
  assert.equal(result.openedCount, 2);
  assert.equal(result.profileLimit, 3);
});

test("activateBrowserRuntime does not open later profiles when descriptor appears after first popup", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "obu-activation-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  withIsolatedXdgConfigHome(t, homeDir);
  const profileRoot = browserProfileRoot("chrome", process.platform, homeDir);
  await writeChromePreferences(path.join(profileRoot, "Default"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 2"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 3"), EXTENSION_ID, 1);
  const clock = fakeClock();
  const opened: string[] = [];

  const result = await activateBrowserRuntime({
    browser: "chrome",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir: path.join(homeDir, "runtime"),
    timeoutMs: 1000,
    intervalMs: 250,
    hasActiveDescriptor: async () => opened.length > 0 && clock.elapsed() >= 250,
    openPopup: async (target) => {
      opened.push(path.basename(target.profilePath));
    },
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.result, "ready");
  assert.deepEqual(opened, ["Default"]);
  assert.equal(result.openedCount, 1);
  assert.equal(clock.elapsed(), 250);
});

test("activateBrowserRuntime never opens more than the default profile limit", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "obu-activation-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  withIsolatedXdgConfigHome(t, homeDir);
  const profileRoot = browserProfileRoot("chrome", process.platform, homeDir);
  await writeChromePreferences(path.join(profileRoot, "Default"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 2"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 3"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 4"), EXTENSION_ID, 1);
  const clock = fakeClock();
  const opened: string[] = [];

  const result = await activateBrowserRuntime({
    browser: "chrome",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir: path.join(homeDir, "runtime"),
    timeoutMs: 1000,
    intervalMs: 250,
    hasActiveDescriptor: async () => false,
    openPopup: async (target) => {
      opened.push(path.basename(target.profilePath));
    },
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.result, "timeout");
  assert.deepEqual(opened, ["Default", "Profile 2", "Profile 3"]);
  assert.equal(result.openedCount, 3);
  assert.equal(result.profileLimit, 3);
});

test("activateBrowserRuntime continues after open failures and counts only opened profiles", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "obu-activation-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  withIsolatedXdgConfigHome(t, homeDir);
  const profileRoot = browserProfileRoot("chrome", process.platform, homeDir);
  await writeChromePreferences(path.join(profileRoot, "Default"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(profileRoot, "Profile 2"), EXTENSION_ID, 1);
  const clock = fakeClock();
  const opened: string[] = [];

  const result = await activateBrowserRuntime({
    browser: "chrome",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir: path.join(homeDir, "runtime"),
    timeoutMs: 1000,
    intervalMs: 250,
    hasActiveDescriptor: async () => opened.includes("Profile 2"),
    openPopup: async (target) => {
      const profile = path.basename(target.profilePath);
      if (profile === "Default") throw new Error("cannot open default");
      opened.push(profile);
    },
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.result, "ready");
  assert.deepEqual(result.attemptedProfiles.map((profilePath) => path.basename(profilePath)), ["Default", "Profile 2"]);
  assert.deepEqual(opened, ["Profile 2"]);
  assert.equal(result.openedCount, 1);
  assert.match(result.errors[0] ?? "", /cannot open default/);
});

test("activateBrowserRuntime stops after 5 seconds when no descriptor appears", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "obu-activation-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  withIsolatedXdgConfigHome(t, homeDir);
  const profileRoot = browserProfileRoot("chrome", process.platform, homeDir);
  await writeChromePreferences(path.join(profileRoot, "Default"), EXTENSION_ID, 1);
  const clock = fakeClock();
  const opened: string[] = [];

  const result = await activateBrowserRuntime({
    browser: "chrome",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir: path.join(homeDir, "runtime"),
    timeoutMs: 5000,
    intervalMs: 500,
    hasActiveDescriptor: async () => false,
    openPopup: async (target) => {
      opened.push(path.basename(target.profilePath));
    },
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.result, "timeout");
  assert.deepEqual(opened, ["Default"]);
  assert.equal(result.timeoutMs, 5000);
  assert.equal(clock.elapsed(), 5000);
});

test("activateBrowserRuntime reports no_candidates without opening a browser", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "obu-activation-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  withIsolatedXdgConfigHome(t, homeDir);
  const profileRoot = browserProfileRoot("chrome", process.platform, homeDir);
  await writeChromePreferences(path.join(profileRoot, "Default"), EXTENSION_ID, 0);
  let openCount = 0;

  const result = await activateBrowserRuntime({
    browser: "chrome",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir: path.join(homeDir, "runtime"),
    hasActiveDescriptor: async () => false,
    openPopup: async () => {
      openCount += 1;
    },
    now: fakeClock().now,
    sleep: async () => undefined,
  });

  assert.equal(result.result, "no_candidates");
  assert.equal(openCount, 0);
  assert.equal(result.candidates.some((candidate) => candidate.extensionEnabled === "disabled"), true);
});

test("activateBrowserRuntime ignores an active descriptor for a different browser", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket descriptor fixture is POSIX-only");
    return;
  }
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "obu-activation-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const runtimeDir = path.join(homeDir, "runtime");
  await writeRuntimeDescriptorFixture(t, runtimeDir, {
    browserKind: "chrome",
    extensionId: EXTENSION_ID,
  });

  const result = await activateBrowserRuntime({
    browser: "edge",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir,
    openPopup: async () => {
      throw new Error("activation should not open a browser when no edge candidates exist");
    },
  });

  assert.equal(result.result, "no_candidates");
  assert.equal(result.openedCount, 0);
});

async function writeChromePreferences(profilePath: string, extensionId: string, state: number): Promise<void> {
  await mkdir(profilePath, { recursive: true });
  const preferences = {
    extensions: {
      settings: {
        [extensionId]: {
          state,
          disable_reasons: 0,
        },
      },
    },
  };
  await writeFile(path.join(profilePath, "Preferences"), JSON.stringify(preferences), "utf8");
}

async function writeRuntimeDescriptorFixture(
  t: TestContext,
  runtimeDir: string,
  metadata: { browserKind: string; extensionId: string },
): Promise<void> {
  const descriptorDir = path.join(runtimeDir, "webextension");
  await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
  await chmod(descriptorDir, 0o700);
  const socketPath = path.join(runtimeDir, `${metadata.browserKind}.sock`);
  await startRuntimeDescriptorServer(t, socketPath, metadata);
  const descriptorPath = path.join(descriptorDir, `${metadata.browserKind}.json`);
  await writeFile(descriptorPath, JSON.stringify({
    schema_version: 1,
    type: "webextension",
    name: metadata.browserKind,
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: metadata.browserKind,
      extension_id: metadata.extensionId,
    },
  }), { encoding: "utf8", mode: 0o600 });
  await chmod(descriptorPath, 0o600);
}

async function startRuntimeDescriptorServer(
  t: TestContext,
  socketPath: string,
  metadata: { browserKind: string; extensionId: string },
): Promise<void> {
  const server = net.createServer((socket) => {
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        if (request.method === "auth") {
          authenticated = true;
          socket.write(encodeTestFrame({ jsonrpc: "2.0", id: request.id, result: null }));
          continue;
        }
        if (authenticated && request.method === "getInfo") {
          socket.write(encodeTestFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              type: "webextension",
              name: metadata.browserKind,
              metadata: {
                backend: {
                  browser_kind: metadata.browserKind,
                  extension_id: metadata.extensionId,
                },
              },
            },
          }));
          continue;
        }
        socket.write(encodeTestFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

function encodeTestFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function fakeClock(): {
  now(): number;
  sleep(ms: number): Promise<void>;
  elapsed(): number;
} {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    elapsed: () => current,
  };
}

function withIsolatedXdgConfigHome(t: TestContext, homeDir: string): void {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  });
}
