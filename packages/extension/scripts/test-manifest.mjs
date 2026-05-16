import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const manifestPath = path.join(packageRoot, "public", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const extensionId = extensionIdFromKey(manifest.key);

assert.equal(manifest.manifest_version, 3);
assert.equal(extensionId, "fblnfcjnjklpgnmfnngcihbcgojnpadj");
assert.deepEqual(
  ["nativeMessaging", "debugger", "tabs", "tabGroups", "scripting", "storage", "history", "downloads", "alarms"].sort(),
  [...manifest.permissions].sort(),
);
assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
assert.deepEqual(manifest.content_scripts, [
  {
    matches: ["<all_urls>"],
    js: ["cursor.js"],
    run_at: "document_start",
    all_frames: true,
    match_about_blank: true,
    match_origin_as_fallback: true,
  },
]);
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(manifest.action.default_popup, "popup.html");

const tmp = await mkdtemp(path.join(os.tmpdir(), "obu-extension-manifest-test-"));
try {
  const hostBinary = path.join(tmp, "obu-host");
  const outputDir = path.join(tmp, "NativeMessagingHosts");
  const wrapperDir = path.join(tmp, "wrapper");
  await writeFile(hostBinary, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(hostBinary, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      path.join(packageRoot, "scripts", "write-dev-native-host-manifest.mjs"),
      "--browser",
      "chrome",
      "--output-dir",
      outputDir,
      "--wrapper-dir",
      wrapperDir,
      "--host-binary",
      hostBinary,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.extensionId, extensionId);
  assert.equal(summary.allowedOrigin, `chrome-extension://${extensionId}/`);

  const nativeManifestPath = path.join(outputDir, "dev.obu.host.json");
  const nativeManifest = JSON.parse(await readFile(nativeManifestPath, "utf8"));
  assert.equal(nativeManifest.name, "dev.obu.host");
  assert.equal(nativeManifest.type, "stdio");
  assert.equal(nativeManifest.path, path.join(wrapperDir, "obu-host-native-wrapper-chrome"));
  assert.deepEqual(nativeManifest.allowed_origins, [`chrome-extension://${extensionId}/`]);

  const wrapper = await readFile(nativeManifest.path, "utf8");
  assert.match(wrapper, /--native-messaging/);
  assert.match(wrapper, /OBU_BROWSER_KIND='chrome'/);
  assert.doesNotMatch(wrapper, /\$@/);
  assert.match(wrapper, new RegExp(escapeRegExp(hostBinary)));
} finally {
  await rm(tmp, { recursive: true, force: true });
}

function extensionIdFromKey(key) {
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...hash]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 0x0f))}`)
    .join("");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
