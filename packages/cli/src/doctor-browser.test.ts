import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { doctorJson } from "./doctor-json.js";
import {
  doctorBrowser,
  formatDoctorReport,
  hasDoctorFailures,
  type BrowserKind,
  type DoctorBrowserOptions,
  type DoctorReport,
} from "./doctor-browser.js";

const HOST_NAME = "dev.obu.host";
const EXTENSION_KEY = Buffer.from("open-browser-use test extension key").toString("base64");

type DoctorFixture = {
  root: string;
  extensionId: string;
  nativeHostManifestPath: string;
  runtimeDir: string;
  runtimeDescriptorDir: string;
  extensionCurrentDir: string;
  options: DoctorBrowserOptions;
};

type ExpectedRepair = {
  id: string;
  status: "applied" | "skipped" | "failed";
  message: RegExp;
  human: RegExp;
  details: string[];
};

test("doctorBrowser reports a valid local browser setup without failures", async (t) => {
  const fixture = await createDoctorFixture(t);

  const report = await doctorBrowser(fixture.options);
  const checks = checksById(report);

  assert.equal(report.extensionId, fixture.extensionId);
  assert.equal(checks["extension-manifest"]?.status, "pass");
  assert.equal(checks["browser-installed"]?.status, "pass");
  assert.equal(checks["profile-path"]?.status, "pass");
  assert.equal(checks["extension-installed"]?.status, "pass");
  assert.equal(checks["native-host-manifest"]?.status, "pass");
  assert.equal(checks["native-host-version"]?.status, "pass");
  assert.equal(checks["runtime-dir"]?.status, "pass");
  assert.equal(checks["runtime-descriptor-dir"]?.status, "pass");
  assert.equal(checks["runtime-descriptor-probe"]?.status, "warn");
  assert.match(String(checks["runtime-descriptor-probe"]?.details?.repair ?? ""), /click Resume/);
  assert.equal(hasDoctorFailures(report), false);

  const formatted = formatDoctorReport(report);
  assert.match(formatted, /open-browser-use browser doctor: chrome/);
  assert.match(formatted, /PASS Native host manifest:/);
  assert.match(formatted, /WARN Runtime descriptor probe:/);
  assert.match(formatted, /repair: .*click Resume/);
});

test("doctor JSON envelope uses the stable P4 schema shape", async (t) => {
  const fixture = await createDoctorFixture(t);
  const report = await doctorBrowser(fixture.options);
  const envelope = doctorJson({
    report,
    layout: {
      mode: "repo",
      root: fixture.root,
      openBrowserUseCommand: path.join(fixture.root, "obu"),
      cliEntry: path.join(fixture.root, "cli", "index.js"),
      hostBin: fixture.options.hostBinary!,
      nodeReplBin: path.join(fixture.root, "obu-node-repl"),
      nodeBin: process.execPath,
      nodeModulesRoot: path.join(fixture.root, "node_modules"),
      sdkPackageRoot: path.join(fixture.root, "node_modules", "@open-browser-use", "sdk"),
      sdkDistRoot: path.join(fixture.root, "node_modules", "@open-browser-use", "sdk", "dist"),
      extensionDir: fixture.extensionCurrentDir,
      extensionInstallRoot: path.dirname(fixture.extensionCurrentDir),
      extensionCurrentDir: fixture.extensionCurrentDir,
      nativeHostInstallRoot: path.dirname(fixture.nativeHostManifestPath),
      userConfigPath: path.join(fixture.root, ".obu", "config.json"),
      runtimeDir: fixture.runtimeDir,
    },
    obuVersion: "0.1.0",
    command: "doctor browser",
    strict: true,
    generatedAt: new Date("2026-05-16T00:00:00.000Z"),
  });

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.generatedAt, "2026-05-16T00:00:00.000Z");
  assert.equal(envelope.command, "doctor browser");
  assert.equal(envelope.strict, true);
  assert.equal(envelope.layout.runtimeDir, fixture.runtimeDir);
  assert.equal(envelope.summary.fail, 0);
  assert.ok(envelope.checks.some((check) =>
    check.id === "runtime-descriptor-probe" &&
    check.scope === "runtime" &&
    check.remediation?.kind === "manual"
  ));
});

