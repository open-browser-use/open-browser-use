#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cargoDist = process.env.CARGO_DIST_BIN || "cargo-dist";
const expectedTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-gnu",
].sort();
const expectedApps = ["obu-host", "obu-node-repl"];

const pinnedVersion = await pinnedCargoDistVersion();
const version = run(cargoDist, ["--version"]).stdout.trim();
assert.equal(version, `cargo-dist ${pinnedVersion}`);

const plan = JSON.parse(run(cargoDist, [
  "plan",
  "--output-format=json",
  "--tag",
  "v0.1.5",
  "--allow-dirty",
]).stdout);

assert.equal(plan.dist_version, pinnedVersion);
assert.deepEqual(plan.releases.map((release) => release.app_name).sort(), expectedApps);

const matrixTargets = plan.ci?.github?.artifacts_matrix?.include
  ?.flatMap((row) => Array.isArray(row.targets) ? row.targets : [])
  ?.sort();
assert.deepEqual(matrixTargets, expectedTargets);
assert.equal(matrixTargets.some((target) => /windows|win32|msvc/.test(target)), false);

for (const app of expectedApps) {
  for (const target of expectedTargets) {
    const archive = `${app}-${target}.tar.xz`;
    const artifact = plan.artifacts?.[archive];
    assert.ok(artifact, `missing cargo-dist archive artifact ${archive}`);
    assert.deepEqual(artifact.target_triples, [target]);
    assert.equal(artifact.checksum, `${archive}.sha256`);
    assert.ok(plan.artifacts?.[`${archive}.sha256`], `missing checksum artifact for ${archive}`);
  }
}

console.log("cargo-dist smoke passed");

async function pinnedCargoDistVersion() {
  const raw = await readFile(path.join(root, "dist-workspace.toml"), "utf8");
  const match = raw.match(/cargo-dist-version\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("dist-workspace.toml is missing cargo-dist-version");
  return match[1];
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}
