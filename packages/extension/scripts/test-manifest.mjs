import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const manifestPath = path.join(packageRoot, "public", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const extensionId = extensionIdFromKey(manifest.key);

assert.equal(manifest.manifest_version, 3);
assert.equal(extensionId, "fblnfcjnjklpgnmfnngcihbcgojnpadj");
assert.equal(manifest.name, "__MSG_extName__");
assert.equal(manifest.description, "__MSG_extDescription__");
assert.equal(manifest.default_locale, "en");
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
assert.equal(manifest.action.default_title, "__MSG_actionTitle__");
assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: false });
assert.deepEqual(manifest.icons, {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
});
assert.deepEqual(manifest.action.default_icon, {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
});
for (const icon of Object.values(manifest.icons)) {
  await access(path.join(packageRoot, "public", icon));
}

const localeRoot = path.join(packageRoot, "public", "_locales");
const locales = (await readdir(localeRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(locales, [
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
]);
const englishMessages = JSON.parse(await readFile(path.join(localeRoot, "en", "messages.json"), "utf8"));
const englishMessageKeys = Object.keys(englishMessages).sort();
const pluralMessageBases = [
  "deliverableRecovery",
  "debugEnabledEntries",
  "debugDisabledEntries",
  "debugCopiedEntries",
];
const pluralCategories = ["zero", "one", "two", "few", "many", "other"];
const knownExtraPluralKeys = new Set(
  pluralMessageBases
    .flatMap((base) => pluralCategories.map((category) => `${base}_${category}`))
    .filter((key) => !englishMessageKeys.includes(key)),
);
const allowedUntranslatedKeys = new Map([
  ["ar", ["actionTitle", "extName"]],
  ["de", ["actionTitle", "extName", "hostVersionLabel", "versionFallback", "versionLabel"]],
  ["es", ["actionTitle", "extName", "hostVersionLabel"]],
  ["fr", ["actionTitle", "extName", "versionFallback", "versionLabel"]],
  ["hi", ["actionTitle", "extName"]],
  ["id", ["actionTitle", "extName", "hostVersionLabel"]],
  ["it", ["actionTitle", "extName", "hostVersionLabel"]],
  ["ja", ["actionTitle", "extName"]],
  ["ko", ["actionTitle", "extName"]],
  ["nl", ["actionTitle", "extName", "hostVersionLabel", "nativeHostLabel"]],
  ["pl", ["actionTitle", "extName", "hostVersionLabel"]],
  ["pt_BR", ["actionTitle", "extName", "hostVersionLabel"]],
  ["ru", ["actionTitle", "extName"]],
  ["tr", ["actionTitle", "extName"]],
  ["vi", ["actionTitle", "extName"]],
  ["zh_CN", ["actionTitle", "extName"]],
  ["zh_TW", ["actionTitle", "extName"]],
]);
for (const locale of locales) {
  const messages = JSON.parse(await readFile(path.join(localeRoot, locale, "messages.json"), "utf8"));
  const messageKeys = Object.keys(messages).sort();
  const actualRegularKeys = messageKeys.filter((key) => !knownExtraPluralKeys.has(key)).sort();
  assert.deepEqual(actualRegularKeys, englishMessageKeys, `${locale} regular message keys differ from en`);
  const expectedExtraPluralKeys = requiredExtraPluralKeys(locale).sort();
  const actualExtraPluralKeys = messageKeys.filter((key) => knownExtraPluralKeys.has(key)).sort();
  assert.deepEqual(actualExtraPluralKeys, expectedExtraPluralKeys, `${locale} plural message keys differ from Intl.PluralRules`);
  for (const key of [
    "extName",
    "extDescription",
    "actionTitle",
    "popupTitle",
    "copyForAgent",
    "settingsPageTitle",
    "settingsLanguageTitle",
    "settingsLanguageAuto",
  ]) {
    assert.equal(typeof messages[key]?.message, "string", `${locale} is missing ${key}`);
  }
  for (const key of englishMessageKeys) {
    assert.deepEqual(
      Object.keys(messages[key].placeholders ?? {}).sort(),
      Object.keys(englishMessages[key].placeholders ?? {}).sort(),
      `${locale}.${key} placeholders differ from en`,
    );
  }
  for (const key of actualExtraPluralKeys) {
    const base = pluralBaseForKey(key);
    const reference = messages[`${base}_other`];
    assert.equal(typeof messages[key]?.message, "string", `${locale} is missing ${key}`);
    assert.deepEqual(
      Object.keys(messages[key].placeholders ?? {}).sort(),
      Object.keys(reference?.placeholders ?? {}).sort(),
      `${locale}.${key} placeholders differ from ${base}_other`,
    );
  }
  if (locale !== "en") {
    const untranslated = englishMessageKeys.filter((key) => messages[key].message === englishMessages[key].message);
    assert.deepEqual(untranslated, allowedUntranslatedKeys.get(locale), `${locale} has unexpected untranslated UI messages`);
  }
}

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

function requiredExtraPluralKeys(locale) {
  const categories = new Intl.PluralRules(locale.replace("_", "-")).resolvedOptions().pluralCategories;
  return pluralMessageBases
    .flatMap((base) => categories.map((category) => `${base}_${category}`))
    .filter((key) => knownExtraPluralKeys.has(key));
}

function pluralBaseForKey(key) {
  for (const category of pluralCategories) {
    const suffix = `_${category}`;
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length);
  }
  throw new Error(`not a plural message key: ${key}`);
}
