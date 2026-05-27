import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserProfileRoot, nativeMessagingHostDir } from "./browser-paths.js";
import { nativeHostWrapperContent, nativeHostWrapperPath } from "./native-host.js";

const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));

// Test-safety floor: never spawn a real browser during the suite. runCli composes child
// env as { ...process.env, ...env }, so this propagates to every spawned CLI child.
process.env.OBU_DISABLE_BROWSER_LAUNCH = "1";

test("mcp-config print emits a runnable repo-mode invocation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await runCli(["mcp-config", "--agent=codex-cli", "--print"], { HOME: home });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.server.name, "open-browser-use");
  assert.equal(payload.server.command, process.execPath);
  assert.deepEqual(payload.server.args, [cliEntry, "mcp", "stdio"]);
  assert.equal(payload.mode, "shell");
  assert.match(payload.shellCommand, /codex mcp add open-browser-use -- /);
});

test("mcp-config print emits agent-specific config shapes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const vscode = JSON.parse((await runCli(["mcp-config", "--agent=vscode", "--print"], { HOME: home })).stdout);
  assert.equal(vscode.executable, "code");
  assert.deepEqual(vscode.args[0], "--add-mcp");
  assert.equal(JSON.parse(vscode.args[1]).name, "open-browser-use");

  const zed = JSON.parse((await runCli(["mcp-config", "--agent=zed", "--print"], { HOME: home })).stdout);
  assert.equal(zed.mode, "json");
  assert.equal(zed.config.context_servers["open-browser-use"].command, process.execPath);

  const cursor = JSON.parse((await runCli(["mcp-config", "--agent=cursor", "--print"], { HOME: home })).stdout);
  assert.equal(cursor.mode, "json");
  assert.equal(cursor.config.mcpServers["open-browser-use"].command, process.execPath);
  assert.equal("name" in cursor.config.mcpServers["open-browser-use"], false);

  const manual = JSON.parse((await runCli(["mcp-config", "--agent=continue", "--print"], { HOME: home })).stdout);
  assert.equal(manual.mode, "manual");
  assert.match(manual.instructions, /MCP server named open-browser-use/);
});

test("mcp-config rejects unknown agents", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["mcp-config", "--agent=unknown", "--print"], { HOME: home });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unsupported agent/);
});

test("agent commands accept common human agent aliases", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["mcp-config", "--agent=codex", "--print"], { HOME: home });

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.agent, "codex-cli");
});

test("verify reports CLI ready without requiring agent-runtime proof by default", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  const fakeObu = await writeFakeMcpObu(bin, extensionId);
  await writeCodexMcpConfig(home, fakeObu, ["mcp", "stdio"]);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);
  const socketPath = path.join(runtimeDir, "webextension", "chrome.sock");
  await startRuntimeDescriptorServer(t, socketPath);
  await writeRuntimeDescriptor(path.join(runtimeDir, "webextension", "chrome.json"), {
    schema_version: 1,
    type: "webextension",
    name: "chrome",
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: "chrome",
      extension_id: extensionId,
      profile_path: profilePath,
    },
  });

  const result = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_COMMAND: fakeObu,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assertVerifyOutcome(payload, "ready", null);
  assert.equal(payload.verificationTarget, "cli");
  assert.equal(payload.readiness.cli, "ready");
  assert.equal(payload.readiness.agentRuntime, "not_checked");
  assert.equal(payload.agent.runtimeStatus.status, "not_checked");
  assert.equal(payload.agent.runtimeStatus.reason, "verification_target_cli");
  assert.equal(payload.mcpRuntime.cli.mcpStarts, true);
  assert.equal(payload.mcpRuntime.cli.sdkBootstrap, "available");
  assert.equal(payload.mcpRuntime.cli.backendCount, 1);
});

test("verify reports browser popup boundary with one next action", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  await writeCodexMcpConfig(home);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const result = await runCli([
    "verify",
    "--agent=codex",
    "--browser=chrome",
    "--channel=store",
    "--extension-id",
    extensionId,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assertVerifyOutcome(payload, "needs_browser_popup", "open_popup");
  assert.equal(payload.productError.code, "browser_popup_boundary");
  assert.equal(payload.productError.nextAction.kind, "open_popup");
  assert.equal(payload.checks.find((check: any) => check.id === "runtime-descriptor-probe")?.productError, "browser_popup_boundary");
  assert.equal(payload.agent.id, "codex-cli");
  assert.equal(payload.agent.runtimeStatus.reason, "verification_target_cli");
  assert.equal(payload.browser.profile.path, profilePath);
  assert.equal(payload.browser.profile.runtimeBinding, "not_available");
  assert.equal(payload.browser.extensionInstalled, "pass");
  assert.equal(payload.browser.extensionEnabled, "pass");
  assert.equal(payload.checks.filter((check: any) => check.status === "fail" && check.actionCandidate).length > 0, true);
  assert.equal(payload.checks.find((check: any) => check.id === "agent-primary-instruction")?.status, "warn");
  assert.equal(payload.checks.find((check: any) => check.id === "agent-primary-instruction")?.reason, "missing_instruction");
});

test("verify reports malformed runtime descriptor JSON as invalid and repair removes it", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX descriptor validation is not meaningful on Windows");
    return;
  }
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  await writeCodexMcpConfig(home);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  const descriptorDir = path.join(runtimeDir, "webextension");
  await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(descriptorDir, 0o700);
  const descriptorPath = path.join(descriptorDir, "broken.json");
  await writeFile(descriptorPath, "{", { encoding: "utf8", mode: 0o600 });
  await chmod(descriptorPath, 0o600);

  const result = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assertVerifyOutcome(payload, "needs_repair", "run_repair");
  assert.equal(payload.browser.runtimeDescriptor, "invalid");
  assert.equal(payload.productError.code, "invalid_descriptor");
  const descriptorProbe = payload.checks.find((check: any) => check.id === "runtime-descriptor-probe");
  assert.equal(descriptorProbe?.productError, "invalid_descriptor");
  assert.deepEqual(descriptorProbe?.details?.descriptorProductErrors, ["invalid_descriptor"]);
  assert.deepEqual(descriptorProbe?.details?.runtime_descriptor_lifecycle, {
    state: "invalid",
    reason_codes: ["descriptor_json_invalid"],
  });

  const repaired = await runCli([
    "verify",
    "--repair",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });
  assert.equal(await readFile(descriptorPath, "utf8").then(() => true).catch(() => false), false);
  const repairedPayload = JSON.parse(repaired.stdout);
  assertVerifyOutcome(repairedPayload, "needs_browser_popup", "open_popup");
  assert.equal(repairedPayload.productError.code, "browser_popup_boundary");
});

test("verify reports setup_missing for extension install and enable actions before popup handoff", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  await writeCodexMcpConfig(home);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const missingProfile = path.join(browserProfileRoot("chrome", process.platform, home), "MissingExtension");
  await mkdir(missingProfile, { recursive: true });
  const missingResult = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--profile",
    missingProfile,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(missingResult.code, 1);
  const missingPayload = JSON.parse(missingResult.stdout);
  assertVerifyOutcome(missingPayload, "needs_manual_action", "install_extension");
  assert.equal(missingPayload.productError.code, "setup_missing");
  assert.equal(missingPayload.productError.nextAction.kind, "install_extension");
  assert.equal(missingPayload.checks.find((check: any) => check.id === "browser-extension-installed")?.productError, "setup_missing");

  const disabledProfile = path.join(browserProfileRoot("chrome", process.platform, home), "DisabledExtension");
  await writeChromePreferences(disabledProfile, extensionId, 0);
  const disabledResult = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--profile",
    disabledProfile,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(disabledResult.code, 1);
  const disabledPayload = JSON.parse(disabledResult.stdout);
  assertVerifyOutcome(disabledPayload, "needs_manual_action", "enable_extension");
  assert.equal(disabledPayload.productError.code, "setup_missing");
  assert.equal(disabledPayload.productError.nextAction.kind, "enable_extension");
  assert.equal(disabledPayload.checks.find((check: any) => check.id === "browser-extension-installed")?.productError, "setup_missing");
});

