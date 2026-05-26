import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { browserInstallPath, browserProfileRoot, type BrowserKind } from "./browser-paths.js";
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
    hasActiveWebExtensionRuntimeDescriptor(options.runtimeDir, { extensionId: options.extensionId })
  );
  const openPopup = options.openPopup ?? openBrowserPopup;
  const root = browserProfileRoot(options.browser, process.platform, options.homeDir);
  const candidates = await discoverProfileCandidates(root, options.extensionId);
  const enabled = enabledExtensionProfiles(candidates).slice(0, profileLimit);
  const attemptedProfiles: string[] = [];
  const errors: string[] = [];

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

  const url = `chrome-extension://${options.extensionId}/popup.html`;
  for (const candidate of enabled) {
    attemptedProfiles.push(candidate.path);
    try {
      await openPopup({
        browser: options.browser,
        extensionId: options.extensionId,
        profilePath: candidate.path,
        url,
      });
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
        openedCount: attemptedProfiles.length,
        errors,
      };
    }
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const remaining = Math.max(0, deadline - now());
    await sleep(Math.min(intervalMs, remaining));
    if (await hasActiveDescriptor()) {
      return {
        result: "ready",
        timeoutMs,
        intervalMs,
        profileLimit,
        candidates,
        attemptedProfiles,
        openedCount: attemptedProfiles.length,
        errors,
      };
    }
  }

  return {
    result: errors.length === attemptedProfiles.length ? "open_failed" : "timeout",
    timeoutMs,
    intervalMs,
    profileLimit,
    candidates,
    attemptedProfiles,
    openedCount: attemptedProfiles.length,
    errors,
  };
}

export async function openBrowserPopup(target: BrowserActivationTarget): Promise<void> {
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
