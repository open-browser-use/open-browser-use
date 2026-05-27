import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = path.resolve(packageRoot, "..", "..");
const tmp = await mkdtemp(path.join(os.tmpdir(), "obu-store-artifact-"));

try {
  runBuild("unpacked-dev");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "dist", "manifest.json"), "utf8"));
  const extensionId = extensionIdFromManifestKey(manifest.key);

  const unpackedResult = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "make-extension-store-artifact.mjs"),
      "--store-extension-id",
      extensionId,
      "--out",
      path.join(tmp, "unpacked"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(unpackedResult.status, 0, "unpacked-dev popup must not pass Store artifact validation");
  assert.match(unpackedResult.stderr || unpackedResult.stdout, /Store popup validation failed/);

  runBuild("store");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "make-extension-store-artifact.mjs"),
      "--store-extension-id",
      extensionId,
      "--out",
      path.join(tmp, "store"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const summary = JSON.parse(await readFile(path.join(tmp, "store", "chrome-web-store-artifact.json"), "utf8"));
  assert.equal(summary.extensionChannel, "store");
  assert.equal(summary.storeExtensionId, extensionId);
  assert.equal(summary.storeExtensionIdStatus, "provided");
  assert.equal(summary.sourceManifestKeyId, extensionId);
  assert.equal(summary.manifestKeyPolicy, "omitted-for-store-upload");
  assert.equal(summary.popupChannel, "store");
  assert.match(summary.artifact, /^open-browser-use-chrome-web-store-.+\.zip$/);
  assert.match(summary.sha256, /^sha256:[0-9a-f]{64}$/);
  const expectedBaseContents = [
    "background.js",
    "browser_capability_controller.js",
    "browser_debugger_controller.js",
    "browser_download_controller.js",
    "browser_session_controller.js",
    "browser_session_repository.js",
    "cursor.js",
    "finalize_tabs_controller.js",
    "foreground_observer.js",
    "i18n.js",
    "icons/icon-128.png",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "lifecycle/browser_session_machine.js",
    "lifecycle/cdp_input_machine.js",
    "lifecycle/download_lifecycle_machine.js",
    "lifecycle/extension_update_machine.js",
    "lifecycle/finalize_tabs_machine.js",
    "lifecycle/foreground_observer_machine.js",
    "lifecycle/native_request_bridge_machine.js",
    "lifecycle/native_transport_machine.js",
    "lifecycle/overlay_machine.js",
    "lifecycle/tab_ownership_machine.js",
    "manifest.json",
    "native_host_bridge.js",
    "native_transport_controller.js",
    "options.css",
    "options.html",
    "options.js",
    "overlay_coordinator.js",
    "pairing.css",
    "pairing.html",
    "popup.css",
    "popup.html",
    "popup.js",
    "session_store.js",
    "tab_group_manager.js",
    "tab_lifecycle_controller.js",
    "vendor/browser-control-core.mjs",
  ].sort();
  const expectedLocaleContents = [
    "ar",
    "de",
    "en",
    "es",
    "fr",
    "hi",
    "id",
    "it",
    "ja",
    "ko",
    "nl",
    "pl",
    "pt_BR",
    "ru",
    "tr",
    "vi",
    "zh_CN",
    "zh_TW",
  ].map((locale) => `_locales/${locale}/messages.json`).sort();
  const actualContents = [...summary.contents].sort();
  assert.deepEqual(actualContents.filter((file) => !file.startsWith("_locales/")), expectedBaseContents);
  assert.deepEqual(actualContents.filter((file) => file.startsWith("_locales/")), expectedLocaleContents);
  const zippedManifest = JSON.parse(readZipEntry(path.join(tmp, "store", summary.artifact), "manifest.json"));
  assert.equal(zippedManifest.key, undefined, "Chrome Web Store upload manifest must omit key");

  const draftResult = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "make-extension-store-artifact.mjs"),
      "--out",
      path.join(tmp, "draft"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(draftResult.status, 0, draftResult.stderr || draftResult.stdout);
  const draftSummary = JSON.parse(await readFile(path.join(tmp, "draft", "chrome-web-store-artifact.json"), "utf8"));
  assert.equal(draftSummary.storeExtensionId, null);
  assert.equal(draftSummary.storeExtensionIdStatus, "pending-chrome-web-store-draft");
} finally {
  runBuild("unpacked-dev");
  await rm(tmp, { recursive: true, force: true });
}

function runBuild(channel) {
  const result = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "build.mjs"), "--channel", channel], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function readZipEntry(zipPath, entryName) {
  const result = spawnSync("unzip", ["-p", zipPath, entryName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function extensionIdFromManifestKey(key) {
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...hash]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 0x0f))}`)
    .join("");
}