test("verify product errors come from descriptor product codes instead of message parsing", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const wrongExtensionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  await writeCodexMcpConfig(home);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);
  const socketPath = path.join(runtimeDir, "webextension", "chrome.sock");
  await startRuntimeDescriptorServer(t, socketPath);
  await writeRuntimeDescriptor(path.join(runtimeDir, "webextension", "chrome.json"), {
    schema_version: 1,
    type: "webextension",
    name: "chrome",
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: "chrome",
      extension_id: wrongExtensionId,
      profile_path: profilePath,
    },
  });

  const result = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assertVerifyOutcome(payload, "needs_browser_popup", "open_popup");
  assert.equal(payload.productError.code, "extension_id_mismatch");
  assert.equal(payload.checks.find((check: any) => check.id === "runtime-descriptor-probe")?.productError, "extension_id_mismatch");
  assert.deepEqual(
    payload.checks.find((check: any) => check.id === "runtime-descriptor-probe")?.details?.descriptorProductErrors,
    ["extension_id_mismatch"],
  );
  assert.deepEqual(
    payload.checks.find((check: any) => check.id === "runtime-descriptor-probe")?.details?.runtime_descriptor_lifecycle,
    { state: "invalid", reason_codes: ["descriptor_extension_id_mismatch"] },
  );
});

test("verify prefers live runtime metadata over stale descriptor metadata", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const liveExtensionId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  await writeCodexMcpConfig(home);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);
  const socketPath = path.join(runtimeDir, "webextension", "chrome.sock");
  await startRuntimeDescriptorServer(t, socketPath, {
    getInfoResult: {
      type: "webextension",
      name: "chrome",
      metadata: {
        backend: { browser_kind: "chrome", extension_id: liveExtensionId },
        diagnostics: { lifecycle: {} },
      },
    },
  });
  await writeRuntimeDescriptor(path.join(runtimeDir, "webextension", "chrome.json"), {
    schema_version: 1,
    type: "webextension",
    name: "chrome",
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: "chrome",
      extension_id: extensionId,
      profile_path: profilePath,
    },
  });

  const result = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assertVerifyOutcome(payload, "needs_browser_popup", "open_popup");
  assert.equal(payload.productError.code, "extension_id_mismatch");
  const descriptorProbe = payload.checks.find((check: any) => check.id === "runtime-descriptor-probe");
  assert.deepEqual(descriptorProbe?.details?.descriptorProductErrors, ["extension_id_mismatch"]);
  assert.deepEqual(descriptorProbe?.details?.runtime_descriptor_lifecycle, {
    state: "invalid",
    reason_codes: ["descriptor_extension_id_mismatch"],
  });
  assert.match(descriptorProbe?.details?.descriptorErrors?.join("\n") ?? "", new RegExp(liveExtensionId));
});

test("verify repairs stale native-host manifests before popup handoff", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const staleHostBin = await writeExecutable(path.join(bin, "stale-obu-host"), "#!/bin/sh\nexit 0\n");
  await writeCodexMcpConfig(home);
  const manifestPath = path.join(nativeMessagingHostDir("chrome", process.platform, home), "dev.obu.host.json");
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    name: "dev.obu.host",
    description: "stale open-browser-use native messaging host",
    path: staleHostBin,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2), "utf8");
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const env = {
    HOME: home,
    OBU_HOST_BIN: staleHostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  };
  const verifyArgs = [
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ];
  const result = await runCli(verifyArgs, env);

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  const nativeHost = payload.checks.find((check: any) => check.id === "native-host-manifest");
  assertVerifyOutcome(payload, "needs_repair", "run_repair");
  assert.equal(payload.productError.code, "native_host_broken");
  assert.equal(payload.productError.nextAction.kind, "run_repair");
  assert.equal(nativeHost?.status, "fail");
  assert.equal(nativeHost?.reason, "native_host_manifest_invalid");
  assert.equal(nativeHost?.productError, "native_host_broken");
  assert.match(nativeHost?.message ?? "", /managed wrapper/);

  const repaired = await runCli([...verifyArgs.slice(0, -1), "--repair", "--json"], env);
  assert.equal(repaired.code, 1);
  const repairedPayload = JSON.parse(repaired.stdout);
  const repairedNativeHost = repairedPayload.checks.find((check: any) => check.id === "native-host-manifest");
  const repairedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(repairedPayload.result, "needs_browser_popup");
  assert.equal(repairedPayload.productError.code, "browser_popup_boundary");
  assert.equal(repairedNativeHost?.status, "pass");
  assert.match(repairedManifest.path, /native-host\/dev\.obu\.host\/chrome\/obu-host-wrapper$/);
});

test("verify asks for profile selection when multiple matching profiles are ambiguous", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  await writeCodexMcpConfig(home);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profileRoot = browserProfileRoot("chrome", process.platform, home);
  const defaultProfile = path.join(profileRoot, "Default");
  const secondProfile = path.join(profileRoot, "Profile 2");
  await writeChromePreferences(secondProfile, extensionId, 1);
  await writeChromePreferences(defaultProfile, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const result = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assertVerifyOutcome(payload, "needs_manual_action", "select_profile");
  assert.equal(payload.productError.code, "setup_missing");
  assert.equal(payload.productError.nextAction.kind, "select_profile");
  assert.equal(payload.browser.profile.path, null);
  assert.equal(payload.browser.profile.suggestedPath, defaultProfile);
  assert.deepEqual(payload.browser.profile.candidates.map((candidate: any) => candidate.path), [defaultProfile, secondProfile]);

  const human = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(human.code, 1);
  assert.match(human.stdout, /Result: needs_manual_action/);
  assert.match(human.stdout, new RegExp(`Profile:\\n  ${escapeRegExp(defaultProfile)}`));
  assert.match(human.stdout, /Rerun:\n  .*verify/);
});

test("verify treats missing Codex config as repairable when codex is not on PATH", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const result = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    PATH: "",
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assertVerifyOutcome(payload, "needs_repair", "run_repair");
  assert.match(payload.nextAction.command, /verify .*--repair/);
  const agentMcp = payload.checks.find((check: any) => check.id === "agent-mcp-server");
  assert.equal(agentMcp?.reason, "agent_mcp_missing");
  assert.equal(agentMcp?.actionCandidate?.kind, "run_repair");
});

