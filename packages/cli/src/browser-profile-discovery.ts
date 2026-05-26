import { constants } from "node:fs";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type ComponentState =
  | "pass"
  | "warn"
  | "fail"
  | "missing"
  | "unreadable"
  | "disabled"
  | "stale"
  | "invalid"
  | "not_checked";

export type ProfileCandidate = {
  path: string;
  profileExists: ComponentState;
  extensionInstalled: ComponentState;
  extensionEnabled: ComponentState;
  reasons?: Record<string, string>;
};

export async function discoverProfileCandidates(root: string, extensionId: string): Promise<ProfileCandidate[]> {
  const profilePaths = await defaultProfileCandidates(root);
  const candidates = await Promise.all(profilePaths.map((candidate) => inspectProfileCandidate(candidate, extensionId)));
  return orderCandidatesByLastUsed(root, candidates);
}

export function enabledExtensionProfiles(candidates: ProfileCandidate[]): ProfileCandidate[] {
  return candidates.filter((candidate) =>
    candidate.profileExists === "pass" &&
    candidate.extensionInstalled === "pass" &&
    candidate.extensionEnabled === "pass"
  );
}

export async function readLastUsedProfileName(root: string): Promise<string | undefined> {
  const localState = await readJson(path.join(root, "Local State")).catch(() => undefined);
  if (!isRecord(localState)) return undefined;
  const profile = localState.profile;
  if (!isRecord(profile)) return undefined;
  return typeof profile.last_used === "string" && profile.last_used.length > 0
    ? profile.last_used
    : undefined;
}

export async function defaultProfileCandidates(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.name === "NativeMessagingHosts") continue;
    if (entry.name === "Default" || /^Profile \d+$/.test(entry.name)) {
      candidates.push(candidate);
      continue;
    }
    if (await access(path.join(candidate, "Preferences"), constants.R_OK).then(() => true).catch(() => false)) {
      candidates.push(candidate);
    }
  }
  return candidates.sort(compareProfilePaths);
}

export async function inspectProfileCandidate(profilePath: string, extensionId: string): Promise<ProfileCandidate> {
  const stats = await lstat(profilePath).catch((error) => error as NodeJS.ErrnoException);
  if (stats instanceof Error) {
    const missing = stats.code === "ENOENT";
    return {
      path: profilePath,
      profileExists: missing ? "missing" : "unreadable",
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        profileExists: missing ? "profile path does not exist" : `profile path cannot be inspected: ${stats.message}`,
        extensionInstalled: "extension state cannot be inspected until the profile exists and is readable",
        extensionEnabled: "extension state cannot be inspected until the profile exists and is readable",
      },
    };
  }
  if (!stats.isDirectory()) {
    return {
      path: profilePath,
      profileExists: "unreadable",
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        profileExists: "profile path is not a directory",
        extensionInstalled: "extension state cannot be inspected until the profile path is a readable directory",
        extensionEnabled: "extension state cannot be inspected until the profile path is a readable directory",
      },
    };
  }
  if (!await access(profilePath, constants.R_OK).then(() => true).catch(() => false)) {
    return {
      path: profilePath,
      profileExists: "unreadable",
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        profileExists: "profile directory is not readable",
        extensionInstalled: "extension state cannot be inspected until the profile is readable",
        extensionEnabled: "extension state cannot be inspected until the profile is readable",
      },
    };
  }

  const preferenceFiles = [
    path.join(profilePath, "Preferences"),
    path.join(profilePath, "Secure Preferences"),
  ];
  let sawPreferenceFile = false;
  for (const file of preferenceFiles) {
    const preferences = await readJson(file).catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") return undefined;
      return { __obu_read_error: nodeError.message ?? String(error) };
    });
    if (preferences === undefined) continue;
    sawPreferenceFile = true;
    if (isRecord(preferences) && typeof preferences.__obu_read_error === "string") {
      return {
        path: profilePath,
        profileExists: "unreadable",
        extensionInstalled: "not_checked",
        extensionEnabled: "not_checked",
        reasons: {
          profileExists: `profile preferences cannot be read: ${preferences.__obu_read_error}`,
          extensionInstalled: "extension state cannot be inspected until profile preferences are readable",
          extensionEnabled: "extension state cannot be inspected until profile preferences are readable",
        },
      };
    }
    const settings = extensionSettings(preferences, extensionId);
    if (!settings) continue;
    if (settings.state === 0 || hasDisableReasons(settings.disable_reasons)) {
      return {
        path: profilePath,
        profileExists: "pass",
        extensionInstalled: "pass",
        extensionEnabled: "disabled",
        reasons: {
          extensionEnabled: `extension is disabled in ${file}`,
        },
      };
    }
    return {
      path: profilePath,
      profileExists: "pass",
      extensionInstalled: "pass",
      extensionEnabled: "pass",
    };
  }

  return {
    path: profilePath,
    profileExists: "pass",
    extensionInstalled: "missing",
    extensionEnabled: "not_checked",
    reasons: {
      extensionInstalled: sawPreferenceFile
        ? `extension ${extensionId} was not found in profile preferences`
        : "profile preferences do not exist yet",
      extensionEnabled: "enablement was not inspected because the extension is missing",
    },
  };
}

function orderCandidatesByLastUsed(root: string, candidates: ProfileCandidate[]): Promise<ProfileCandidate[]> {
  return readLastUsedProfileName(root).then((lastUsed) => {
    if (!lastUsed) return candidates;
    return [...candidates].sort((left, right) => {
      const leftLast = path.basename(left.path) === lastUsed ? 0 : 1;
      const rightLast = path.basename(right.path) === lastUsed ? 0 : 1;
      if (leftLast !== rightLast) return leftLast - rightLast;
      return compareProfilePaths(left.path, right.path);
    });
  });
}

function extensionSettings(preferences: unknown, extensionId: string): Record<string, any> | undefined {
  if (!isRecord(preferences)) return undefined;
  const extensions = preferences.extensions;
  if (!isRecord(extensions)) return undefined;
  const settings = extensions.settings;
  if (!isRecord(settings)) return undefined;
  const extension = settings[extensionId];
  return isRecord(extension) ? extension : undefined;
}

function hasDisableReasons(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function compareProfilePaths(left: string, right: string): number {
  const leftName = path.basename(left);
  const rightName = path.basename(right);
  const leftRank = profileSortRank(leftName);
  const rightRank = profileSortRank(rightName);
  if (leftRank[0] !== rightRank[0]) return leftRank[0] - rightRank[0];
  if (leftRank[1] !== rightRank[1]) return leftRank[1] - rightRank[1];
  return path.resolve(left).localeCompare(path.resolve(right));
}

function profileSortRank(name: string): [number, number] {
  if (name === "Default") return [0, 0];
  const profile = /^Profile (\d+)$/.exec(name);
  if (profile) return [1, Number(profile[1])];
  return [2, 0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}
