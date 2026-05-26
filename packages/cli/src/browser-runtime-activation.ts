import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { browserInstallPath, browserProfileRoot, browserRuntimeKind, type BrowserKind } from "./browser-paths.js";
import {
  discoverProfileCandidates,
  enabledExtensionProfiles,
  type ProfileCandidate,
} from "./browser-profile-discovery.js";
import { hasActiveWebExtensionRuntimeDescriptor } from "./doctor-browser.js";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_PROFILE_LIMIT = 3;

export type BrowserActivationTarget = {
  browser: BrowserKind;
  extensionId: string;
  profilePath: string;
  url: string;
};

export type BrowserRuntimeActivationResult = {
  result: "ready" | "timeout" | "no_candidates" | "open_failed";
  timeoutMs: number;
  intervalMs: number;
  profileLimit: number;
  candidates: ProfileCandidate[];
  attemptedProfiles: string[];
  openedCount: number;
  errors: string[];
};

export type BrowserRuntimeActivationOptions = {
  browser: BrowserKind;
  extensionId: string;
  homeDir: string;
  runtimeDir: string;
  timeoutMs?: number;
  intervalMs?: number;
  profileLimit?: number;
  openPopup?: (target: BrowserActivationTarget) => Promise<void>;
  hasActiveDescriptor?: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export async function activateBrowserRuntime(options: BrowserRuntimeActivationOptions): Promise<BrowserRuntimeActivationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const profileLimit = options.profileLimit ?? DEFAULT_PROFILE_LIMIT;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const hasActiveDescriptor = options.hasActiveDescriptor ?? (() =>
    hasActiveWebExtensionRuntimeDescriptor(options.runtimeDir, {
      extensionId: options.extensionId,
      browserKind: browserRuntimeKind(options.browser),
    })
  );
  const openPopup = options.openPopup ?? openBrowserPopup;
  const root = browserProfileRoot(options.browser, process.platform, options.homeDir);
  const candidates = await discoverProfileCandidates(root, options.extensionId);
  const enabled = enabledExtensionProfiles(candidates).slice(0, profileLimit);
  const attemptedProfiles: string[] = [];
  const errors: string[] = [];
  let openedCount = 0;

  if (await hasActiveDescriptor()) {
    return {
      result: "ready",
      timeoutMs,
      intervalMs,
      profileLimit,
      candidates,
      attemptedProfiles,
      openedCount: 0,
      errors,
    };
  }

  if (enabled.length === 0) {
    return {
      result: "no_candidates",
      timeoutMs,
      intervalMs,
      profileLimit,
      candidates,
      attemptedProfiles,
      openedCount: 0,
      errors,
    };
  }

  const url = `chrome-extension://${options.extensionId}/pairing.html`;
  const deadline = now() + timeoutMs;
  for (let index = 0; index < enabled.length && now() < deadline; index += 1) {
    const candidate = enabled[index]!;
    attemptedProfiles.push(candidate.path);
    let opened = false;
    try {
      await openPopup({
        browser: options.browser,
        extensionId: options.extensionId,
        profilePath: candidate.path,
        url,
      });
      opened = true;
      openedCount += 1;
    } catch (error) {
      errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (await hasActiveDescriptor()) {
      return {
        result: "ready",
        timeoutMs,
        intervalMs,
        profileLimit,
        candidates,
        attemptedProfiles,
        openedCount,
        errors,
      };
    }
    if (!opened) continue;
    const remainingMs = Math.max(0, deadline - now());
    const remainingProfiles = enabled.length - index;
    const profileWaitMs = Math.max(intervalMs, Math.ceil(remainingMs / remainingProfiles));
    const profileDeadline = Math.min(deadline, now() + profileWaitMs);
    if (await waitForDescriptor({
      deadline: profileDeadline,
      intervalMs,
      now,
      sleep,
      hasActiveDescriptor,
    })) {
      return {
        result: "ready",
        timeoutMs,
        intervalMs,
        profileLimit,
        candidates,
        attemptedProfiles,
        openedCount,
        errors,
      };
    }
  }

  if (openedCount > 0 && await waitForDescriptor({
    deadline,
    intervalMs,
    now,
    sleep,
    hasActiveDescriptor,
  })) {
    return {
      result: "ready",
      timeoutMs,
      intervalMs,
      profileLimit,
      candidates,
      attemptedProfiles,
      openedCount,
      errors,
    };
  }

  return {
    result: openedCount === 0 ? "open_failed" : "timeout",
    timeoutMs,
    intervalMs,
    profileLimit,
    candidates,
    attemptedProfiles,
    openedCount,
    errors,
  };
}

async function waitForDescriptor(input: {
  deadline: number;
  intervalMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  hasActiveDescriptor: () => Promise<boolean>;
}): Promise<boolean> {
  while (input.now() < input.deadline) {
    const remaining = Math.max(0, input.deadline - input.now());
    if (remaining === 0) break;
    await input.sleep(Math.min(input.intervalMs, remaining));
    if (await input.hasActiveDescriptor()) return true;
  }
  return false;
}

export async function openBrowserPopup(target: BrowserActivationTarget): Promise<void> {
  // Test-safety floor: refuse to spawn a real, focus-stealing browser window whenever
  // OBU_DISABLE_BROWSER_LAUNCH is set. The full discovery/wait logic in
  // activateBrowserRuntime still runs; this only blocks the actual launch. Throwing is
  // intentional — activateBrowserRuntime try/catches each open into errors[] and classifies
  // all-failed opens as "open_failed", so the suite (and any future test that writes an
  // enabled profile into a setup HOME) can never spawn a browser during `pnpm test`.
  if (process.env.OBU_DISABLE_BROWSER_LAUNCH) {
    throw new Error("browser launch disabled by OBU_DISABLE_BROWSER_LAUNCH");
  }
  const command = await browserLaunchCommand(target.browser);
  const profileDirectory = path.basename(target.profilePath);
  const args = [`--profile-directory=${profileDirectory}`, target.url];
  await spawnDetached(command, args);
}

async function browserLaunchCommand(browser: BrowserKind): Promise<string> {
  if (process.platform === "darwin") {
    const appPath = browserInstallPath(browser, process.platform);
    if (!appPath) throw new Error(`automatic activation is not supported for ${browser} on darwin`);
    const executable = path.join(appPath, "Contents", "MacOS", path.basename(appPath, ".app"));
    if (await access(executable, constants.X_OK).then(() => true).catch(() => false)) return executable;
    throw new Error(`browser executable not found at ${executable}`);
  }
  if (process.platform === "win32") {
    throw new Error(`automatic activation is not supported for ${browser} on win32 yet`);
  }
  const command = {
    chrome: "google-chrome",
    "chrome-for-testing": "google-chrome-for-testing",
    edge: "microsoft-edge",
    brave: "brave-browser",
    chromium: "chromium",
    arc: "",
  }[browser];
  if (!command) throw new Error(`automatic activation is not supported for ${browser}`);
  return command;
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