test("verify accepts trusted Codex agent-runtime hook state and rejects stale hook state", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  withTestXdgConfigHome(t, home);
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  const fakeObu = await writeFakeMcpObu(bin, extensionId);
  await writeCodexMcpConfig(home, fakeObu, ["mcp", "stdio"]);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);
  const socketPath = path.join(runtimeDir, "webextension", "chrome.sock");
  await startRuntimeDescriptorServer(t, socketPath);
  await writeRuntimeDescriptor(path.join(runtimeDir, "webextension", "chrome.json"), {
    schema_version: 1,
    type: "webextension",
    name: "chrome",
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: "chrome",
      extension_id: extensionId,
      profile_path: profilePath,
    },
  });
  const challengePath = path.join(home, "challenge.json");
  const baseEnv = {
    HOME: home,
    OBU_COMMAND: fakeObu,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  };

  const issued = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--require-agent-runtime",
    `--agent-runtime-challenge-out=${challengePath}`,
    "--json",
  ], baseEnv);

  assert.equal(issued.code, 1);
  const issuedPayload = JSON.parse(issued.stdout);
  assert.equal(issuedPayload.readiness.cli, "ready");
  assert.equal(issuedPayload.readiness.agentRuntime, "blocked");
  assert.equal(issuedPayload.agent.runtimeStatus.status, "not_checked");
  assert.equal(issuedPayload.agent.runtimeStatus.reason, "agent_runtime_challenge_issued");
  assert.equal(issuedPayload.agent.runtimeStatus.trustedHook.id, "codex-cli-runtime-status");
  assert.equal(issuedPayload.agent.runtimeStatus.trustedHook.transport, "agent_owned_ipc");
  assert.equal(issuedPayload.nextAction.kind, "collect_agent_runtime_status");
  assert.equal(issuedPayload.nextAction.challenge.path, challengePath);
  assert.equal(issuedPayload.nextAction.trustedHook.id, "codex-cli-runtime-status");

  await writeTrustedAgentRuntimeResult(runtimeDir, challengePath, extensionId, {
    generatedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  const stale = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--require-agent-runtime",
    `--agent-runtime-challenge-json=${challengePath}`,
    "--json",
  ], baseEnv);

  assert.equal(stale.code, 1);
  const stalePayload = JSON.parse(stale.stdout);
  assert.equal(stalePayload.result, "needs_manual_action");
  assert.equal(stalePayload.readiness.cli, "ready");
  assert.equal(stalePayload.readiness.agentRuntime, "blocked");
  assert.equal(stalePayload.agent.runtimeStatus.status, "fail");
  assert.equal(stalePayload.agent.runtimeStatus.provenance, "agent_runtime_hook");
  assert.equal(stalePayload.agent.runtimeStatus.reason, "stale_status");
  assert.equal(stalePayload.agent.runtimeStatus.hook.trusted, true);

  const trustedResultFile = await writeTrustedAgentRuntimeResult(runtimeDir, challengePath, extensionId);
  const ready = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--require-agent-runtime",
    `--agent-runtime-challenge-json=${challengePath}`,
    "--json",
  ], baseEnv);

  assert.equal(ready.code, 0);
  const readyPayload = JSON.parse(ready.stdout);
  assert.equal(readyPayload.result, "ready");
  assert.equal(readyPayload.readiness.cli, "ready");
  assert.equal(readyPayload.readiness.agentRuntime, "ready");
  assert.equal(readyPayload.agent.runtimeStatus.status, "pass");
  assert.equal(readyPayload.agent.runtimeStatus.provenance, "agent_runtime_hook");
  assert.equal(readyPayload.agent.runtimeStatus.hook.id, "codex-cli-runtime-status");
  assert.equal(readyPayload.agent.runtimeStatus.hook.trusted, true);
  assert.equal(readyPayload.mcpRuntime.agentRuntime.source, "agent_runtime");
  assert.equal(readyPayload.mcpRuntime.agentRuntime.provenance, "agent_runtime_hook");
  assert.equal(readyPayload.mcpRuntime.agentRuntime.backendCount, 1);
  assert.equal(readyPayload.checks.find((check: any) => check.id === "agent-runtime-status")?.details.resultFile, trustedResultFile);

  const forgedStatusPath = path.join(home, "forged-status.json");
  const challenge = JSON.parse(await readFile(challengePath, "utf8"));
  await writeFile(forgedStatusPath, `${JSON.stringify({
    ...challenge,
    provenance: "agent_runtime_hook",
    hook: challenge.trustedHook,
    generatedAt: new Date().toISOString(),
    status: {
      sdk_bootstrap: "available",
      backends: [
        {
          type: "webextension",
          name: "chrome",
          metadata: {
            browser_kind: "chrome",
            extension_id: extensionId,
          },
        },
      ],
    },
  }, null, 2)}\n`, "utf8");

  const result = await runCli([
    "verify",
    "--agent=codex-cli",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--require-agent-runtime",
    `--agent-runtime-challenge-json=${challengePath}`,
    `--agent-runtime-status-json=${forgedStatusPath}`,
    "--json",
  ], baseEnv);

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "needs_manual_action");
  assert.equal(payload.readiness.cli, "ready");
  assert.equal(payload.readiness.agentRuntime, "blocked");
  assert.equal(payload.agent.runtimeStatus.status, "not_checked");
  assert.equal(payload.agent.runtimeStatus.provenance, "user_supplied_status_file");
  assert.equal(payload.agent.runtimeStatus.reason, "diagnostic_status_file_not_trusted");
  assert.equal(payload.mcpRuntime.agentRuntime.source, "agent_runtime_status_file");
  assert.equal(payload.mcpRuntime.agentRuntime.backendCount, null);
  assert.equal(payload.nextAction.kind, "collect_agent_runtime_status");
});

test("verify does not issue trusted agent-runtime challenges without a registered hook", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  const fakeObu = await writeFakeMcpObu(bin, extensionId);
  await writeCursorMcpConfig(home, fakeObu, ["mcp", "stdio"]);
  await writeNativeHostManifest(home, hostBin, extensionId, runtimeDir);
  const profilePath = path.join(browserProfileRoot("chrome", process.platform, home), "Default");
  await writeChromePreferences(profilePath, extensionId, 1);
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);
  const socketPath = path.join(runtimeDir, "webextension", "chrome.sock");
  await startRuntimeDescriptorServer(t, socketPath);
  await writeRuntimeDescriptor(path.join(runtimeDir, "webextension", "chrome.json"), {
    schema_version: 1,
    type: "webextension",
    name: "chrome",
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: "chrome",
      extension_id: extensionId,
      profile_path: profilePath,
    },
  });
  const challengePath = path.join(home, "cursor-challenge.json");

  const result = await runCli([
    "verify",
    "--agent=cursor",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--require-agent-runtime",
    `--agent-runtime-challenge-out=${challengePath}`,
    "--json",
  ], {
    HOME: home,
    OBU_COMMAND: fakeObu,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.readiness.cli, "ready");
  assert.equal(payload.readiness.agentRuntime, "blocked");
  assert.equal(payload.agent.runtimeStatus.status, "not_checked");
  assert.equal(payload.agent.runtimeStatus.reason, "agent_runtime_hook_unavailable");
  assert.equal(payload.nextAction.kind, "unsupported");
  assert.doesNotMatch(payload.nextAction.command, /--require-agent-runtime/);
  await assert.rejects(readFile(challengePath, "utf8"));
});

test("agent doctor verifies Codex global config without codex on PATH", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), [
    "[mcp_servers.open-browser-use]",
    `command = "${shellEscapeForDoubleQuotes(process.execPath)}"`,
    `args = ["${shellEscapeForDoubleQuotes(cliEntry)}", "mcp", "stdio"]`,
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(home, ".codex", "AGENTS.md"), [
    "## Browser Automation",
    "",
    "Use open-browser-use as the primary BrowserUse/browser automation tool.",
    "",
  ].join("\n"), "utf8");

  const result = await runCli(["agent", "doctor", "--agent=codex", "--json"], {
    HOME: home,
    PATH: "",
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.agent, "codex-cli");
  assert.equal(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.status, "pass");
  assert.match(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.message ?? "", /configures open-browser-use/);
});