test("doctorBrowser finds unpacked extensions recorded in Secure Preferences", async (t) => {
  const fixture = await createDoctorFixture(t);
  await rm(path.join(fixture.options.profileRoot!, "Default", "Preferences"), { force: true });
  await mkdir(path.join(fixture.options.profileRoot!, "Profile 2"), { recursive: true });
  await writeJson(path.join(fixture.options.profileRoot!, "Profile 2", "Secure Preferences"), {
    extensions: {
      settings: {
        [fixture.extensionId]: {
          location: 4,
          path: fixture.extensionCurrentDir,
          disable_reasons: [],
          active_permissions: { api: ["nativeMessaging"] },
        },
      },
    },
  });

  const report = await doctorBrowser(fixture.options);
  const installed = checksById(report)["extension-installed"];

  assert.equal(installed?.status, "pass");
  assert.match(installed?.message ?? "", /Secure Preferences/);
  assert.equal(installed?.details?.rawPath, fixture.extensionCurrentDir);
});

test("doctorBrowser warns when extension settings have disable reasons", async (t) => {
  const fixture = await createDoctorFixture(t);
  await writeJson(path.join(fixture.options.profileRoot!, "Default", "Preferences"), {
    extensions: {
      settings: {
        [fixture.extensionId]: {
          state: 1,
          path: fixture.extensionCurrentDir,
          disable_reasons: 1,
        },
      },
    },
  });

  const report = await doctorBrowser(fixture.options);
  const installed = checksById(report)["extension-installed"];

  assert.equal(installed?.status, "warn");
  assert.match(installed?.message ?? "", /disabled/);
  assert.equal(installed?.details?.disable_reasons, 1);
});

test("doctorBrowser fails an extension manifest missing required runtime permissions", async (t) => {
  const fixture = await createDoctorFixture(t);
  await writeJson(path.join(fixture.root, "extension-manifest.json"), {
    ...validExtensionManifest(),
    permissions: ["nativeMessaging", "debugger", "tabs"],
  });

  const report = await doctorBrowser(fixture.options);
  const manifest = checksById(report)["extension-manifest"];

  assert.equal(manifest?.status, "fail");
  assert.match(manifest?.message ?? "", /permissions must include alarms/);
  assert.match(manifest?.message ?? "", /permissions must include downloads/);
  assert.match(String(manifest?.details?.repair ?? ""), /Rebuild and reload packages\/extension/);
  assert.equal(hasDoctorFailures(report), true);
});

test("doctorBrowser fails an extension manifest missing the cursor content script", async (t) => {
  const fixture = await createDoctorFixture(t);
  await writeJson(path.join(fixture.root, "extension-manifest.json"), {
    ...validExtensionManifest(),
    content_scripts: [],
  });

  const report = await doctorBrowser(fixture.options);
  const manifest = checksById(report)["extension-manifest"];

  assert.equal(manifest?.status, "fail");
  assert.match(manifest?.message ?? "", /content_scripts must include cursor\.js/);
});

test("doctorBrowser fails an invalid native host manifest", async (t) => {
  const fixture = await createDoctorFixture(t);
  await writeJson(fixture.nativeHostManifestPath, {
    name: "wrong.host",
    type: "stdio",
    path: "relative-host-path",
    allowed_origins: [],
  });

  const report = await doctorBrowser(fixture.options);
  const nativeHost = checksById(report)["native-host-manifest"];

  assert.equal(nativeHost?.status, "fail");
  assert.match(nativeHost?.message ?? "", /name must be dev\.obu\.host/);
  assert.match(nativeHost?.message ?? "", /path must be absolute/);
  assert.equal(hasDoctorFailures(report), true);
});

