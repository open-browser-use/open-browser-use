#!/usr/bin/env node
import assert from "node:assert/strict";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = path.join(root, "dist", "curl");
const args = parseArgs(process.argv.slice(2));
const manifest = JSON.parse(await readFile(path.join(artifactRoot, "manifest.json"), "utf8"));
const tsvManifest = await readTsvManifest(path.join(artifactRoot, "manifest.tsv"));
const artifactTarget = args.target === "current" ? currentTargetTriple() : args.target;
const artifact = manifest.artifacts?.find((row) => row.target === artifactTarget);
if (!artifact) throw new Error(`curl manifest has no artifact for ${artifactTarget}`);
assertCurlManifest(manifest, tsvManifest);

const temp = await mkdtemp(path.join(os.tmpdir(), "obu-curl-install-"));
try {
  const installDir = path.join(temp, "install");
  const home = path.join(temp, "home");
  const installer = path.join(artifactRoot, manifest.installer);
  const artifactPath = path.join(artifactRoot, artifact.file);
  const defaultInstall = run("sh", [
    installer,
    "--artifact",
    artifactPath,
    "--checksum",
    artifact.sha256,
    "--install-dir",
    installDir,
    "--no-modify-path",
  ], { HOME: home });
  assert.match(defaultInstall.stdout, /open-browser-use installed at /);
  assert.match(defaultInstall.stdout, /Run: .*\/bin\/obu bootstrap --yes --all --agents=auto/);
  assert.doesNotMatch(defaultInstall.stdout, /Next steps:/);
  assert.doesNotMatch(defaultInstall.stdout, /checksum:/);

  const obu = path.join(installDir, "bin", "obu");
  await access(obu);
  const version = run(obu, ["--version"], { HOME: home });
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/);
  const shellenv = run(obu, ["shellenv", "sh"], { HOME: home });
  assert.match(shellenv.stdout, new RegExp(`export OBU_INSTALL_DIR='${escapeRegExp(installDir)}';`));
  assert.match(shellenv.stdout, /case ":\$\{PATH\}:" in \*:"\$\{OBU_INSTALL_DIR\}\/bin":\*\) ;; \*\) export PATH="\$\{OBU_INSTALL_DIR\}\/bin:\$PATH" ;; esac/);

  const mcpConfig = run(obu, ["mcp-config", "--agent=codex-cli", "--print"], { HOME: home });
  const config = JSON.parse(mcpConfig.stdout);
  assert.equal(config.server.command, obu);
  assert.deepEqual(config.server.args, ["mcp", "stdio"]);

  const doctor = run(obu, ["doctor", "--json"], { HOME: home }, { allowFailure: true });
  const doctorJson = JSON.parse(doctor.stdout);
  assert.equal(doctorJson.schemaVersion, 1);
  assert.equal(doctorJson.layout.mode, "packaged");
  const doctorChecks = new Map(doctorJson.checks.map((check) => [check.id, check]));
  for (const id of [
    "payload-metadata",
    "payload-target",
    "payload-node-version",
    "payload-sdk-hash",
    "payload-extension-zip",
    "payload-extension-version",
    "payload-runtime-dependency",
  ]) {
    assert.equal(doctorChecks.get(id)?.status, "pass", `${id} did not pass in curl-installed doctor output`);
  }

  await runMcpListToolsSmoke(obu, home);

  await assert.rejects(() => access(path.join(home, ".profile")), { code: "ENOENT" });

  const envInstallDir = path.join(temp, "env-install");
  const envHome = path.join(temp, "env-home");
  run("sh", [
    installer,
    "--artifact",
    artifactPath,
    "--checksum",
    artifact.sha256,
  ], {
    HOME: envHome,
    OBU_INSTALL_DIR: envInstallDir,
    OBU_UNMANAGED_INSTALL: "1",
  });
  await access(path.join(envInstallDir, "bin", "obu"));
  await assert.rejects(() => access(path.join(envHome, ".profile")), { code: "ENOENT" });

  const envArtifactInstallDir = path.join(temp, "env-artifact-install");
  const envArtifactHome = path.join(temp, "env-artifact-home");
  run("sh", [
    installer,
    "--no-modify-path",
  ], {
    HOME: envArtifactHome,
    OBU_INSTALL_DIR: envArtifactInstallDir,
    OBU_ARTIFACT: artifactPath,
    OBU_ARTIFACT_SHA256: artifact.sha256,
  });
  await access(path.join(envArtifactInstallDir, "bin", "obu"));
  await assert.rejects(() => access(path.join(envArtifactHome, ".profile")), { code: "ENOENT" });

  const shellenvInstallDir = path.join(temp, "shellenv-install");
  const shellenvHome = path.join(temp, "shellenv-home");
  const shellenvBin = path.join(temp, "shellenv-bin");
  await mkdir(shellenvBin, { recursive: true });
  const shellenvPath = `.${path.delimiter}${shellenvBin}${path.delimiter}${process.env.PATH ?? ""}`;
  const shellenvInstall = run("sh", [
    installer,
    "--artifact",
    artifactPath,
    "--checksum",
    artifact.sha256,
    "--install-dir",
    shellenvInstallDir,
  ], {
    HOME: shellenvHome,
    PATH: shellenvPath,
    SHELL: "/bin/zsh",
  });
  assert.match(shellenvInstall.stdout, /Activate in this shell:\s+\. ".*\/env"/);
  await access(path.join(shellenvInstallDir, "env"));
  assert.match(await readFile(path.join(shellenvHome, ".zshrc"), "utf8"), /open-browser-use installer \(managed v1\)/);
  assert.match(await readFile(path.join(shellenvHome, ".zprofile"), "utf8"), /\. ".*\/env"/);
  await assert.rejects(() => access(path.join(shellenvBin, "obu")), { code: "ENOENT" });
  await assert.rejects(() => access(path.join(process.cwd(), "obu")), { code: "ENOENT" });
  const shellenvObu = path.join(shellenvInstallDir, "bin", "obu");
  const shellenvFish = run(shellenvObu, ["shellenv", "fish"], { HOME: shellenvHome });
  assert.match(shellenvFish.stdout, /fish_add_path --global --move --path /);

  const profileOnlyInstallDir = path.join(temp, "profile-only-install");
  const profileOnlyHome = path.join(temp, "profile-only-home");
  const profileOnlyInstall = run("/bin/sh", [
    installer,
    "--artifact",
    artifactPath,
    "--checksum",
    artifact.sha256,
    "--install-dir",
    profileOnlyInstallDir,
  ], {
    HOME: profileOnlyHome,
    PATH: "/usr/bin:/bin",
    SHELL: "",
  });
  assert.match(profileOnlyInstall.stdout, /Activate in this shell:\s+\. ".*\/env"/);
  await access(path.join(profileOnlyInstallDir, "env"));
  assert.match(await readFile(path.join(profileOnlyHome, ".profile"), "utf8"), /open-browser-use installer \(managed v1\)/);
  assert.match(await readFile(path.join(profileOnlyHome, ".profile"), "utf8"), /\. ".*\/env"/);
  await access(path.join(profileOnlyInstallDir, "bin", "obu"));

  const releaseManifestInstallDir = path.join(temp, "release-manifest-install");
  const releaseManifestHome = path.join(temp, "release-manifest-home");
  const releaseManifestInstall = run("sh", [
    installer,
    "--no-modify-path",
    "--verbose",
  ], {
    HOME: releaseManifestHome,
    OBU_INSTALL_DIR: releaseManifestInstallDir,
    OBU_RELEASE_BASE_URL: artifactRoot,
    OBU_TARGET: artifactTarget,
  });
  assert.match(releaseManifestInstall.stdout, new RegExp(`target: ${artifactTarget}`));
  assert.match(releaseManifestInstall.stdout, /manifest: .*manifest\.tsv/);
  assert.match(releaseManifestInstall.stdout, /artifact: .*open-browser-use-.+\.tar\.gz/);
  assert.match(releaseManifestInstall.stdout, /checksum: ok/);
  assert.match(releaseManifestInstall.stdout, /extract: /);
  assert.match(releaseManifestInstall.stdout, /shim: wrote /);
  assert.match(releaseManifestInstall.stdout, /path: skipped \(modify-path disabled\)/);
  await access(path.join(releaseManifestInstallDir, "bin", "obu"));
  await assert.rejects(() => access(path.join(releaseManifestHome, ".profile")), { code: "ENOENT" });

  const jsonFallbackRoot = path.join(temp, "json-fallback-release");
  await mkdir(jsonFallbackRoot, { recursive: true });
  for (const file of [manifest.installer, "manifest.json", artifact.file, `${artifact.file}.sha256`]) {
    await copyFile(path.join(artifactRoot, file), path.join(jsonFallbackRoot, file));
  }
  const jsonFallbackInstallDir = path.join(temp, "json-fallback-install");
  const jsonFallbackHome = path.join(temp, "json-fallback-home");
  run("sh", [
    installer,
    "--no-modify-path",
  ], {
    HOME: jsonFallbackHome,
    OBU_INSTALL_DIR: jsonFallbackInstallDir,
    OBU_RELEASE_BASE_URL: jsonFallbackRoot,
    OBU_TARGET: artifactTarget,
  });
  await access(path.join(jsonFallbackInstallDir, "bin", "obu"));

  const unsupported = run("sh", [
    installer,
    "--no-modify-path",
  ], {
    HOME: path.join(temp, "unsupported-home"),
    OBU_INSTALL_DIR: path.join(temp, "unsupported-install"),
    OBU_RELEASE_BASE_URL: artifactRoot,
    OBU_TARGET: "linux-arm64-musl",
  }, { allowFailure: true });
  assert.equal(unsupported.status, 2);
  assert.match(unsupported.stderr, /no open-browser-use release artifact for target linux-arm64-musl/);

  console.log("curl install smoke passed");
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function readTsvManifest(file) {
  const rows = (await readFile(file, "utf8")).trimEnd().split("\n");
  assert.equal(rows[0], "target\tfile\tsha256\tsize");
  return rows.slice(1).map((row) => {
    const [target, file, sha256, size] = row.split("\t");
    return { target, file, sha256, size: Number(size) };
  });
}