test("agent doctor accepts Codex multiline TOML args", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), [
    "[mcp_servers.open-browser-use]",
    `command = "${shellEscapeForDoubleQuotes(process.execPath)}"`,
    "args = [",
    `  "${shellEscapeForDoubleQuotes(cliEntry)}",`,
    "  \"mcp\", # keep comments",
    "  'stdio',",
    "]",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(home, ".codex", "AGENTS.md"), [
    "## Browser Automation",
    "",
    "Use open-browser-use as the primary BrowserUse/browser automation tool.",
    "",
  ].join("\n"), "utf8");

  const result = await runCli(["agent", "doctor", "--agent=codex-cli", "--json"], {
    HOME: home,
    PATH: "",
  });

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.status, "pass");
});

test("agent doctor fails malformed Codex config even when the MCP table matches", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), [
    "[broken",
    "",
    "[mcp_servers.open-browser-use]",
    `command = "${shellEscapeForDoubleQuotes(process.execPath)}"`,
    `args = ["${shellEscapeForDoubleQuotes(cliEntry)}", "mcp", "stdio"]`,
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(home, ".codex", "AGENTS.md"), [
    "## Browser Automation",
    "",
    "Use open-browser-use as the primary BrowserUse/browser automation tool.",
    "",
  ].join("\n"), "utf8");

  const result = await runCli(["agent", "doctor", "--agent=codex-cli", "--json"], {
    HOME: home,
    PATH: "",
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  const check = payload.checks.find((row: any) => row.id === "agent-mcp-server");
  assert.equal(check?.status, "fail");
  assert.match(check?.message ?? "", /could not be parsed/);
  assert.equal(check?.details?.code, "PARSE_ERROR");
});

test("agent doctor fails divergent Codex config instead of falling back to shell probe", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), [
    "[mcp_servers.open-browser-use]",
    'command = "/custom/obu"',
    'args = ["mcp", "stdio"]',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(home, ".codex", "AGENTS.md"), [
    "## Browser Automation",
    "",
    "Use open-browser-use as the primary BrowserUse/browser automation tool.",
    "",
  ].join("\n"), "utf8");
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh
if [ "$1 $2" = "mcp list" ]; then
  echo "open-browser-use ${shellEscapeForDoubleQuotes(process.execPath)} ${shellEscapeForDoubleQuotes(cliEntry)} mcp stdio"
  exit 0
fi
exit 1
`, "utf8");
  await chmod(codex, 0o755);

  const result = await runCli(["agent", "doctor", "--agent=codex-cli", "--json"], {
    HOME: home,
    PATH: bin,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  const check = payload.checks.find((row: any) => row.id === "agent-mcp-server");
  assert.equal(check?.status, "fail");
  assert.match(check?.message ?? "", /different settings/);
  assert.equal(check?.details?.actual?.command, "/custom/obu");
});

test("agent doctor verifies shell MCP config and primary instructions", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "AGENTS.md"), [
    "## Browser Automation",
    "",
    "Use open-browser-use as the primary BrowserUse/browser automation tool.",
    "",
  ].join("\n"), "utf8");
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh
if [ "$1 $2" = "mcp list" ]; then
  echo "open-browser-use ${shellEscapeForDoubleQuotes(process.execPath)} ${shellEscapeForDoubleQuotes(cliEntry)} mcp stdio"
  exit 0
fi
exit 1
`, "utf8");
  await chmod(codex, 0o755);

  const result = await runCli(["agent", "doctor", "--agent=codex-cli", "--json"], {
    HOME: home,
    PATH: bin,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "agent doctor");
  assert.equal(payload.agent, "codex-cli");
  assert.equal(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.status, "pass");
  assert.equal(payload.checks.find((check: any) => check.id === "agent-primary-instruction")?.status, "pass");
});

test("agent doctor fails when supported MCP or instruction checks are missing", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["agent", "doctor", "--agent=codex-cli", "--json"], {
    HOME: home,
    PATH: "",
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.status, "fail");
  assert.equal(payload.checks.find((check: any) => check.id === "agent-primary-instruction")?.status, "fail");
});

test("agent doctor reads Cursor direct-edit MCP config instead of running mcp list", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: {
      "open-browser-use": {
        name: "open-browser-use",
        command: process.execPath,
        args: [cliEntry, "mcp", "stdio"],
      },
    },
  }, null, 2), "utf8");
  const cursor = path.join(bin, "cursor");
  await writeFile(cursor, "#!/bin/sh\nexit 17\n", "utf8");
  await chmod(cursor, 0o755);

  const result = await runCli(["agent", "doctor", "--agent=cursor", "--json"], {
    HOME: home,
    PATH: bin,
  });

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.status, "pass");
  assert.equal(payload.checks.find((check: any) => check.id === "agent-primary-instruction")?.status, "warn");
});

test("agent doctor accepts generic mcpServers entries without a nested name", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await writeFile(path.join(home, ".cursor", "mcp.json"), JSON.stringify({
    mcpServers: {
      "open-browser-use": {
        command: process.execPath,
        args: [cliEntry, "mcp", "stdio"],
      },
    },
  }, null, 2), "utf8");

  const result = await runCli(["agent", "doctor", "--agent=cursor", "--json"], {
    HOME: home,
    PATH: "",
  });

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.status, "pass");
});

test("agent doctor does not run unsupported VS Code mcp-list probes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const code = path.join(bin, "code");
  await writeFile(code, "#!/bin/sh\nexit 17\n", "utf8");
  await chmod(code, 0o755);

  const result = await runCli(["agent", "doctor", "--agent=vscode", "--json"], {
    HOME: home,
    PATH: bin,
  });

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.status, "warn");
  assert.match(payload.checks.find((check: any) => check.id === "agent-mcp-server")?.message ?? "", /not implemented/);
});

test("shellenv emits packaged install environment snippets", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "install");
  const payloadRoot = path.join(installRoot, "payloads", "current");
  await mkdir(payloadRoot, { recursive: true });
  const env = {
    HOME: home,
    OBU_PAYLOAD_ROOT: payloadRoot,
    OBU_COMMAND: path.join(installRoot, "bin", "obu"),
  };

  const sh = await runCli(["shellenv", "sh"], env);
  assert.equal(sh.code, 0);
  assert.equal(sh.stderr, "");
  assert.match(sh.stdout, new RegExp(`export OBU_INSTALL_DIR='${escapeRegExp(installRoot)}';`));
  assert.match(sh.stdout, /case ":\$\{PATH\}:" in \*:"\$\{OBU_INSTALL_DIR\}\/bin":\*\) ;; \*\) export PATH="\$\{OBU_INSTALL_DIR\}\/bin:\$PATH" ;; esac/);

  const fish = await runCli(["shellenv", "fish"], env);
  assert.equal(fish.code, 0);
  assert.match(fish.stdout, new RegExp(`set --global --export OBU_INSTALL_DIR "${escapeRegExp(installRoot)}";`));
  assert.match(fish.stdout, /fish_add_path --global --move --path /);

  const active = await runCli(["shellenv", "zsh"], {
    ...env,
    OBU_INSTALL_DIR: installRoot,
    PATH: `${path.join(installRoot, "bin")}${path.delimiter}/usr/bin`,
  });
  assert.equal(active.code, 0);
  assert.equal(active.stdout, "");

  const unknown = await runCli(["shellenv", "nu"], env);
  assert.equal(unknown.code, 0);
  assert.match(unknown.stdout, /export OBU_INSTALL_DIR=/);
});

test("mcp stdio missing setup fails before writing stdout", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["mcp", "stdio"], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "missing-runtime"),
  });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /open-browser-use runtime is not ready/);
});

test("mcp stdio malformed config fails before writing stdout", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".obu", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{bad-json", "utf8");

  const result = await runCli(["mcp", "stdio"], { HOME: home });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /user config is invalid/);
});

