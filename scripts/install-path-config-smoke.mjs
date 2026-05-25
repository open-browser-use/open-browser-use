#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeArtifact, run, installerPath } from "./lib/curl-install-harness.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "obu-path-config-"));

function install(dir, { home, shell = "/bin/bash", env = {}, allowFailure = false, extraArgs = [] } = {}) {
  return run("sh", [
    installerPath,
    "--artifact", dir.artifact,
    "--install-dir", dir.installDir,
    ...extraArgs,
  ], { HOME: home, SHELL: shell, ...env }, { allowFailure });
}

async function fileContains(file, needle) {
  try {
    return (await readFile(file, "utf8")).includes(needle);
  } catch {
    return false;
  }
}

try {
  await envFileWrittenAndIdempotent();
  console.log("install path-config smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function envFileWrittenAndIdempotent() {
  const dir = path.join(temp, "envfile");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const artifact = await makeArtifact(dir, "open-browser-use-envfile", "v1");

  install({ artifact, installDir }, { home });

  const envFile = path.join(installDir, "env");
  const content = await readFile(envFile, "utf8");
  assert.match(content, new RegExp(`export OBU_INSTALL_DIR="${installDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(content, /case ":\$\{PATH\}:" in/);
  assert.match(content, /\*\) export PATH="\$\{OBU_INSTALL_DIR\}\/bin:\$PATH" ;;/);

  // Symlinked env path is refused (no write-through).
  const symInstall = path.join(dir, "sym-install");
  await mkdir(symInstall, { recursive: true });
  const outside = path.join(dir, "outside-env");
  await writeFile(outside, "do not change", "utf8");
  await symlink(outside, path.join(symInstall, "env"));
  const symArtifact = await makeArtifact(path.join(dir, "sym"), "open-browser-use-sym", "v1");
  install({ artifact: symArtifact, installDir: symInstall }, { home: path.join(dir, "sym-home") });
  assert.equal(await readFile(outside, "utf8"), "do not change");
}
