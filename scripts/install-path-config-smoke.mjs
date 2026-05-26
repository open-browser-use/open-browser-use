#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeArtifact, run, installerPath } from "./lib/curl-install-harness.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "obu-path-config-"));

const SENTINEL = "# >>> open-browser-use installer (managed v1) >>>";

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
  await profileCoverageAndBashTrap();
  await idempotentReRun();
  await bashProfileWrittenWhenPresent();
  await fishCoverage();
  await zdotdirMissingDirCovered();
  await optOutsSkipAllWrites();
  await activationHintPrinted();
  await legacyLineWarnedNotRemoved();
  await nonFatalOnUnwritableProfile();
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

async function profileCoverageAndBashTrap() {
  const dir = path.join(temp, "coverage");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".profile"), "# user profile\n", "utf8"); // exists, no .bash_profile
  const artifact = await makeArtifact(dir, "open-browser-use-cov", "v1");

  install({ artifact, installDir }, { home, shell: "/bin/bash" });

  const sourceLine = `. "${installDir}/env"`;
  for (const name of [".profile", ".bashrc", ".zshrc", ".zprofile"]) {
    assert.equal(await fileContains(path.join(home, name), SENTINEL), true, `${name} missing sentinel`);
    assert.equal(await fileContains(path.join(home, name), sourceLine), true, `${name} missing source line`);
  }
  // Bash first-match trap: .bash_profile must NOT be created when absent.
  await assert.rejects(() => access(path.join(home, ".bash_profile")), { code: "ENOENT" });
}

async function idempotentReRun() {
  const dir = path.join(temp, "idempotent");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const artifact = await makeArtifact(dir, "open-browser-use-idem", "v1");

  install({ artifact, installDir }, { home });
  install({ artifact, installDir }, { home });

  const profile = await readFile(path.join(home, ".profile"), "utf8");
  const occurrences = profile.split(SENTINEL).length - 1;
  assert.equal(occurrences, 1, "source block appended more than once");
}

async function bashProfileWrittenWhenPresent() {
  const dir = path.join(temp, "bashprofile");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".bash_profile"), "# user bash_profile\n", "utf8");
  const artifact = await makeArtifact(dir, "open-browser-use-bp", "v1");

  install({ artifact, installDir }, { home, shell: "/bin/bash" });
  assert.equal(await fileContains(path.join(home, ".bash_profile"), SENTINEL), true);
}

async function fishCoverage() {
  const dir = path.join(temp, "fish");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const artifact = await makeArtifact(dir, "open-browser-use-fish", "v1");

  install({ artifact, installDir }, { home, shell: "/usr/bin/fish" });
  const fishFile = path.join(home, ".config", "fish", "conf.d", "obu.fish");
  assert.equal(await fileContains(fishFile, "fish_add_path"), true);

  // Non-fish user without ~/.config/fish: do not create a fish tree.
  const home2 = path.join(dir, "home2");
  await mkdir(home2, { recursive: true });
  install({ artifact, installDir: path.join(dir, "install2"), }, { home: home2, shell: "/bin/bash" });
  await assert.rejects(() => access(path.join(home2, ".config", "fish")), { code: "ENOENT" });
}

async function zdotdirMissingDirCovered() {
  const dir = path.join(temp, "zdotdir");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const zdotdir = path.join(home, "zsh-config-does-not-exist-yet"); // intentionally absent
  const artifact = await makeArtifact(dir, "open-browser-use-zdot", "v1");

  install({ artifact, installDir }, { home, shell: "/bin/zsh", env: { ZDOTDIR: zdotdir } });

  // The installer must create the missing ZDOTDIR and source the env file from .zshrc there.
  assert.equal(await fileContains(path.join(zdotdir, ".zshrc"), SENTINEL), true, "ZDOTDIR/.zshrc not created");
}

async function optOutsSkipAllWrites() {
  const artifact = await makeArtifact(path.join(temp, "optout-art"), "open-browser-use-optout", "v1");
  const cases = [
    { name: "flag", extraArgs: ["--no-modify-path"], env: {} },
    { name: "env", extraArgs: [], env: { OBU_NO_MODIFY_PATH: "1" } },
    { name: "unmanaged", extraArgs: [], env: { OBU_UNMANAGED_INSTALL: "1" } },
  ];
  for (const c of cases) {
    const dir = path.join(temp, `optout-${c.name}`);
    await mkdir(dir, { recursive: true });
    const installDir = path.join(dir, "install");
    const home = path.join(dir, "home");
    await mkdir(home, { recursive: true });
    install({ artifact, installDir }, { home, env: c.env, extraArgs: c.extraArgs });
    await assert.rejects(() => access(path.join(installDir, "env")), { code: "ENOENT" }, `${c.name}: env file should be absent`);
    await assert.rejects(() => access(path.join(home, ".profile")), { code: "ENOENT" }, `${c.name}: .profile should be untouched`);
  }
}

async function activationHintPrinted() {
  const dir = path.join(temp, "activation");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const artifact = await makeArtifact(dir, "open-browser-use-act", "v1");
  const result = install({ artifact, installDir }, { home });
  assert.match(result.stdout, new RegExp(`Activate in this shell:\\s+\\. "${installDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/env"`));
}

async function legacyLineWarnedNotRemoved() {
  const dir = path.join(temp, "legacy");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  const legacy = `eval "$(${installDir}/bin/obu shellenv bash)"\n`;
  await writeFile(path.join(home, ".profile"), legacy, "utf8");
  const artifact = await makeArtifact(dir, "open-browser-use-legacy", "v1");
  const result = install({ artifact, installDir }, { home });
  assert.match(result.stderr + result.stdout, /older 'obu shellenv' line/);
  assert.equal(await fileContains(path.join(home, ".profile"), "obu shellenv bash"), true, "legacy line must NOT be removed");
}

async function nonFatalOnUnwritableProfile() {
  const dir = path.join(temp, "nonfatal");
  await mkdir(dir, { recursive: true });
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".profile"), "# locked\n", "utf8");
  await chmod(path.join(home, ".profile"), 0o444);
  const artifact = await makeArtifact(dir, "open-browser-use-nf", "v1");
  const result = install({ artifact, installDir }, { home, allowFailure: true });
  assert.equal(result.status, 0, "install must succeed even if a profile is unwritable");
  await access(path.join(installDir, "bin", "obu")); // payload still active
}