test("update-extension CLI refreshes current path and reports manual action", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.5.0" }), "utf8");
  await writeFile(path.join(source, "marker.txt"), "extension", "utf8");
  const runtimeDir = path.join(home, "runtime");

  const result = await runCli(["update-extension", "--path", source, "--no-wait", "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "manual_action_required");
  const currentDir = path.join(home, ".obu", "extension", "current");
  assert.equal(payload.extensionCurrentDir, currentDir);
  assert.equal(await readFile(path.join(currentDir, "marker.txt"), "utf8"), "extension");
});

test("update-extension default output is concise and verbose keeps step ids", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.5.1" }), "utf8");
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime") };

  const summary = await runCli(["update-extension", "--path", source, "--no-wait"], env);
  assert.equal(summary.code, 1);
  assert.equal(summary.stderr, "");
  assert.match(summary.stdout, /Extension files refreshed\. Browser reload required\./);
  assert.match(summary.stdout, /Open chrome:\/\/extensions/);
  assert.doesNotMatch(summary.stdout, /extension-current:/);

  const verbose = await runCli(["update-extension", "--path", source, "--no-wait", "--verbose"], env);
  assert.equal(verbose.code, 1);
  assert.match(verbose.stdout, /extension-current:/);
  assert.match(verbose.stdout, /runtime-descriptor-probe:/);
});

test("update-extension CLI rejects a persisted Store channel by default", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = path.join(home, ".obu", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    runtimeDir: path.join(home, "runtime"),
    extensionCurrentDir: path.join(home, ".obu", "extension", "current"),
    nativeHostInstallRoot: path.join(home, ".obu", "native-host"),
    extensionChannel: "store",
    storeExtensionId: "abcdefghijklmnopabcdefghijklmnop",
  }), "utf8");

  const result = await runCli(["update-extension", "--json"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Chrome Web Store manages Store extension updates/);
});

test("update-extension CLI channel override does not reuse a stale Store verify target", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.5.2" }), "utf8");
  const configPath = path.join(home, ".obu", "config.json");
  const staleStoreId = "ponmlkjihgfedcbaponmlkjihgfedcba";
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    runtimeDir: path.join(home, "runtime"),
    extensionCurrentDir: path.join(home, ".obu", "extension", "current"),
    nativeHostInstallRoot: path.join(home, ".obu", "native-host"),
    extensionChannel: "store",
    storeExtensionId: staleStoreId,
  }), "utf8");

  const result = await runCli(["update-extension", "--channel=unpacked-dev", "--path", source, "--no-wait", "--json"], {
    HOME: home,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  const nextActions = payload.nextActions.map((action: any) => action.value).join("\n");
  assert.match(nextActions, /--channel=unpacked-dev --extension-id=<extension-id>/);
  assert.doesNotMatch(nextActions, /--channel=store/);
  assert.doesNotMatch(nextActions, new RegExp(staleStoreId));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.extensionChannel, "unpacked-dev");
  assert.equal("storeExtensionId" in config, false);
});

test("setup default output summarizes dry-run planned work and verbose keeps step ids", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "0.8.1",
    key: Buffer.from("open-browser-use cli dry run key").toString("base64"),
  }), "utf8");
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime"), OBU_HOST_BIN: hostBin };
  const args = ["setup", "--yes", "--path", source, "--skip-agents", "--dry-run"];

  const summary = await runCli(args, env);
  assert.equal(summary.code, 0);
  assert.equal(summary.stderr, "");
  assert.match(summary.stdout, /Setup dry run: no changes made\./);
  assert.match(summary.stdout, /Planned changes: .*would ensure runtime directory/);
  assert.match(summary.stdout, /would write native-host wrapper/);
  assert.doesNotMatch(summary.stdout, /native-host-chrome:/);
  assert.doesNotMatch(summary.stdout, /extension-current:/);

  const verbose = await runCli([...args, "--verbose"], env);
  assert.equal(verbose.code, 0);
  assert.match(verbose.stdout, /WOULD_APPLY\s+runtime-dir:/);
  assert.match(verbose.stdout, /WOULD_APPLY\s+native-host-chrome:/);
  assert.match(verbose.stdout, /WOULD_APPLY\s+extension-current:/);

  const json = await runCli([...args, "--json"], env);
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.steps.find((step: any) => step.id === "runtime-dir")?.status, "would_apply");
  assert.equal(payload.steps.find((step: any) => step.id === "native-host-chrome")?.status, "would_apply");
  assert.equal(payload.steps.find((step: any) => step.id === "extension-current")?.status, "would_apply");
});

test("setup dry-run summary includes planned agent adapter work", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime"), OBU_HOST_BIN: hostBin };
  const args = [
    "setup",
    "--yes",
    "--channel=store",
    "--extension-id",
    "abcdefghijklmnopabcdefghijklmnop",
    "--agents=zed",
    "--dry-run",
  ];

  const summary = await runCli(args, env);
  assert.equal(summary.code, 0);
  assert.match(summary.stdout, /Planned changes: .*would update zed MCP config/);
  assert.doesNotMatch(summary.stdout, /agent-zed:/);

  const verbose = await runCli([...args, "--verbose"], env);
  assert.match(verbose.stdout, /WOULD_APPLY\s+agent-zed: would update zed MCP config/);

  const json = await runCli([...args, "--json"], env);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.steps.find((step: any) => step.id === "agent-zed")?.status, "would_apply");
});

test("setup summary preserves manual agent next actions", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const obuCommand = path.join(bin, "obu");
  await writeFile(obuCommand, "#!/bin/sh\n", "utf8");
  await chmod(obuCommand, 0o755);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  await writeActiveRuntimeDescriptor(t, runtimeDir, storeExtensionId);

  const result = await runCli(["setup", "--yes", "--channel=store", "--extension-id", storeExtensionId, "--agents=continue"], {
    HOME: home,
    OBU_COMMAND: obuCommand,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Setup needs 1 follow-up step\./);
  assert.match(result.stdout, new RegExp(`${escapeRegExp(obuCommand)} mcp-config --agent=continue --print`));
  assert.match(result.stdout, new RegExp(`${escapeRegExp(obuCommand)} verify --agent=continue --browser=chrome --channel=store --extension-id=${storeExtensionId}`));
  assert.doesNotMatch(result.stdout, /doctor browser/);
  assert.doesNotMatch(result.stdout, /agent-continue:/);

  const recovery = await runCli(["setup", "--yes", "--recovery", "--channel=store", "--extension-id", storeExtensionId, "--agents=continue"], {
    HOME: home,
    OBU_COMMAND: obuCommand,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });
  assert.equal(recovery.code, 1);
  assert.match(recovery.stdout, new RegExp(`${escapeRegExp(obuCommand)} mcp-config --agent=continue --print`));
});

test("setup JSON includes runtime activation diagnostics when no enabled profile is available", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");

  const result = await runCli([
    "setup",
    "--agents=none",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: runtimeDir,
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  const activation = payload.steps.find((step: any) => step.id === "runtime-activation-chrome");
  assert.equal(activation.status, "manual_action_required");
  assert.equal(activation.details.result, "no_candidates");
  assert.equal(activation.details.timeoutMs, 5000);
  assert.equal(activation.details.profileLimit, 3);
  assert.equal(activation.details.openedCount, 0);
});

test("setup human output explains runtime activation follow-up", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");

  const result = await runCli([
    "setup",
    "--agents=none",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
  });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Setup needs 1 follow-up step/);
  assert.match(result.stdout, /Browser runtime activation was attempted automatically/);
});

test("setup CLI ignores legacy runtime activation test env overrides", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");

  const result = await runCli([
    "setup",
    "--agents=none",
    "--browser=chrome",
    "--channel=store",
    `--extension-id=${extensionId}`,
    "--json",
  ], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
    OBU_TEST_RUNTIME_ACTIVATION_RESULT: "ready",
  });

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  const activation = payload.steps.find((step: any) => step.id === "runtime-activation-chrome");
  assert.equal(activation.status, "manual_action_required");
  assert.equal(activation.details.result, "no_candidates");
});