function assertCurlManifest(manifest, tsvManifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.installer, "install.sh");
  assert.equal(manifest.shellManifest, "manifest.tsv");
  assert.equal(Array.isArray(manifest.artifacts), true);
  assert.equal(manifest.artifacts.length, tsvManifest.length);
  const tsvByTarget = new Map(tsvManifest.map((row) => [row.target, row]));
  const targets = new Set();
  for (const artifact of manifest.artifacts) {
    assert.equal(targets.has(artifact.target), false, `duplicate artifact target ${artifact.target}`);
    targets.add(artifact.target);
    assert.equal(artifact.file, path.basename(artifact.file));
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.equal(Number.isSafeInteger(artifact.size), true);
    assert.equal(artifact.size > 0, true);
    assert.deepEqual(tsvByTarget.get(artifact.target), artifact);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function runMcpListToolsSmoke(obu, home) {
  const runtimeDir = path.join(temp, "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(runtimeDir, 0o700);

  const child = spawn(obu, ["mcp", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      OBU_RUNTIME_DIR: runtimeDir,
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout });

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "obu-curl-install-smoke", version: "0.0.0" },
    },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  const init = await readJsonLine(lines);
  assert.equal(init.id, 1);
  const tools = await readJsonLine(lines);
  assert.equal(tools.id, 2);
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    "js",
    "browser_status",
    "agent_runtime_status",
    "js_reset",
    "js_add_module_dir",
  ]);

  child.stdin.end();
  const status = await waitForExit(child);
  assert.equal(status, 0, stderr);
}

function send(child, value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function readJsonLine(lines) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for MCP stdout")), 5000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for MCP process exit"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function parseArgs(argv) {
  const parsed = { target: "current" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--target") {
      parsed.target = readValue();
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function currentTargetTriple() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (process.platform === "linux") {
    const report = typeof process.report?.getReport === "function" ? process.report.getReport() : undefined;
    const libc = typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
    return `${process.platform}-${process.arch}-${libc}`;
  }
  return `${process.platform}-${process.arch}`;
}
