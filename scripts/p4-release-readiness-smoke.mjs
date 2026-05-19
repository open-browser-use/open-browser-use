#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const p4Targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64-gnu",
  "linux-x64-musl",
  "linux-arm64-gnu",
].sort();
const npmPackages = [
  "@open-browser-use/cli-darwin-arm64",
  "@open-browser-use/cli-darwin-x64",
  "@open-browser-use/cli-linux-x64-gnu",
  "@open-browser-use/cli-linux-x64-musl",
  "@open-browser-use/cli-linux-arm64-gnu",
].sort();
const cargoTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-gnu",
].sort();

await assertExists("LICENSE");
await assertExists("pnpm-lock.yaml");
const gitignore = await text(".gitignore");
assert.equal(/^pnpm-lock\.yaml$/m.test(gitignore), false, "pnpm-lock.yaml must not be ignored");
assert.match(await text("LICENSE"), /MIT License/);

const rootPackage = await json("package.json");
assert.equal(rootPackage.license, "MIT");
for (const script of [
  "stage:npm",
  "smoke:cargo-dist",
  "smoke:curl-install",
  "smoke:npm-pack",
  "smoke:npm-wrapper",
  "smoke:package-static",
  "smoke:setup-local-spine",
  "make:extension-store-artifact",
]) {
  assert.equal(typeof rootPackage.scripts?.[script], "string", `missing package script ${script}`);
}

const cliPackage = await json("packages/cli/package.json");
assert.equal(cliPackage.private, true, "workspace @open-browser-use/cli package must stay private");
assert.equal(cliPackage.license, "MIT");
assert.equal(cliPackage.scripts?.prepublishOnly, "node scripts/deny-direct-publish.mjs");

const { PLATFORM_PACKAGES } = require("./npm/obu-wrapper.cjs");
assert.deepEqual(Object.values(PLATFORM_PACKAGES).sort(), npmPackages);
assertNoWindows(Object.keys(PLATFORM_PACKAGES));
assertNoWindows(Object.values(PLATFORM_PACKAGES));

const nodeManifest = await json("scripts/node-runtime-manifest.json");
assert.deepEqual(Object.keys(nodeManifest.sources).sort(), p4Targets);
assertNoWindows(Object.keys(nodeManifest.sources));

const notices = await text("LICENSE-THIRD-PARTY.md");
assert.match(notices, /## Node\.js Runtime/);
assert.match(notices, /## jsonc-parser/);
assert.match(notices, /## Meriyah/);
assert.match(notices, /Playwright InjectedScript/);

const distWorkspace = await text("dist-workspace.toml");
assert.match(distWorkspace, /cargo-dist-version\s*=\s*"0\.31\.0"/);
for (const target of cargoTargets) assert.match(distWorkspace, new RegExp(escapeRegExp(target)));
assertNoWindows([distWorkspace]);

const makeCurlArtifact = await text("scripts/make-curl-artifact.mjs");
assert.match(makeCurlArtifact, /releaseArtifactPrefix\s*=\s*"open-browser-use"/);
assert.match(makeCurlArtifact, /manifest\.tsv/);
const makeStoreArtifact = await text("scripts/make-extension-store-artifact.mjs");
assert.match(makeStoreArtifact, /store-extension-id/);
assert.match(makeStoreArtifact, /manifestKeyPolicy/);

const extensionReleaseMetadata = await json("packages/extension/release-metadata.json");
assert.equal(extensionReleaseMetadata.unpackedDev.extensionId, "fblnfcjnjklpgnmfnngcihbcgojnpadj");
assert.equal(extensionReleaseMetadata.store.extensionChannel, "store");
assert.equal(extensionReleaseMetadata.store.storeDraftVerified, false);

const workflow = await text(".github/workflows/p4-packaging-ci.yml");
for (const target of p4Targets) assert.match(workflow, new RegExp(`target: ${escapeRegExp(target)}\\b`));
for (const target of cargoTargets) assert.match(workflow, new RegExp(`rust_target: ${escapeRegExp(target)}\\b`));
assert.match(workflow, /p4-target-payloads:/);
assert.match(workflow, /setup-local-spine-smoke\.mjs/);
assert.match(workflow, /actions\/upload-artifact@v4/);
assert.match(workflow, /open-browser-use-\$\{\{ matrix\.target \}\}-curl/);
assertNoWindows([workflow]);

const setupWebext = await text("scripts/setup-webext-e2e.mjs");
assert.match(setupWebext, /"--agents=codex-cli"/);
assert.match(setupWebext, /fakeCodex/);
assert.doesNotMatch(setupWebext, /"--skip-agents"/);

const releaseChecklist = await text("docs/release-checklist.md");
assert.match(releaseChecklist, /Current stance: preview/);
assert.match(releaseChecklist, /Public npm scope\/package access .* is not verified here/);
assert.match(releaseChecklist, /GitHub Release assets, not a dedicated\s+website URL/is);
assert.match(releaseChecklist, /open-browser-use/);
assert.match(releaseChecklist, /p4-target-payloads/);
assert.match(releaseChecklist, /manifest\.tsv/);
assert.match(releaseChecklist, /npm publish order/i);
assert.match(releaseChecklist, /## Rollback/);
assert.match(releaseChecklist, /last known-good/i);
assert.match(releaseChecklist, /doctor --strict.*warnings.*failures/is);
assert.match(releaseChecklist, /Chrome Web Store Gate/);
assert.match(releaseChecklist, /storeExtensionId/);
assert.match(releaseChecklist, /make-extension-store-artifact\.mjs/);

const reviewPack = await text("docs/chrome-web-store-review-pack.md");
assert.match(reviewPack, /Permission Justifications/);
assert.match(reviewPack, /Data Handling/);
assert.match(reviewPack, /Reviewer Instructions/);
assert.match(reviewPack, /--channel=store/);

for (const doc of ["README.md", "docs/install.md", "docs/troubleshooting.md"]) {
  const contents = await text(doc);
  assert.match(contents, /not .*live|not .*verified|preview/i, `${doc} must state the preview release stance`);
  assert.doesNotMatch(contents, /npm i -g @open-browser-use\/cli/, `${doc} must not present public npm install as live`);
  assert.doesNotMatch(contents, /curl -fsSL https?:\/\/\S+\/install \| sh/, `${doc} must not present a public curl install command as live`);
}
assert.match(await text("README.md"), /LICENSE-THIRD-PARTY\.md/);
const troubleshooting = await text("docs/troubleshooting.md");
assert.match(troubleshooting, /Without `--strict`.*exits nonzero only when a check fails/is);
assert.match(troubleshooting, /With\s+`--strict`.*warnings also produce a nonzero exit/is);

console.log("P4 release-readiness smoke passed");

async function assertExists(relativePath) {
  await access(path.join(root, relativePath));
}

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function json(relativePath) {
  return JSON.parse(await text(relativePath));
}

function assertNoWindows(values) {
  assert.equal(values.some((value) => /win32|windows|msvc/i.test(String(value))), false);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