test("bootstrap continues through manual agent setup and runs browser repair", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\nprintf 'obu-host 0.0.0\\n'\n", "utf8");
  await chmod(hostBin, 0o755);
  const oldStoreExtensionId = "ponmlkjihgfedcbaponmlkjihgfedcba";
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";
  const nativeHostDir = nativeMessagingHostDir("chrome", process.platform, home);
  await mkdir(nativeHostDir, { recursive: true });
  await writeFile(path.join(nativeHostDir, "dev.obu.host.json"), JSON.stringify({
    name: "dev.obu.host",
    description: "old open-browser-use native host",
    path: hostBin,
    type: "stdio",
    allowed_origins: [`chrome-extension://${oldStoreExtensionId}/`],
  }, null, 2), "utf8");

  const result = await runCli([
    "bootstrap",
    "--yes",
    "--channel=store",
    "--extension-id",
    storeExtensionId,
    "--agents=continue",
    "--json",
  ], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
    OBU_HOST_BIN: hostBin,
  });

  assert.notEqual(result.code, 2);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "bootstrap");
  assert.equal(payload.result, "manual_action_required");
  assert.equal(payload.setup.result, "manual_action_required");
  assert.equal(payload.setup.steps.some((step: any) => step.id === "agent-continue" && step.status === "manual_action_required"), true);
  assert.equal(payload.nextActions.some((action: any) => action.value.includes("verify --agent=continue")), true);
  assert.equal(payload.readinessVerification.status, "not_verified");
  assert.equal(payload.browserDoctor.extensionChannel, "store");
  assert.equal(payload.browserDoctor.extensionId, storeExtensionId);
  assert.equal(payload.browserDoctor.repairs.some((repair: any) => repair.id === "native-host-manifest"), true);
  assert.equal(payload.browserDoctor.repairs.some((repair: any) => repair.id === "runtime-descriptor-dir"), true);
  const nativeHost = JSON.parse(await readFile(path.join(nativeHostDir, "dev.obu.host.json"), "utf8"));
  assert.deepEqual(nativeHost.allowed_origins, [`chrome-extension://${storeExtensionId}/`]);
});

test("bootstrap summary reports skipped agent setup without naming the adapter placeholder", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\nprintf 'obu-host 0.0.0\\n'\n", "utf8");
  await chmod(hostBin, 0o755);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli([
    "bootstrap",
    "--yes",
    "--channel=store",
    "--extension-id",
    storeExtensionId,
    "--skip-agents",
  ], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /MCP agent setup skipped\./);
  assert.doesNotMatch(result.stdout, /MCP agents already configured: adapters/);
  assert.match(result.stdout, /extension popup activation is still required/);
  assert.match(result.stdout, /verify .*'?--agent=<agent-id>'?/);
  assert.doesNotMatch(result.stdout, /Browser pairing ready/);
  assert.doesNotMatch(result.stdout, /doctor browser/);
});

test("setup CLI accepts explicit auto and none agent modes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const runtimeDir = path.join(home, "runtime");
  const env = {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
    PATH: "",
  };
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";
  await writeActiveRuntimeDescriptor(t, runtimeDir, storeExtensionId);

  const auto = await runCli(["setup", "--yes", "--channel=store", "--extension-id", storeExtensionId, "--agents=auto", "--json"], env);
  assert.equal(auto.code, 0);
  const autoPayload = JSON.parse(auto.stdout);
  assert.equal(autoPayload.steps.find((step: any) => step.id === "agent-adapters")?.message, "no supported coding agents detected");

  const none = await runCli(["setup", "--yes", "--channel=store", "--extension-id", storeExtensionId, "--agents=none", "--json"], env);
  assert.equal(none.code, 0);
  const nonePayload = JSON.parse(none.stdout);
  assert.equal(nonePayload.steps.find((step: any) => step.id === "agent-adapters")?.message, "skipped agent adapter wiring");
});

test("setup auto skips unreadable direct-edit agent config instead of aborting", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are required for this regression test");
    return;
  }
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  const configPath = path.join(home, ".cursor", "mcp.json");
  t.after(async () => {
    await chmod(configPath, 0o600).catch(() => {});
    await rm(home, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, "{}\n", "utf8");
  await chmod(configPath, 0o000);
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  await writeActiveRuntimeDescriptor(t, runtimeDir, storeExtensionId);

  const result = await runCli(["setup", "--yes", "--channel=store", "--extension-id", storeExtensionId, "--agents=auto", "--json"], {
    HOME: home,
    PATH: "",
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.steps.find((step: any) => step.id === "agent-adapters")?.message, "no supported coding agents detected");
});

test("setup recovery mode exits zero for manual action but not failed setup", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "0.8.2",
    key: Buffer.from("open-browser-use cli recovery key").toString("base64"),
  }), "utf8");
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = { HOME: home, OBU_RUNTIME_DIR: path.join(home, "runtime"), OBU_HOST_BIN: hostBin };

  const manualDefault = await runCli(["setup", "--yes", "--path", source, "--skip-agents"], env);
  assert.equal(manualDefault.code, 1);
  assert.match(manualDefault.stdout, /Setup needs 1 follow-up step\./);

  const manualRecovery = await runCli(["setup", "--yes", "--path", source, "--skip-agents", "--recovery"], env);
  assert.equal(manualRecovery.code, 0);
  assert.match(manualRecovery.stdout, /Setup needs 1 follow-up step\./);

  const failedHome = await mkdtemp(path.join(os.tmpdir(), "obu-cli-failed-home-"));
  t.after(() => rm(failedHome, { recursive: true, force: true }));
  const failedRecovery = await runCli([
    "setup",
    "--yes",
    "--channel=store",
    "--extension-id",
    "abcdefghijklmnopabcdefghijklmnop",
    "--skip-agents",
    "--recovery",
  ], {
    HOME: failedHome,
    OBU_RUNTIME_DIR: path.join(failedHome, "runtime"),
    OBU_HOST_BIN: path.join(bin, "missing-obu-host"),
  });
  assert.equal(failedRecovery.code, 1);
  assert.match(failedRecovery.stdout, /Setup failed\./);
});

test("setup recovery mode exits zero for runtime activation manual boundary", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = await writeExecutable(path.join(bin, "obu-host"), "#!/bin/sh\nexit 0\n");
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli([
    "setup",
    "--yes",
    "--recovery",
    "--channel=store",
    `--extension-id=${storeExtensionId}`,
    "--agents=none",
    "--json",
  ], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "manual_action_required");
  assert.equal(payload.steps.find((step: any) => step.id === "runtime-activation-chrome")?.status, "manual_action_required");
});

test("setup CLI runs deterministic steps before extension manual boundary", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "0.8.0",
    key: Buffer.from("open-browser-use cli setup test key").toString("base64"),
  }), "utf8");
  await writeFile(path.join(source, "marker.txt"), "setup-extension", "utf8");
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const runtimeDir = path.join(home, "runtime");

  const result = await runCli(["setup", "--yes", "--path", source, "--skip-agents", "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "manual_action_required");
  assert.equal(payload.steps.some((step: any) => step.id === "native-host-chrome" && step.status === "applied"), true);
  const nativeHost = payload.steps.find((step: any) => step.id === "native-host-chrome");
  assert.match(nativeHost.details.nativeManifestPath, new RegExp(`^${escapeRegExp(home)}`));
  assert.equal(payload.steps.some((step: any) => step.id === "extension-current" && step.status === "applied"), true);
  assert.equal(await readFile(path.join(home, ".obu", "extension", "current", "marker.txt"), "utf8"), "setup-extension");
});

