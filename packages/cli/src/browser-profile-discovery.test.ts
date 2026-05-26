import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverProfileCandidates,
  enabledExtensionProfiles,
  readLastUsedProfileName,
} from "./browser-profile-discovery.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

test("discoverProfileCandidates orders last used profile before default sort", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-profile-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeChromePreferences(path.join(root, "Default"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(root, "Profile 2"), EXTENSION_ID, 1);
  await writeFile(path.join(root, "Local State"), JSON.stringify({
    profile: { last_used: "Profile 2" },
  }), "utf8");

  assert.equal(await readLastUsedProfileName(root), "Profile 2");
  const candidates = await discoverProfileCandidates(root, EXTENSION_ID);

  assert.deepEqual(candidates.map((candidate) => path.basename(candidate.path)), [
    "Profile 2",
    "Default",
  ]);
});

test("enabledExtensionProfiles keeps only installed and enabled extension profiles", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-profile-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeChromePreferences(path.join(root, "Default"), EXTENSION_ID, 1);
  await writeChromePreferences(path.join(root, "Profile 2"), EXTENSION_ID, 0);
  await writeChromePreferences(path.join(root, "Profile 4"), EXTENSION_ID, 1, { permissions_increase: true });
  await writeChromePreferences(path.join(root, "Profile 5"), EXTENSION_ID, 1, ["corrupt_permissions"]);
  await mkdir(path.join(root, "Profile 3"), { recursive: true });
  await writeFile(path.join(root, "Profile 3", "Preferences"), JSON.stringify({ extensions: { settings: {} } }), "utf8");

  const candidates = await discoverProfileCandidates(root, EXTENSION_ID);
  const enabled = enabledExtensionProfiles(candidates);

  assert.deepEqual(enabled.map((candidate) => path.basename(candidate.path)), ["Default"]);
  assert.equal(candidates.find((candidate) => path.basename(candidate.path) === "Profile 2")?.extensionEnabled, "disabled");
  assert.equal(candidates.find((candidate) => path.basename(candidate.path) === "Profile 3")?.extensionInstalled, "missing");
  assert.equal(candidates.find((candidate) => path.basename(candidate.path) === "Profile 4")?.extensionEnabled, "disabled");
  assert.equal(candidates.find((candidate) => path.basename(candidate.path) === "Profile 5")?.extensionEnabled, "disabled");
});

async function writeChromePreferences(
  profilePath: string,
  extensionId: string,
  state: number,
  disableReasons: unknown = 0,
): Promise<void> {
  await mkdir(profilePath, { recursive: true });
  const preferences = {
    extensions: {
      settings: {
        [extensionId]: {
          state,
          disable_reasons: disableReasons,
        },
      },
    },
  };
  await writeFile(path.join(profilePath, "Preferences"), JSON.stringify(preferences), "utf8");
}
