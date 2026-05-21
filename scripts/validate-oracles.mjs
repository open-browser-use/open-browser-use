#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oracle = await json("tests/oracles/browser-contracts.oracle.json");
const rootPackage = await json("package.json");

assert.equal(oracle.schemaVersion, "open-browser-use.product-contracts/v1");
assertArray(oracle.sourceAnchors, "sourceAnchors");
assertUniqueStrings(oracle.sourceAnchors, "sourceAnchors");
assertArray(oracle.requiredWireMethods, "requiredWireMethods");
assertArray(oracle.requiredProductErrors, "requiredProductErrors");
assertArray(oracle.requiredRpcErrorConstants, "requiredRpcErrorConstants");
assertArray(oracle.goldenFixtures, "goldenFixtures");
assertArray(oracle.liveBrowserContracts, "liveBrowserContracts");

const sdkMethods = await text("packages/sdk/src/wire/methods.ts");
const exportedMethodValues = new Set([...sdkMethods.matchAll(/export const [A-Z0-9_]+ = "([^"]+)" as const;/g)].map((match) => match[1]));
for (const method of oracle.requiredWireMethods) {
  assert.equal(exportedMethodValues.has(method), true, `wire method oracle missing implementation: ${method}`);
}

const sdkErrors = await text("packages/sdk/src/errors.ts");
const productErrorCodes = new Set([...sdkErrors.matchAll(/code: "([a-z_]+)"/g)].map((match) => match[1]));
for (const code of oracle.requiredProductErrors) {
  assert.equal(productErrorCodes.has(code), true, `product error oracle missing implementation: ${code}`);
}
for (const constant of oracle.requiredRpcErrorConstants) {
  assert.match(sdkErrors, new RegExp(`export const ${constant}\\b`), `SDK error constant missing: ${constant}`);
}

const rustErrors = await text("crates/obu-wire/src/error.rs");
for (const constant of oracle.requiredRpcErrorConstants) {
  assert.match(rustErrors, new RegExp(`pub const ${constant}\\b`), `wire error constant missing: ${constant}`);
}

for (const fixture of oracle.goldenFixtures) {
  assert.equal(typeof fixture.id, "string");
  assert.equal(typeof fixture.path, "string");
  assert.equal(typeof fixture.schemaVersion, "string");
  const payload = await json(fixture.path);
  assert.equal(payload.schemaVersion, fixture.schemaVersion, `fixture schema mismatch: ${fixture.id}`);
  assertArray(payload.cases, `${fixture.id}.cases`);
  assert.equal(payload.caseCount, payload.cases.length, `fixture caseCount mismatch: ${fixture.id}`);
  for (const [index, item] of payload.cases.entries()) {
    assert.equal(typeof item.expression, "string", `${fixture.id}.cases[${index}].expression`);
    assert.equal(typeof item.expectedSelector, "string", `${fixture.id}.cases[${index}].expectedSelector`);
  }
}

const liveIds = new Set();
for (const contract of oracle.liveBrowserContracts) {
  assert.equal(typeof contract.id, "string");
  assert.equal(liveIds.has(contract.id), false, `duplicate live browser contract id: ${contract.id}`);
  liveIds.add(contract.id);
  assert.equal(typeof contract.test, "string", `${contract.id}.test`);
  assert.equal(typeof contract.smokeScript, "string", `${contract.id}.smokeScript`);
  assert.equal(typeof rootPackage.scripts?.[contract.smokeScript], "string", `${contract.id} smoke script missing from package.json`);
  assert.equal(typeof contract.scope, "string", `${contract.id}.scope`);
  assert.equal(contract.requiresLiveBrowser, true, `${contract.id}.requiresLiveBrowser`);
  assert.match(contract.test, /--ignored\b/, `${contract.id} live test must be explicitly ignored`);
}

console.log("oracle validation passed");

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function json(relativePath) {
  return JSON.parse(await text(relativePath));
}

function assertArray(value, label) {
  assert.equal(Array.isArray(value), true, `${label} must be an array`);
}

function assertUniqueStrings(values, label) {
  const seen = new Set();
  for (const value of values) {
    assert.equal(typeof value, "string", `${label} entries must be strings`);
    assert.equal(seen.has(value), false, `${label} has duplicate entry: ${value}`);
    seen.add(value);
  }
}
