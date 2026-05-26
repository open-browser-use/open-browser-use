import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  const opened: string[] = [];
  const result = await activateBrowserRuntime({
    browser: "chrome",
    extensionId: EXTENSION_ID,
    homeDir,
    runtimeDir: path.join(homeDir, "runtime"),
    hasActiveDescriptor: async () => opened.length >= 2,
    openPopup: async (target) => {
      opened.push(path.basename(target.profilePath));
    },
    now: fakeClock().now,
    sleep: async () => undefined,
  });

  assert.equal(result.result, "ready");
  assert.deepEqual(opened, ["Default", "Profile 2"]);
  assert.equal(result.openedCount, 2);
  assert.equal(result.profileLimit, 3);
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
