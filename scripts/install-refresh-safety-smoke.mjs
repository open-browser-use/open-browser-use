#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { payloadRequiredFiles } from "./payload-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "scripts", "install.sh");
const temp = await mkdtemp(path.join(os.tmpdir(), "obu-install-refresh-"));

try {
  await corruptExtractionKeepsOldPayload();
  await invalidPayloadKeepsOldPayload();
  await missingRuntimeCriticalFileKeepsOldPayload("missing-node", { includeNode: false }, /payload validation failed: node\/bin\/node/);
  await missingRuntimeCriticalFileKeepsOldPayload("missing-host", { includeHost: false }, /payload validation failed: bin\/obu-host/);
  await missingRuntimeCriticalFileKeepsOldPayload("missing-cli", { includeCli: false }, /payload validation failed: cli\/dist\/index\.js/);
  await missingRuntimeCriticalFileKeepsOldPayload("missing-sdk", { includeSdkBundle: false }, /payload validation failed: node_modules\/@open-browser-use\/sdk\/dist\/index\.mjs/);
  await missingRuntimeCriticalFileKeepsOldPayload("missing-extension", { includeExtensionManifest: false }, /payload validation failed: extension\/dist\/manifest\.json/);
  await missingNodeReplKeepsOldPayload();
  await nonExecutableNodeReplKeepsOldPayload();
  await sameNameActivationFailureRestoresOldPayload();
  await currentSymlinkFailureRestoresPreviousSymlink();
  await payloadMigrationHookRunsBeforeCurrentSwitch();
  await invalidMigrationHookNameFailsBeforeCurrentSwitch();
  await payloadMigrationFailureRestoresOldPayload();
  await forcedReinstallPreservesMetadata();
  await payloadRetentionPrunesInactivePayloads();
  await payloadRetentionZeroDisablesPruning();
  await invalidPayloadRetentionFailsBeforeRefresh();
  console.log("install refresh safety smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function corruptExtractionKeepsOldPayload() {
  const dir = await caseDir("corrupt-extract");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const artifact = await makeArtifact(dir, "open-browser-use-safety", "old");
  runInstall({ artifact, installDir, home });

  const corruptDir = path.join(dir, "corrupt");
  await mkdir(corruptDir, { recursive: true });
  const corruptArtifact = path.join(corruptDir, "open-browser-use-safety.tar.gz");
  await writeFile(corruptArtifact, "not a tarball", "utf8");

  const failed = runInstall({ artifact: corruptArtifact, installDir, home, allowFailure: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /extract failed/);
  await assertPayloadMarker(installDir, "open-browser-use-safety", "old");
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-safety");
}

async function invalidPayloadKeepsOldPayload() {
  const dir = await caseDir("invalid-payload");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const artifact = await makeArtifact(dir, "open-browser-use-invalid", "old");
  runInstall({ artifact, installDir, home });

  const invalidArtifact = await makeArtifact(path.join(dir, "invalid"), "open-browser-use-invalid", "new", {
    executableHost: false,
  });
  const failed = runInstall({ artifact: invalidArtifact, installDir, home, allowFailure: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /payload validation failed: bin\/obu-host/);
  await assertPayloadMarker(installDir, "open-browser-use-invalid", "old");
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-invalid");
}

async function missingRuntimeCriticalFileKeepsOldPayload(caseName, artifactOptions, expectedError) {
  const dir = await caseDir(caseName);
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const payloadName = `open-browser-use-${caseName}`;
  const artifact = await makeArtifact(dir, payloadName, "old");
  runInstall({ artifact, installDir, home });

  const invalidArtifact = await makeArtifact(path.join(dir, "invalid"), payloadName, "new", artifactOptions);
  const failed = runInstall({ artifact: invalidArtifact, installDir, home, allowFailure: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, expectedError);
  await assertPayloadMarker(installDir, payloadName, "old");
  assert.equal(await readlink(currentLink(installDir)), payloadName);
}

async function missingNodeReplKeepsOldPayload() {
  const dir = await caseDir("missing-node-repl");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const artifact = await makeArtifact(dir, "open-browser-use-missing-repl", "old");
  runInstall({ artifact, installDir, home });

  const invalidArtifact = await makeArtifact(path.join(dir, "invalid"), "open-browser-use-missing-repl", "new", {
    includeNodeRepl: false,
  });
  const failed = runInstall({ artifact: invalidArtifact, installDir, home, allowFailure: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /payload validation failed: bin\/obu-node-repl/);
  await assertPayloadMarker(installDir, "open-browser-use-missing-repl", "old");
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-missing-repl");
}

async function nonExecutableNodeReplKeepsOldPayload() {
  const dir = await caseDir("non-executable-node-repl");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const artifact = await makeArtifact(dir, "open-browser-use-non-exec-repl", "old");
  runInstall({ artifact, installDir, home });

  const invalidArtifact = await makeArtifact(path.join(dir, "invalid"), "open-browser-use-non-exec-repl", "new", {
    executableNodeRepl: false,
  });
  const failed = runInstall({ artifact: invalidArtifact, installDir, home, allowFailure: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /payload validation failed: bin\/obu-node-repl/);
  await assertPayloadMarker(installDir, "open-browser-use-non-exec-repl", "old");
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-non-exec-repl");
}

async function sameNameActivationFailureRestoresOldPayload() {
  const dir = await caseDir("activation-failure");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const artifact = await makeArtifact(dir, "open-browser-use-same", "old");
  runInstall({ artifact, installDir, home });

  const newArtifact = await makeArtifact(path.join(dir, "new"), "open-browser-use-same", "new");
  const wrappers = await writeFailureWrappers(dir);
  const failed = runInstall({
    artifact: newArtifact,
    installDir,
    home,
    allowFailure: true,
    env: {
      PATH: `${wrappers}${path.delimiter}${process.env.PATH ?? ""}`,
      OBU_TEST_FAIL_STAGE_DEST: path.join(installDir, "payloads", "open-browser-use-same"),
    },
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /could not activate new payload/);
  await assertPayloadMarker(installDir, "open-browser-use-same", "old");
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-same");
}

async function currentSymlinkFailureRestoresPreviousSymlink() {
  const dir = await caseDir("current-symlink-failure");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const oldArtifact = await makeArtifact(dir, "open-browser-use-old", "old");
  runInstall({ artifact: oldArtifact, installDir, home });

  const newArtifact = await makeArtifact(path.join(dir, "new"), "open-browser-use-new", "new");
  const wrappers = await writeFailureWrappers(dir);
  const failed = runInstall({
    artifact: newArtifact,
    installDir,
    home,
    allowFailure: true,
    env: {
      PATH: `${wrappers}${path.delimiter}${process.env.PATH ?? ""}`,
      OBU_TEST_LN_FAIL_ONCE_FILE: path.join(dir, "ln-failed-once"),
      OBU_TEST_LN_FAIL_TARGET: "open-browser-use-new",
    },
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /could not update current payload symlink/);
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-old");
  await assertPayloadMarker(installDir, "open-browser-use-old", "old");
  await assert.rejects(() => access(path.join(installDir, "payloads", "open-browser-use-new")), { code: "ENOENT" });
}

async function payloadMigrationHookRunsBeforeCurrentSwitch() {
  const dir = await caseDir("payload-migration-hook");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const oldArtifact = await makeArtifact(dir, "open-browser-use-migration-old", "old");
  runInstall({ artifact: oldArtifact, installDir, home });

  const newArtifact = await makeArtifact(path.join(dir, "new"), "open-browser-use-migration-new", "new", {
    migrationScript: `#!/bin/sh
set -eu
mkdir -p "$OBU_INSTALL_DIR/migrations"
printf '%s|%s|%s' "$(basename "$OBU_PAYLOAD_DIR")" "$OBU_PREVIOUS_PAYLOAD" "native-host-layout-v1" > "$OBU_INSTALL_DIR/migrations/001-native-host-layout"
`,
  });
  runInstall({ artifact: newArtifact, installDir, home });

  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-migration-new");
  assert.equal(
    await readFile(path.join(installDir, "migrations", "001-native-host-layout"), "utf8"),
    "open-browser-use-migration-new|open-browser-use-migration-old|native-host-layout-v1",
  );
}

async function invalidMigrationHookNameFailsBeforeCurrentSwitch() {
  const dir = await caseDir("payload-migration-invalid-name");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const oldArtifact = await makeArtifact(dir, "open-browser-use-migration-invalid-old", "old");
  runInstall({ artifact: oldArtifact, installDir, home });

  const newArtifact = await makeArtifact(path.join(dir, "new"), "open-browser-use-migration-invalid-new", "new", {
    migrationName: "001-Native_Host.sh",
    migrationScript: "#!/bin/sh\nexit 0\n",
  });
  const failed = runInstall({ artifact: newArtifact, installDir, home, allowFailure: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /payload migration has invalid name: 001-Native_Host\.sh/);
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-migration-invalid-old");
  await assertPayloadMarker(installDir, "open-browser-use-migration-invalid-old", "old");
  await assertPayloadAbsent(installDir, "open-browser-use-migration-invalid-new");
}

async function payloadMigrationFailureRestoresOldPayload() {
  const dir = await caseDir("payload-migration-failure");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const oldArtifact = await makeArtifact(dir, "open-browser-use-migration-rollback-old", "old");
  runInstall({ artifact: oldArtifact, installDir, home });

  const newArtifact = await makeArtifact(path.join(dir, "new"), "open-browser-use-migration-rollback-new", "new", {
    migrationScript: "#!/bin/sh\nexit 42\n",
  });
  const failed = runInstall({ artifact: newArtifact, installDir, home, allowFailure: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /payload migration failed/);
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-migration-rollback-old");
  await assertPayloadMarker(installDir, "open-browser-use-migration-rollback-old", "old");
  await assertPayloadAbsent(installDir, "open-browser-use-migration-rollback-new");
}

async function payloadRetentionPrunesInactivePayloads() {
  const dir = await caseDir("payload-retention-prunes");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const names = [
    "open-browser-use-retain-a",
    "open-browser-use-retain-b",
    "open-browser-use-retain-c",
    "open-browser-use-retain-d",
    "open-browser-use-retain-e",
  ];

  for (let index = 0; index < names.length - 1; index += 1) {
    const artifact = await makeArtifact(path.join(dir, names[index]), names[index], `old-${index}`);
    runInstall({ artifact, installDir, home, env: { OBU_PAYLOAD_RETENTION: "0" } });
    await setPayloadMtime(installDir, names[index], index + 1);
  }

  const newestArtifact = await makeArtifact(path.join(dir, names[4]), names[4], "newest");
  runInstall({ artifact: newestArtifact, installDir, home, env: { OBU_PAYLOAD_RETENTION: "2" } });

  assert.equal(await readlink(currentLink(installDir)), names[4]);
  await assertPayloadMarker(installDir, names[4], "newest");
  await assertPayloadMarker(installDir, names[3], "old-3");
  await assertPayloadAbsent(installDir, names[0]);
  await assertPayloadAbsent(installDir, names[1]);
  await assertPayloadAbsent(installDir, names[2]);
  assert.deepEqual(await listPayloadDirs(installDir), [names[3], names[4]]);
}

async function payloadRetentionZeroDisablesPruning() {
  const dir = await caseDir("payload-retention-zero");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const names = [
    "open-browser-use-keep-a",
    "open-browser-use-keep-b",
    "open-browser-use-keep-c",
    "open-browser-use-keep-d",
  ];

  for (let index = 0; index < names.length; index += 1) {
    const artifact = await makeArtifact(path.join(dir, names[index]), names[index], `keep-${index}`);
    runInstall({ artifact, installDir, home, env: { OBU_PAYLOAD_RETENTION: "0" } });
  }

  assert.equal(await readlink(currentLink(installDir)), names.at(-1));
  for (let index = 0; index < names.length; index += 1) {
    await assertPayloadMarker(installDir, names[index], `keep-${index}`);
  }
  assert.deepEqual(await listPayloadDirs(installDir), [...names].sort());
}

async function invalidPayloadRetentionFailsBeforeRefresh() {
  const dir = await caseDir("payload-retention-invalid");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const oldArtifact = await makeArtifact(dir, "open-browser-use-retention-old", "old");
  runInstall({ artifact: oldArtifact, installDir, home });

  const newArtifact = await makeArtifact(path.join(dir, "new"), "open-browser-use-retention-new", "new");
  const failed = runInstall({
    artifact: newArtifact,
    installDir,
    home,
    allowFailure: true,
    env: { OBU_PAYLOAD_RETENTION: "invalid" },
  });

  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /OBU_PAYLOAD_RETENTION must be a non-negative integer/);
  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-retention-old");
  await assertPayloadMarker(installDir, "open-browser-use-retention-old", "old");
  await assertPayloadAbsent(installDir, "open-browser-use-retention-new");
}

async function forcedReinstallPreservesMetadata() {
  const dir = await caseDir("forced-reinstall-metadata");
  const installDir = path.join(dir, "install");
  const home = path.join(dir, "home");
  const artifact = await makeArtifact(dir, "open-browser-use-reinstall", "stable", {
    metadata: {
      marker: "stable",
      packageVersion: "9.9.9",
      extensionChannel: "unpacked-dev",
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  });

  runInstall({ artifact, installDir, home });
  const firstMetadata = await readFile(path.join(installDir, "payloads", "open-browser-use-reinstall", "metadata.json"), "utf8");
  runInstall({ artifact, installDir, home });
  const secondMetadata = await readFile(path.join(installDir, "payloads", "open-browser-use-reinstall", "metadata.json"), "utf8");

  assert.equal(await readlink(currentLink(installDir)), "open-browser-use-reinstall");
  assert.equal(secondMetadata, firstMetadata);
  await assertPayloadMarker(installDir, "open-browser-use-reinstall", "stable");
}

async function caseDir(name) {
  const dir = path.join(temp, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function makeArtifact(parent, name, marker, options = {}) {
  const source = path.join(parent, `${name}-src-${marker}`);
  const artifactDir = path.join(parent, "artifacts", marker);
  const artifact = path.join(artifactDir, `${name}.tar.gz`);
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "node", "bin"), { recursive: true });
  await mkdir(path.join(source, "cli", "dist"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "@open-browser-use", "sdk", "dist"), { recursive: true });
  await mkdir(path.join(source, "extension", "dist"), { recursive: true });
  await writeFile(path.join(source, "marker.txt"), marker, "utf8");
  await writeFile(
    path.join(source, "metadata.json"),
    JSON.stringify(options.metadata ?? { marker, release: { requiredFiles: payloadRequiredFiles } }),
    "utf8",
  );
  if (options.includeNode !== false) {
    await writeExecutable(path.join(source, "node", "bin", "node"), "#!/bin/sh\nexit 0\n");
  }
  if (options.includeHost !== false) {
    await writeExecutable(path.join(source, "bin", "obu-host"), "#!/bin/sh\nexit 0\n");
    if (options.executableHost === false) await chmod(path.join(source, "bin", "obu-host"), 0o644);
  }
  if (options.includeNodeRepl !== false) {
    await writeExecutable(path.join(source, "bin", "obu-node-repl"), "#!/bin/sh\nexit 0\n");
    if (options.executableNodeRepl === false) await chmod(path.join(source, "bin", "obu-node-repl"), 0o644);
  }
  if (options.migrationScript) {
    await mkdir(path.join(source, "install-migrations.d"), { recursive: true });
    await writeExecutable(path.join(source, "install-migrations.d", options.migrationName ?? "001-native-host-layout.sh"), options.migrationScript);
  }
  if (options.includeCli !== false) {
    await writeFile(path.join(source, "cli", "dist", "index.js"), "console.log('obu')\n", "utf8");
  }
  if (options.includeSdkBundle !== false) {
    await writeFile(path.join(source, "node_modules", "@open-browser-use", "sdk", "dist", "index.mjs"), "export {}\n", "utf8");
  }
  if (options.includeExtensionManifest !== false) {
    await writeFile(path.join(source, "extension", "dist", "manifest.json"), "{\"manifest_version\":3}\n", "utf8");
  }
  await mkdir(artifactDir, { recursive: true });
  run("tar", ["-czf", artifact, "-C", source, "."]);
  return artifact;
}

async function writeExecutable(file, content) {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

async function writeFailureWrappers(dir) {
  const wrapperDir = path.join(dir, "wrappers");
  await mkdir(wrapperDir, { recursive: true });
  await writeExecutable(path.join(wrapperDir, "mv"), `#!/bin/sh
if [ "$#" -eq 2 ] && [ -n "\${OBU_TEST_FAIL_STAGE_DEST:-}" ] && [ "$2" = "$OBU_TEST_FAIL_STAGE_DEST" ]; then
  case "$1" in
    */.open-browser-use-*.tmp.*) exit 91 ;;
  esac
fi
exec /bin/mv "$@"
`);
  await writeExecutable(path.join(wrapperDir, "ln"), `#!/bin/sh
if [ "$#" -eq 3 ] && [ "$1" = "-s" ] && [ -n "\${OBU_TEST_LN_FAIL_TARGET:-}" ] && [ "$2" = "$OBU_TEST_LN_FAIL_TARGET" ] && [ -n "\${OBU_TEST_LN_FAIL_ONCE_FILE:-}" ]; then
  if [ ! -e "$OBU_TEST_LN_FAIL_ONCE_FILE" ]; then
    printf failed > "$OBU_TEST_LN_FAIL_ONCE_FILE"
    exit 92
  fi
fi
exec /bin/ln "$@"
`);
  return wrapperDir;
}

function runInstall({ artifact, installDir, home, env = {}, allowFailure = false }) {
  return run("sh", [
    installer,
    "--artifact",
    artifact,
    "--install-dir",
    installDir,
    "--no-modify-path",
  ], { HOME: home, OBU_PAYLOAD_RETENTION: "", ...env }, { allowFailure });
}

function run(command, args, env = {}, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

async function assertPayloadMarker(installDir, payloadName, marker) {
  assert.equal(await readFile(path.join(installDir, "payloads", payloadName, "marker.txt"), "utf8"), marker);
}

async function assertPayloadAbsent(installDir, payloadName) {
  await assert.rejects(() => access(path.join(installDir, "payloads", payloadName)), { code: "ENOENT" });
}

async function setPayloadMtime(installDir, payloadName, seconds) {
  const when = new Date(seconds * 1000);
  await utimes(path.join(installDir, "payloads", payloadName), when, when);
}

async function listPayloadDirs(installDir) {
  const entries = await readdir(path.join(installDir, "payloads"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function currentLink(installDir) {
  return path.join(installDir, "payloads", "current");
}