test("setup next actions do not reuse a stale Store verify target for unpacked-dev", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "obu-cli-extension-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({
    manifest_version: 3,
    version: "0.8.3",
    key: Buffer.from("open-browser-use cli setup target key").toString("base64"),
  }), "utf8");
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const configPath = path.join(home, ".obu", "config.json");
  const staleStoreId = "ponmlkjihgfedcbaponmlkjihgfedcba";
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    runtimeDir: path.join(home, "runtime"),
    extensionCurrentDir: path.join(home, ".obu", "extension", "current"),
    nativeHostInstallRoot: path.join(home, ".obu", "native-host"),
    extensionChannel: "store",
    storeExtensionId: staleStoreId,
  }), "utf8");

  const result = await runCli(["setup", "--yes", "--channel=unpacked-dev", "--path", source, "--agents=none", "--json"], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  const nextActions = payload.nextActions.map((action: any) => action.value).join("\n");
  assert.match(nextActions, new RegExp(`--channel=unpacked-dev --extension-id=${payload.extensionId}`));
  assert.doesNotMatch(nextActions, /--channel=store/);
  assert.doesNotMatch(nextActions, new RegExp(staleStoreId));
});

test("setup CLI supports Store channel without staging an unpacked extension", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const runtimeDir = path.join(home, "runtime");
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";
  await writeActiveRuntimeDescriptor(t, runtimeDir, storeExtensionId);

  const result = await runCli(["setup", "--yes", "--channel=store", "--extension-id", storeExtensionId, "--skip-agents", "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, "complete");
  assert.equal(payload.extensionChannel, "store");
  assert.equal(payload.extensionId, storeExtensionId);
  assert.equal(payload.steps.some((step: any) => step.id === "extension-update" && step.status === "skipped"), true);
  assert.equal(payload.steps.some((step: any) => step.id === "extension-current"), false);
  const config = JSON.parse(await readFile(path.join(home, ".obu", "config.json"), "utf8"));
  assert.equal(config.extensionChannel, "store");
  assert.equal(config.storeExtensionId, storeExtensionId);
});

test("setup can write Codex and Claude primary-browser instructions explicitly", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const codex = path.join(bin, "codex");
  await writeFile(codex, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(codex, 0o755);
  const claude = path.join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(claude, 0o755);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";
  const runtimeDir = path.join(home, "runtime");
  await writeActiveRuntimeDescriptor(t, runtimeDir, storeExtensionId);

  const result = await runCli([
    "setup",
    "--yes",
    "--channel=store",
    "--extension-id",
    storeExtensionId,
    "--agents=codex-cli,claude-code",
    "--write-instructions",
    "--json",
  ], {
    HOME: home,
    PATH: bin,
    OBU_RUNTIME_DIR: runtimeDir,
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.steps.find((step: any) => step.id === "agent-codex-cli-instructions")?.status, "applied");
  assert.equal(payload.steps.find((step: any) => step.id === "agent-claude-code-instructions")?.status, "applied");
  const codexInstructions = await readFile(path.join(home, ".codex", "AGENTS.md"), "utf8");
  const claudeInstructions = await readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8");
  for (const instructions of [codexInstructions, claudeInstructions]) {
    assert.match(instructions, /primary BrowserUse\/browser automation tool/);
    assert.match(instructions, /Check `browser_status`/);
    assert.match(instructions, /use the `js` tool for browser automation/);
    assert.match(instructions, /run `~\/\.obu\/bin\/obu verify --agent=<agent-id> --browser=<browser> --channel=<channel> --extension-id=<extension-id>`/);
  }
});

test("setup returns a manual action instead of writing malformed Codex config", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const configPath = path.join(home, ".codex", "config.toml");
  const malformed = "[broken\n";
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, malformed, "utf8");
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli([
    "setup",
    "--yes",
    "--channel=store",
    "--extension-id",
    storeExtensionId,
    "--agents=codex-cli",
    "--json",
  ], {
    HOME: home,
    PATH: "",
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
    OBU_HOST_BIN: hostBin,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  const step = payload.steps.find((row: any) => row.id === "agent-codex-cli");
  assert.equal(step?.status, "manual_action_required");
  assert.match(step?.message ?? "", /could not be parsed/);
  assert.equal(step?.details?.code, "PARSE_ERROR");
  assert.equal(await readFile(configPath, "utf8"), malformed);
});

test("setup CLI rejects unknown requested agents before writing", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["setup", "--agents=unknown", "--json"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unsupported agent/);
});

test("Store channel fails loudly when no Store extension id is configured", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["doctor", "browser", "--channel=store"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /store extension id is not configured/);
});

test("aggregate doctor CLI honors Store channel and extension id source", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli(["doctor", "--channel=store", "--extension-id", storeExtensionId, "--json"], {
    HOME: home,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
  });

  assert.notEqual(result.code, 2);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "doctor");
  assert.equal(payload.extension.channel, "store");
  assert.equal(payload.extension.id, storeExtensionId);
  assert.equal(payload.extension.idSource, "explicit-argument");
  assert.equal(payload.checks.some((check: any) =>
    check.id === "extension-installed" &&
    check.details?.channel === "store" &&
    check.details?.extensionId === storeExtensionId &&
    /Chrome Web Store extension/.test(check.remediation?.value ?? "") &&
    !String(check.remediation?.value ?? "").includes("packages/extension/dist")
  ), true);
});

test("commands reject unknown extension channels explicitly", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["install-host", "--channel=bogus"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Supported channels: unpacked-dev, store/);
});

test("install-host default output is summarized and verbose keeps details", async (t) => {
  if (process.platform === "win32") {
    t.skip("native host install is not supported on Windows");
    return;
  }
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const env = {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
  };

  const summary = await runCli(["install-host", "--browser=chrome", "--dry-run"], env);
  assert.equal(summary.code, 0);
  assert.equal(summary.stdout, "Native host dry run: would update chrome.\n");

  const verbose = await runCli(["install-host", "--browser=chrome", "--dry-run", "--verbose"], env);
  assert.equal(verbose.code, 0);
  assert.match(verbose.stdout, /WOULD_APPLY chrome: would write native-host wrapper and manifest/);

  const failed = await runCli(["install-host", "--browser=chrome"], {
    HOME: home,
    OBU_HOST_BIN: path.join(bin, "missing-obu-host"),
    OBU_RUNTIME_DIR: path.join(home, "failed-runtime"),
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /Native host install failed for chrome: obu-host is not executable\. Run with --verbose for the path\./);
  assert.doesNotMatch(failed.stdout, new RegExp(escapeRegExp(path.join(bin, "missing-obu-host"))));

  const failedVerbose = await runCli(["install-host", "--browser=chrome", "--verbose"], {
    HOME: home,
    OBU_HOST_BIN: path.join(bin, "missing-obu-host"),
    OBU_RUNTIME_DIR: path.join(home, "failed-runtime-verbose"),
  });
  assert.equal(failedVerbose.code, 1);
  assert.match(failedVerbose.stdout, new RegExp(escapeRegExp(path.join(bin, "missing-obu-host"))));
});

test("install-host CLI writes Store native host manifest for Store extension id", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  const bin = await mkdtemp(path.join(os.tmpdir(), "obu-cli-bin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const hostBin = path.join(bin, "obu-host");
  await writeFile(hostBin, "#!/bin/sh\n", "utf8");
  await chmod(hostBin, 0o755);
  const storeExtensionId = "abcdefghijklmnopabcdefghijklmnop";

  const result = await runCli(["install-host", "--channel=store", "--extension-id", storeExtensionId, "--json"], {
    HOME: home,
    OBU_HOST_BIN: hostBin,
    OBU_RUNTIME_DIR: path.join(home, "runtime"),
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.extensionChannel, "store");
  assert.equal(payload.extensionId, storeExtensionId);
  const nativeHost = JSON.parse(await readFile(path.join(nativeMessagingHostDir("chrome", process.platform, home), "dev.obu.host.json"), "utf8"));
  assert.deepEqual(nativeHost.allowed_origins, [`chrome-extension://${storeExtensionId}/`]);
});

test("repl command is explicitly deferred in P4a", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runCli(["repl"], { HOME: home });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /repl is deferred in P4a/);
});

function withTestXdgConfigHome(t: { after: (fn: () => void | Promise<void>) => void }, home: string): void {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  });
}