test("doctorBrowser repair writes an invalid native host manifest", async (t) => {
  const fixture = await createDoctorFixture(t);
  await writeJson(fixture.nativeHostManifestPath, {
    name: "wrong.host",
    type: "stdio",
    path: "relative-host-path",
    allowed_origins: [],
  });

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const nativeHost = checksById(report)["native-host-manifest"];
  const manifest = JSON.parse(await readFile(fixture.nativeHostManifestPath, "utf8"));

  assert.equal(nativeHost?.status, "pass");
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, "stdio");
  assert.match(manifest.path, /native-host\/dev\.obu\.host\/chrome\/obu-host-wrapper$/);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${fixture.extensionId}/`]);
  assert.match(await readFile(manifest.path, "utf8"), /OBU_RUNTIME_DIR=/);
  assertRepair(report, {
    id: "native-host-manifest",
    status: "applied",
    message: /wrote native host manifest/,
    human: /APPLIED wrote native host manifest/,
    details: ["path", "wrapperPath"],
  });
});

test("doctorBrowser repair skips a valid native host manifest", async (t) => {
  const fixture = await createDoctorFixture(t);
  const before = await readFile(fixture.nativeHostManifestPath, "utf8");

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const after = await readFile(fixture.nativeHostManifestPath, "utf8");

  assert.equal(checksById(report)["native-host-manifest"]?.status, "pass");
  assert.equal(after, before);
  assertRepair(report, {
    id: "native-host-manifest",
    status: "skipped",
    message: /native host manifest already valid/,
    human: /SKIPPED native host manifest already valid/,
    details: ["path"],
  });
});

test("doctorBrowser warns when unpacked extension is loaded from a non-stable path", async (t) => {
  const fixture = await createDoctorFixture(t);
  const driftPath = path.join(fixture.root, "extension-cache", "0.1.0");
  await mkdir(driftPath, { recursive: true });
  await writeJson(path.join(fixture.options.profileRoot!, "Default", "Preferences"), {
    extensions: {
      settings: {
        [fixture.extensionId]: {
          state: 1,
          path: driftPath,
          manifest: { version: "0.1.0" },
        },
      },
    },
  });

  const report = await doctorBrowser(fixture.options);
  const installed = checksById(report)["extension-installed"];

  assert.equal(installed?.status, "warn");
  assert.match(installed?.message ?? "", /expected/);
  assert.equal(installed?.details?.rawPath, driftPath);
  assert.notEqual(installed?.details?.path, installed?.details?.expectedPath);
  assert.equal(installed?.details?.version, "0.1.0");
});

test("doctorBrowser uses packaged payload paths when OBU_PAYLOAD_ROOT is set", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "obu-cli-doctor-home-"));
  const payload = await mkdtemp(path.join(os.tmpdir(), "obu-cli-doctor-payload-current-"));
  const payloadParent = path.dirname(payload);
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(payload, { recursive: true, force: true }));

  const extensionId = extensionIdFromManifestKey(EXTENSION_KEY);
  const extensionDir = path.join(payload, "extension", "dist");
  await mkdir(extensionDir, { recursive: true });
  await writeJson(path.join(extensionDir, "manifest.json"), validExtensionManifest());

  const hostBinary = path.join(payload, "bin", "obu-host");
  await mkdir(path.dirname(hostBinary), { recursive: true });
  await writeFile(hostBinary, "#!/bin/sh\necho obu-host packaged\n", "utf8");
  await chmod(hostBinary, 0o700);

  const extensionCurrentDir = path.join(home, ".obu", "extension", "current");
  await mkdir(extensionCurrentDir, { recursive: true });
  const profileRoot = path.join(home, "profile");
  await mkdir(path.join(profileRoot, "Default"), { recursive: true });
  await writeJson(path.join(profileRoot, "Default", "Preferences"), {
    extensions: {
      settings: {
        [extensionId]: { state: 1, path: extensionCurrentDir, manifest: { version: "0.1.0" } },
      },
    },
  });

  const nativeManifestDir = path.join(home, "NativeMessagingHosts");
  await mkdir(nativeManifestDir, { recursive: true });
  await writeJson(path.join(nativeManifestDir, `${HOST_NAME}.json`), {
    name: HOST_NAME,
    type: "stdio",
    path: hostBinary,
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });

  const runtimeDir = path.join(home, "runtime");
  await mkdir(path.join(runtimeDir, "webextension"), { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(path.join(runtimeDir, "webextension"), 0o700);

  const report = await doctorBrowser({
    browser: "chrome",
    env: { OBU_PAYLOAD_ROOT: payload },
    homeDir: home,
    repoRoot: payloadParent,
    browserInstallPath: home,
    profileRoot,
    nativeManifestDir,
    runtimeDir,
    extensionCurrentDir,
  });
  const checks = checksById(report);

  assert.equal(report.extensionId, extensionId);
  assert.equal(checks["extension-manifest"]?.details?.path, path.join(extensionDir, "manifest.json"));
  assert.equal(checks["native-host-version"]?.details?.path, hostBinary);
  assert.equal(checks["extension-manifest"]?.status, "pass");
  assert.equal(checks["native-host-version"]?.status, "pass");
});

test("doctorBrowser repair fails native host manifest repair without an extension id", async (t) => {
  const fixture = await createDoctorFixture(t);
  await writeJson(path.join(fixture.root, "extension-manifest.json"), {
    ...validExtensionManifest(),
    key: undefined,
  });

  const report = await doctorBrowser({ ...fixture.options, repair: true });

  assertRepair(report, {
    id: "native-host-manifest",
    status: "failed",
    message: /extension id could not be derived/,
    human: /FAILED  cannot repair native host manifest because extension id could not be derived/,
    details: ["path", "reason"],
  });
});

test("doctorBrowser repair fails native host manifest repair without executable host binary", async (t) => {
  const fixture = await createDoctorFixture(t);
  await writeJson(fixture.nativeHostManifestPath, {
    name: "wrong.host",
    type: "stdio",
    path: "relative-host-path",
    allowed_origins: [],
  });
  await chmod(fixture.options.hostBinary!, 0o600);

  const report = await doctorBrowser({ ...fixture.options, repair: true });

  assertRepair(report, {
    id: "native-host-manifest",
    status: "failed",
    message: /host binary is not executable/,
    human: /FAILED  cannot repair native host manifest because host binary is not executable/,
    details: ["path"],
  });
});

test("doctorBrowser repair creates a missing runtime descriptor directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not meaningful on Windows");
    return;
  }
  const fixture = await createDoctorFixture(t);
  await rm(fixture.runtimeDescriptorDir, { recursive: true, force: true });

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const checks = checksById(report);

  assert.equal(checks["runtime-descriptor-dir"]?.status, "pass");
  assert.equal(checks["runtime-descriptor-probe"]?.status, "warn");
  assert.equal((await stat(fixture.runtimeDescriptorDir)).mode & 0o777, 0o700);
  assertRepair(report, {
    id: "runtime-descriptor-dir",
    status: "applied",
    message: /created runtime descriptor directory/,
    human: /APPLIED created runtime descriptor directory/,
    details: ["path"],
  });
});

test("doctorBrowser repair fails when the runtime descriptor path is not a directory", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not meaningful on Windows");
    return;
  }
  const fixture = await createDoctorFixture(t);
  await rm(fixture.runtimeDescriptorDir, { recursive: true, force: true });
  await writeFile(fixture.runtimeDescriptorDir, "not a directory", "utf8");

  const report = await doctorBrowser({ ...fixture.options, repair: true });

  assertRepair(report, {
    id: "runtime-descriptor-dir",
    status: "failed",
    message: /runtime descriptor path is not a directory/,
    human: /FAILED  runtime descriptor path is not a directory/,
    details: ["path"],
  });
});

test("doctorBrowser rejects world-readable runtime descriptor directories", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not meaningful on Windows");
    return;
  }
  const fixture = await createDoctorFixture(t);
  await chmod(fixture.runtimeDescriptorDir, 0o755);

  const report = await doctorBrowser(fixture.options);
  const descriptorDir = checksById(report)["runtime-descriptor-dir"];

  assert.equal(descriptorDir?.status, "fail");
  assert.match(descriptorDir?.message ?? "", /owner-only/);
});

test("doctorBrowser rejects world-readable runtime descriptor files", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not meaningful on Windows");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor());
  await chmod(descriptorPath, 0o644);

  const report = await doctorBrowser(fixture.options);
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "fail");
  assert.match(descriptorProbe?.message ?? "", /descriptor permissions must be owner-only/);
});

test("doctorBrowser repair fixes runtime descriptor permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permissions are not meaningful on Windows");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime-repair.sock");
  await startRuntimeDescriptorServer(t, socketPath, { name: "chrome" });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(fixture.runtimeDescriptorDir, 0o755);
  await chmod(descriptorPath, 0o644);

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const checks = checksById(report);

  assert.equal(checks["runtime-descriptor-dir"]?.status, "pass");
  assert.equal(checks["runtime-descriptor-probe"]?.status, "pass");
  assert.equal((await stat(fixture.runtimeDescriptorDir)).mode & 0o777, 0o700);
  assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    report.repairs?.filter((repair) => repair.status === "applied").map((repair) => repair.id),
    ["runtime-descriptor-dir", "runtime-descriptor-file"],
  );
  assertRepair(report, {
    id: "runtime-descriptor-dir",
    status: "applied",
    message: /set runtime descriptor directory permissions/,
    human: /APPLIED set runtime descriptor directory permissions/,
    details: ["path"],
  });
  assertRepair(report, {
    id: "runtime-descriptor-file",
    status: "applied",
    message: /set runtime descriptor file permissions/,
    human: /APPLIED set runtime descriptor file permissions/,
    details: ["path"],
  });
});

test("doctorBrowser reports stale runtime descriptor processes before socket probing", async (t) => {
  if (process.platform === "win32") {
    t.skip("process liveness probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ pid: 999_999 }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser(fixture.options);
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "fail");
  assert.match(descriptorProbe?.message ?? "", /descriptor process is not alive/);
});

test("doctorBrowser repair removes stale runtime descriptor processes", async (t) => {
  if (process.platform === "win32") {
    t.skip("process liveness probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ pid: 999_999 }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "warn");
  assert.match(descriptorProbe?.message ?? "", /no active WebExtension descriptor/);
  assert.equal(await stat(descriptorPath).then(() => true).catch(() => false), false);
  assertRepair(report, {
    id: "runtime-descriptor-stale",
    status: "applied",
    message: /descriptor process is not alive/,
    human: /APPLIED removed stale runtime descriptor .*descriptor process is not alive/,
    details: ["path", "reason"],
  });
});

test("doctorBrowser rejects runtime descriptors pointing at non-socket files", async (t) => {
  if (process.platform === "win32") {
    t.skip("socket validation is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "not-a-socket");
  await writeFile(socketPath, "", "utf8");
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser(fixture.options);
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "fail");
  assert.match(descriptorProbe?.message ?? "", /descriptor socket path is not a socket/);
});

test("doctorBrowser repair removes descriptors pointing at non-socket files", async (t) => {
  if (process.platform === "win32") {
    t.skip("socket validation is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "not-a-socket");
  await writeFile(socketPath, "", "utf8");
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "warn");
  assert.match(descriptorProbe?.message ?? "", /no active WebExtension descriptor/);
  assert.equal(await stat(descriptorPath).then(() => true).catch(() => false), false);
  assertRepair(report, {
    id: "runtime-descriptor-stale",
    status: "applied",
    message: /descriptor socket path is not a socket/,
    human: /APPLIED removed stale runtime descriptor .*descriptor socket path is not a socket/,
    details: ["path", "reason"],
  });
});

test("doctorBrowser reports runtime descriptor auth rejection", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime-auth-rejected.sock");
  await startRuntimeDescriptorServer(t, socketPath, {
    authError: { code: -1100, message: "capability token rejected" },
  });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser(fixture.options);
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "fail");
  assert.match(descriptorProbe?.message ?? "", /auth rejected/);
  assert.match(String(descriptorProbe?.details?.repair ?? ""), /click Resume/);
});

test("doctorBrowser repair removes runtime descriptors with auth rejection", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime-auth-rejected-repair.sock");
  await startRuntimeDescriptorServer(t, socketPath, {
    authError: { code: -1100, message: "capability token rejected" },
  });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "warn");
  assert.match(descriptorProbe?.message ?? "", /no active WebExtension descriptor/);
  assert.equal(await stat(descriptorPath).then(() => true).catch(() => false), false);
  assertRepair(report, {
    id: "runtime-descriptor-stale",
    status: "applied",
    message: /auth rejected/,
    human: /APPLIED removed stale runtime descriptor .*auth rejected/,
    details: ["path", "reason"],
  });
});

test("doctorBrowser reports runtime descriptor getInfo consistency failures", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime-name-mismatch.sock");
  await startRuntimeDescriptorServer(t, socketPath, {
    getInfoResult: { type: "webextension", name: "unexpected-browser" },
  });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser(fixture.options);
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "fail");
  assert.match(descriptorProbe?.message ?? "", /getInfo name mismatch/);
  assert.match(String(descriptorProbe?.details?.repair ?? ""), /click Resume/);
});

test("doctorBrowser repair removes runtime descriptors with getInfo mismatch", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime-name-mismatch-repair.sock");
  await startRuntimeDescriptorServer(t, socketPath, {
    getInfoResult: { type: "webextension", name: "unexpected-browser" },
  });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "warn");
  assert.match(descriptorProbe?.message ?? "", /no active WebExtension descriptor/);
  assert.equal(await stat(descriptorPath).then(() => true).catch(() => false), false);
  assertRepair(report, {
    id: "runtime-descriptor-stale",
    status: "applied",
    message: /getInfo name mismatch/,
    human: /APPLIED removed stale runtime descriptor .*getInfo name mismatch/,
    details: ["path", "reason"],
  });
});

test("doctorBrowser surfaces runtime descriptor lifecycle diagnostics", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime.sock");
  const lifecycle = {
    stale_sessions: 0,
    stale_session_reasons: [],
    stale_tabs: 0,
    stale_file_choosers: 0,
    stale_downloads: 0,
    deliverable_tabs: 2,
    deliverable_tab_summaries: [
      {
        tab_id: "8",
        session_id: "session",
        url: "https://deliverable.example/",
        title: "Deliverable",
      },
    ],
  };
  await startRuntimeDescriptorServer(t, socketPath, { name: "chrome", lifecycle });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser(fixture.options);
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "pass");
  assert.match(descriptorProbe?.message ?? "", /chrome\.json responded to getInfo/);
  assert.equal(descriptorProbe?.details?.descriptor, "chrome.json");
  assert.deepEqual(descriptorProbe?.details?.lifecycle, lifecycle);
  assert.match(String(descriptorProbe?.details?.deliverable_recovery ?? ""), /browser\.deliverables\(\)/);

  const formatted = formatDoctorReport(report);
  assert.match(formatted, /PASS Runtime descriptor probe: chrome\.json responded to getInfo/);
  assert.match(formatted, /lifecycle: .*stale_sessions=0/);
  assert.match(formatted, /lifecycle: .*deliverable_tabs=2/);
  assert.match(formatted, /lifecycle: .*stale_session_reasons=0/);
  assert.match(formatted, /deliverable tabs: 8:Deliverable \(session\)/);
  assert.match(formatted, /recover deliverables: .*browser\.deliverables\(\).*claim\(\)/);
});

test("doctorBrowser warns when runtime descriptor reports stale lifecycle diagnostics", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime-stale.sock");
  const lifecycle = {
    stale_sessions: 1,
    stale_session_reasons: [{ session_id: "session-1", reason: "missing_tab" }],
    stale_tabs: 2,
    stale_file_choosers: 1,
    stale_downloads: 0,
    deliverable_tabs: 3,
  };
  await startRuntimeDescriptorServer(t, socketPath, { name: "chrome", lifecycle });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser(fixture.options);
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "warn");
  assert.match(descriptorProbe?.message ?? "", /stale lifecycle state/);
  assert.match(descriptorProbe?.message ?? "", /stale_sessions=1/);
  assert.match(descriptorProbe?.message ?? "", /stale_tabs=2/);
  assert.deepEqual(descriptorProbe?.details?.lifecycle, lifecycle);

  const formatted = formatDoctorReport(report);
  assert.match(formatted, /WARN Runtime descriptor probe: .*stale lifecycle state/);
  assert.match(formatted, /lifecycle: .*stale_file_choosers=1/);
  assert.match(formatted, /stale session reasons: session-1:missing_tab/);
  assert.match(formatted, /repair: .*click Resume/);
});

test("doctorBrowser repair clears runtime descriptor stale lifecycle diagnostics", async (t) => {
  if (process.platform === "win32") {
    t.skip("Unix socket probing is POSIX-only");
    return;
  }
  const fixture = await createDoctorFixture(t);
  const socketPath = path.join(fixture.root, "runtime-stale-repair.sock");
  const lifecycle = {
    stale_sessions: 1,
    stale_session_reasons: [{ session_id: "session-1", reason: "missing_tab" }],
    stale_tabs: 2,
    stale_file_choosers: 1,
    stale_downloads: 1,
    deliverable_tabs: 3,
  };
  await startRuntimeDescriptorServer(t, socketPath, { name: "chrome", lifecycle });
  const descriptorPath = path.join(fixture.runtimeDescriptorDir, "chrome.json");
  await writeJson(descriptorPath, validRuntimeDescriptor({ socketPath }));
  await chmod(descriptorPath, 0o600);

  const report = await doctorBrowser({ ...fixture.options, repair: true });
  const descriptorProbe = checksById(report)["runtime-descriptor-probe"];

  assert.equal(descriptorProbe?.status, "pass");
  const repairedLifecycle = descriptorProbe?.details?.lifecycle as Record<string, unknown>;
  assert.equal(repairedLifecycle.stale_sessions, 0);
  assert.equal(repairedLifecycle.stale_tabs, 0);
  assert.equal(repairedLifecycle.deliverable_tabs, 3);
  assertRepair(report, {
    id: "runtime-lifecycle-diagnostics",
    status: "applied",
    message: /cleared stale lifecycle diagnostics/,
    human: /APPLIED cleared stale lifecycle diagnostics/,
    details: ["path", "staleLifecycle", "result"],
  });
  assert.match(String(report.repairs?.find((repair) => repair.id === "runtime-lifecycle-diagnostics")?.details?.staleLifecycle), /stale_sessions=1/);
});

async function createDoctorFixture(t: TestContext): Promise<DoctorFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "obu-cli-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const browser: BrowserKind = "chrome";
  const homeDir = path.join(root, "home");
  await mkdir(homeDir, { recursive: true });
  const manifestPath = path.join(root, "extension-manifest.json");
  const extensionId = extensionIdFromManifestKey(EXTENSION_KEY);
  await writeJson(manifestPath, validExtensionManifest());

  const browserInstallPath = path.join(root, "Google Chrome.app");
  await mkdir(browserInstallPath, { recursive: true });

  const profileRoot = path.join(root, "profile");
  await mkdir(path.join(profileRoot, "Default"), { recursive: true });
  const extensionCurrentDir = path.join(root, "extension", "current");
  await mkdir(extensionCurrentDir, { recursive: true });
  await writeJson(path.join(profileRoot, "Default", "Preferences"), {
    extensions: {
      settings: {
        [extensionId]: { state: 1, path: extensionCurrentDir, manifest: { version: "0.1.0" } },
      },
    },
  });

  const hostBinary = path.join(root, "obu-host");
  await writeFile(hostBinary, "#!/bin/sh\necho obu-host 0.1.0\n", "utf8");
  await chmod(hostBinary, 0o700);

  const nativeManifestDir = path.join(root, "NativeMessagingHosts");
  await mkdir(nativeManifestDir, { recursive: true });
  const nativeHostManifestPath = path.join(nativeManifestDir, `${HOST_NAME}.json`);
  await writeJson(nativeHostManifestPath, {
    name: HOST_NAME,
    type: "stdio",
    path: hostBinary,
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });

  const runtimeDir = path.join(root, "runtime");
  const runtimeDescriptorDir = path.join(runtimeDir, "webextension");
  await mkdir(runtimeDescriptorDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
  await chmod(runtimeDescriptorDir, 0o700);

  return {
    root,
    extensionId,
    nativeHostManifestPath,
    runtimeDir,
    runtimeDescriptorDir,
    extensionCurrentDir,
    options: {
      browser,
      homeDir,
      manifestPath,
      browserInstallPath,
      profileRoot,
      nativeManifestDir,
      hostBinary,
      runtimeDir,
      extensionCurrentDir,
    },
  };
}

function validExtensionManifest() {
  return {
    manifest_version: 3,
    name: "open-browser-use",
    version: "0.1.0",
    key: EXTENSION_KEY,
    minimum_chrome_version: "116",
    action: { default_popup: "popup.html" },
    background: { service_worker: "background.js", type: "module" },
    permissions: [
      "nativeMessaging",
      "debugger",
      "tabs",
      "tabGroups",
      "scripting",
      "storage",
      "history",
      "downloads",
      "alarms",
    ],
    host_permissions: ["<all_urls>"],
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["cursor.js"],
        run_at: "document_start",
      },
    ],
  };
}

function validRuntimeDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    type: "webextension",
    name: "chrome",
    socketPath: path.join(os.tmpdir(), "missing-obu-runtime.sock"),
    sdk_auth_token: "secret-token",
    pid: process.pid,
    ...overrides,
  };
}

function checksById(report: DoctorReport) {
  return Object.fromEntries(report.checks.map((check) => [check.id, check]));
}

function assertRepair(report: DoctorReport, expected: ExpectedRepair) {
  const repair = report.repairs?.find((candidate) =>
    candidate.id === expected.id &&
    candidate.status === expected.status &&
    expected.message.test(candidate.message)
  );
  assert.ok(repair, `missing ${expected.status} repair ${expected.id}`);
  assert.match(repair.message, expected.message);
  assert.ok(repair.details, `repair ${expected.id} should include machine-verifiable details`);
  for (const key of expected.details) {
    assert.notEqual(repair.details[key], undefined, `repair ${expected.id} should include details.${key}`);
  }
  assert.match(formatDoctorReport(report), expected.human);
  return repair;
}

async function startRuntimeDescriptorServer(
  t: TestContext,
  socketPath: string,
  options: RuntimeDescriptorServerOptions,
): Promise<void> {
  let lifecycle = options.lifecycle ?? {};
  const server = net.createServer((socket) => {
    let authenticated = false;
    let buffer = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let request: Record<string, any>;
        try {
          request = JSON.parse(body.toString("utf8"));
        } catch (error) {
          socket.destroy(error instanceof Error ? error : undefined);
          return;
        }
        const response = runtimeDescriptorResponse(request, options, authenticated, lifecycle);
        if (request.method === "clearLifecycleDiagnostics" && !("error" in response)) {
          lifecycle = clearedLifecycle(lifecycle);
        }
        if (request.method === "auth" && !options.authError) authenticated = true;
        socket.write(encodeTestFrame(response));
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

function runtimeDescriptorResponse(
  request: Record<string, any>,
  options: RuntimeDescriptorServerOptions,
  authenticated: boolean,
  lifecycle: Record<string, unknown>,
): Record<string, unknown> {
  if (request.method === "auth") {
    if (options.authError) return { jsonrpc: "2.0", id: request.id, error: options.authError };
    return { jsonrpc: "2.0", id: request.id, result: { ok: true } };
  }
  if (!authenticated) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -1100, message: "first frame must be auth when capability token is enabled" },
    };
  }
  if (request.method === "getInfo") {
    if (options.getInfoError) return { jsonrpc: "2.0", id: request.id, error: options.getInfoError };
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: options.getInfoResult ?? {
        type: "webextension",
        name: options.name ?? "chrome",
        metadata: {
          diagnostics: {
                lifecycle,
          },
        },
      },
    };
  }
  if (request.method === "clearLifecycleDiagnostics") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        cleared: lifecycle,
        diagnostics: { lifecycle: clearedLifecycle(lifecycle) },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: "method not found" },
  };
}

function clearedLifecycle(lifecycle: Record<string, unknown>): Record<string, unknown> {
  return {
    ...lifecycle,
    stale_sessions: 0,
    stale_session_reasons: [],
    stale_tabs: 0,
    stale_file_choosers: 0,
    stale_downloads: 0,
  };
}

type RuntimeDescriptorServerOptions = {
  name?: string;
  lifecycle?: Record<string, unknown>;
  authError?: Record<string, unknown>;
  getInfoError?: Record<string, unknown>;
  getInfoResult?: Record<string, unknown>;
};

function encodeTestFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function extensionIdFromManifestKey(key: string): string {
  const der = Buffer.from(key, "base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...hash].map((byte) => `${nibbleToIdChar(byte >> 4)}${nibbleToIdChar(byte & 0x0f)}`).join("");
}

function nibbleToIdChar(nibble: number): string {
  return String.fromCharCode("a".charCodeAt(0) + nibble);
}
