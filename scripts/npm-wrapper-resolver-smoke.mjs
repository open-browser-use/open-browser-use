#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PLATFORM_PACKAGES, detectLibc, resolvePayloadPackage } = require("./npm/obu-wrapper.cjs");

const gnuReport = { getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) };
const muslReport = { getReport: () => ({ header: {} }) };

assert.equal(resolvePayloadPackage({ platform: "darwin", arch: "arm64" }), "@open-browser-use/cli-darwin-arm64");
assert.equal(resolvePayloadPackage({ platform: "darwin", arch: "x64" }), "@open-browser-use/cli-darwin-x64");
assert.equal(resolvePayloadPackage({ platform: "linux", arch: "x64", report: gnuReport }), "@open-browser-use/cli-linux-x64-gnu");
assert.equal(resolvePayloadPackage({ platform: "linux", arch: "x64", report: muslReport }), "@open-browser-use/cli-linux-x64-musl");
assert.equal(resolvePayloadPackage({ platform: "linux", arch: "arm64", report: gnuReport }), "@open-browser-use/cli-linux-arm64-gnu");
assert.equal(detectLibc({ platform: "linux", report: gnuReport }), "gnu");
assert.equal(detectLibc({ platform: "linux", report: muslReport }), "musl");
assert.throws(() => resolvePayloadPackage({ platform: "linux", arch: "arm64", report: muslReport }), /does not provide/);
assert.throws(() => resolvePayloadPackage({ platform: "win32", arch: "x64" }), /does not provide/);
assert.equal(Object.values(PLATFORM_PACKAGES).some((name) => /win32|windows|msvc/.test(name)), false);

console.log("npm wrapper resolver smoke passed");