async function writeExecutable(file: string, content: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
  return file;
}

async function writeCodexMcpConfig(home: string, command = process.execPath, args = [cliEntry, "mcp", "stdio"]): Promise<void> {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), [
    "[mcp_servers.open-browser-use]",
    `command = "${shellEscapeForDoubleQuotes(command)}"`,
    `args = [${args.map((arg) => `"${shellEscapeForDoubleQuotes(arg)}"`).join(", ")}]`,
    "",
  ].join("\n"), "utf8");
}

async function writeCursorMcpConfig(home: string, command: string, args: string[]): Promise<void> {
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await writeFile(path.join(home, ".cursor", "mcp.json"), `${JSON.stringify({
    mcpServers: {
      "open-browser-use": {
        command,
        args,
      },
    },
  }, null, 2)}\n`, "utf8");
}

async function writeTrustedAgentRuntimeResult(
  runtimeDir: string,
  challengePath: string,
  extensionId: string,
  options: { generatedAt?: string; status?: Record<string, unknown> } = {},
): Promise<string> {
  const challenge = JSON.parse(await readFile(challengePath, "utf8"));
  const nonce = challenge.challenge.nonce;
  const digest = createHash("sha256").update(nonce).digest("hex");
  const resultFile = path.join(runtimeDir, "agent-runtime-hooks", challenge.agentId, challenge.trustedHook.id, `${digest}.json`);
  await mkdir(path.dirname(resultFile), { recursive: true, mode: 0o700 });
  const status = options.status ?? {
    sdk_bootstrap: "available",
    backends: [
      {
        type: "webextension",
        name: "chrome",
        metadata: {
          browser_kind: "chrome",
          extension_id: extensionId,
        },
      },
    ],
  };
  await writeFile(resultFile, `${JSON.stringify({
    schemaVersion: 1,
    agentId: challenge.agentId,
    mcpServerName: "open-browser-use",
    provenance: "agent_runtime_hook",
    hook: challenge.trustedHook,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    challenge: challenge.challenge,
    target: challenge.target,
    status,
  }, null, 2)}\n`, "utf8");
  await chmod(resultFile, 0o600);
  return resultFile;
}

async function writeFakeMcpObu(bin: string, extensionId: string): Promise<string> {
  const mcpScript = path.join(bin, "fake-mcp.js");
  await writeFile(mcpScript, `
const extensionId = ${JSON.stringify(extensionId)};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { capabilities: { tools: {} }, serverInfo: { name: "fake-obu", version: "0.0.0" } } });
    } else if (request.method === "tools/call" && request.params?.name === "browser_status") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          structuredContent: {
            sdk_bootstrap: "available",
            backends: [
              { type: "webextension", name: "chrome", metadata: { browser_kind: "chrome", extension_id: extensionId } },
            ],
          },
        },
      });
    }
  }
});
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
`, "utf8");
  const fakeObu = path.join(bin, "obu");
  return writeExecutable(fakeObu, [
    "#!/bin/sh",
    "set -eu",
    "if [ \"${1:-}\" = \"mcp\" ] && [ \"${2:-}\" = \"stdio\" ]; then",
    `  exec ${shellQuote(process.execPath)} ${shellQuote(mcpScript)}`,
    "fi",
    "exit 1",
    "",
  ].join("\n"));
}

async function writeNativeHostManifest(home: string, hostBin: string, extensionId: string, runtimeDir: string): Promise<void> {
  const manifestPath = path.join(nativeMessagingHostDir("chrome", process.platform, home), "dev.obu.host.json");
  const wrapperPath = nativeHostWrapperPath({
    nativeHostInstallRoot: path.join(home, ".obu", "native-host"),
    browser: "chrome",
  });
  await mkdir(path.dirname(wrapperPath), { recursive: true });
  await writeFile(wrapperPath, nativeHostWrapperContent({
    hostBin,
    browser: "chrome",
    runtimeDir,
  }), "utf8");
  await chmod(wrapperPath, 0o755);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    name: "dev.obu.host",
    description: "open-browser-use native messaging host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2), "utf8");
}

async function writeChromePreferences(profilePath: string, extensionId: string, state: number): Promise<void> {
  await mkdir(profilePath, { recursive: true });
  await writeFile(path.join(profilePath, "Preferences"), JSON.stringify({
    extensions: {
      settings: {
        [extensionId]: {
          state,
          manifest: { version: "0.1.0" },
        },
      },
    },
  }, null, 2), "utf8");
}

async function writeRuntimeDescriptor(file: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

async function writeActiveRuntimeDescriptor(
  t: { after: (fn: () => void | Promise<void>) => void },
  runtimeDir: string,
  extensionId: string,
  browserKind = "chrome",
): Promise<void> {
  const descriptorDir = path.join(runtimeDir, "webextension");
  await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
  await chmod(descriptorDir, 0o700);
  const socketPath = path.join(runtimeDir, `${browserKind}.sock`);
  await startRuntimeDescriptorServer(t, socketPath, {
    getInfoResult: {
      type: "webextension",
      name: browserKind,
      metadata: {
        backend: {
          browser_kind: browserKind,
          extension_id: extensionId,
        },
      },
    },
  });
  await writeRuntimeDescriptor(path.join(descriptorDir, `${browserKind}.json`), {
    schema_version: 1,
    type: "webextension",
    name: browserKind,
    socketPath,
    sdk_auth_token: "token",
    pid: process.pid,
    metadata: {
      browser_kind: browserKind,
      extension_id: extensionId,
    },
  });
}

async function startRuntimeDescriptorServer(
  t: { after: (fn: () => void | Promise<void>) => void },
  socketPath: string,
  options: { getInfoResult?: Record<string, unknown> } = {},
): Promise<void> {
  const server = net.createServer((socket) => {
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        const request = JSON.parse(body.toString("utf8"));
        if (request.method === "auth") {
          authenticated = true;
          socket.write(encodeTestFrame({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
          continue;
        }
        if (authenticated && request.method === "getInfo") {
          socket.write(encodeTestFrame({
            jsonrpc: "2.0",
            id: request.id,
            result: options.getInfoResult ?? { type: "webextension", name: "chrome", metadata: { diagnostics: { lifecycle: {} } } },
          }));
          continue;
        }
        socket.write(encodeTestFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

function encodeTestFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function assertVerifyOutcome(payload: any, result: string, nextActionKind: string | null): void {
  assert.equal(payload.result, result);
  assert.equal(Object.hasOwn(payload, "nextActions"), false);
  if (nextActionKind === null) {
    assert.equal(payload.nextAction, null);
    assert.equal(payload.productError, null);
    return;
  }
  assert.equal(typeof payload.nextAction, "object");
  assert.equal(payload.nextAction.kind, nextActionKind);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellEscapeForDoubleQuotes(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
