import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { doctorAgent, type AgentDoctorCheck } from "./agents/doctor.js";
import { configureAgents } from "./agents/configure.js";
import { type AgentId, type McpServerInvocation } from "./agents/registry.js";
import { appendShellArgs } from "./command-line.js";
import { doctorBrowser } from "./doctor-browser.js";
import { type ExtensionChannel, type ExtensionIdSource } from "./extension-channel.js";
import { browserProfileRoot, nativeMessagingHostDir, type BrowserKind } from "./browser-paths.js";
import { nativeHostWrapperContent, nativeHostWrapperPath, supportedNativeHostBrowsers } from "./native-host.js";
import { PRODUCT_ERROR_SCHEMA } from "./product_errors.generated.js";
import { executableExists, packageVersion, type RuntimeLayout } from "./runtime-layout.js";

const HOST_NAME = "dev.obu.host";
const SERVER_NAME = "open-browser-use";
const DEFAULT_MCP_PROBE_TIMEOUT_MS = 8_000;
const TRUSTED_AGENT_RUNTIME_FRESHNESS_MS = 60_000;

export type VerificationTarget = "cli" | "agent_runtime";
export type VerifyResult = "ready" | "needs_browser_popup" | "needs_repair" | "needs_manual_action";
export type VerifyCheckStatus = "pass" | "warn" | "fail" | "not_checked";
export type ReadinessStatus = "ready" | "blocked" | "not_checked";
export type ComponentState =
  | "pass"
  | "warn"
  | "fail"
  | "missing"
  | "unreadable"
  | "disabled"
  | "stale"
  | "invalid"
  | "not_checked";
type RuntimeBinding = "profile_verified" | "single_candidate" | "browser_extension_scope" | "not_available";
type VerifyLayer =
  | "target_support"
  | "cli_install"
  | "native_host"
  | "browser_profile"
  | "browser_extension"
  | "extension_runtime"
  | "runtime_descriptor"
  | "agent_mcp"
  | "agent_instruction"
  | "mcp_runtime"
  | "agent_runtime";
type EvidenceScope = "cli" | "browser_extension" | "profile" | "agent_runtime";
type EvidenceProvenance =
  | "runtime_descriptor_probe"
  | "expected_obu_invocation"
  | "agent_runtime_hook"
  | "user_supplied_status_file"
  | "not_applicable";
type NextActionKind =
  | "install_cli"
  | "run_repair"
  | "open_popup"
  | "configure_agent"
  | "resolve_config_conflict"
  | "restart_agent"
  | "collect_agent_runtime_status"
  | "select_profile"
  | "install_extension"
  | "enable_extension"
  | "unsupported";

type VerifyTarget = {
  agent?: AgentId;
  browser?: BrowserKind;
  channel?: ExtensionChannel;
  extensionId?: string;
  profile?: string;
};

type Evidence = {
  scope: EvidenceScope;
  provenance: EvidenceProvenance;
  source: string;
};

type ActionCandidate = {
  result: Exclude<VerifyResult, "ready">;
  kind: NextActionKind;
  priority: number;
  message?: string;
  command?: string;
  url?: string;
  browser?: BrowserKind;
  profile?: { path: string | null; suggestedPath?: string | null; candidates?: ProfileCandidate[] };
  rerun?: string;
  challenge?: { path: string };
  trustedHook?: TrustedRuntimeHook;
};

export type VerifyCheck = {
  id: string;
  layer: VerifyLayer;
  status: VerifyCheckStatus;
  message: string;
  target: VerifyTarget;
  evidence: Evidence;
  reason?: string;
  blocks?: Array<"cli" | "agent_runtime">;
  details?: Record<string, unknown>;
  actionCandidate?: ActionCandidate;
  productError?: ProductErrorCode;
};

type VerifyNextAction = Omit<ActionCandidate, "result" | "priority">;

type ProductErrorCode = (typeof PRODUCT_ERROR_SCHEMA)[number]["code"];

type ProductErrorSummary = {
  code: ProductErrorCode;
  title: string;
  summary: string;
  nextAction: VerifyNextAction | null;
};

type ProfileCandidate = {
  path: string;
  profileExists: ComponentState;
  extensionInstalled: ComponentState;
  extensionEnabled: ComponentState;
  reasons?: Record<string, string>;
};

type VerifyBrowserProfile = {
  path: string | null;
  suggestedPath: string | null;
  source: "explicit" | "default_discovery";
  runtimeBinding: RuntimeBinding;
  candidates: ProfileCandidate[];
};

type VerifyBrowser = {
  kind: BrowserKind;
  channel: ExtensionChannel;
  extensionId: string;
  extensionIdSource: ExtensionIdSource;
  profile: VerifyBrowserProfile;
  extensionInstalled: ComponentState;
  extensionEnabled: ComponentState;
  nativeHost: ComponentState;
  runtimeDescriptor: ComponentState;
  resumeRequired: boolean;
  reasons?: Record<string, string>;
  descriptor?: Record<string, unknown>;
};

type AgentRuntimeStatus =
  | {
    status: "pass";
    provenance: "agent_runtime_hook";
    hook: TrustedRuntimeHook & { trusted: true };
    generatedAt: string;
    targetBound: true;
    challengeBound: true;
  }
  | {
    status: "fail";
    provenance: "agent_runtime_hook";
    reason: string;
    hook: TrustedRuntimeHook & { trusted: true };
    generatedAt?: string;
    targetBound?: boolean;
    challengeBound?: boolean;
  }
  | {
    status: "not_checked";
    provenance: "user_supplied_status_file";
    reason: "diagnostic_status_file_not_trusted";
    diagnostic: {
      statusFile: string;
      targetBound: boolean;
      challengeBound: boolean;
    };
  }
  | {
    status: "not_checked";
    provenance: "not_applicable";
    reason: string;
    trustedHook?: TrustedRuntimeHook;
  };

type VerifyAgent = {
  id: AgentId;
  input?: string;
  mcpConfig: {
    status: VerifyCheckStatus;
    serverName: "open-browser-use";
    command: string;
    args: string[];
    path?: string;
    reason?: string;
    details?: Record<string, unknown>;
  };
  instructions: {
    status: VerifyCheckStatus;
    reason?: "missing_instruction" | "not_implemented";
    path?: string;
  };
  runtimeStatus: AgentRuntimeStatus;
};

type NormalizedBackend = {
  type: string;
  browser: string | null;
  extensionId: string | null;
  extensionIdentity: {
    source: "descriptor_metadata" | "missing";
    verified: boolean;
  };
  metadata?: {
    browserKind?: string;
    extensionId?: string;
    raw?: unknown;
  };
};

type McpRuntimeStatus = {
  source: "direct_mcp_probe" | "agent_runtime" | "agent_runtime_status_file" | "not_checked";
  provenance: EvidenceProvenance;
  probeCommandSource: "expected_obu_invocation" | "agent_runtime_hook" | "user_supplied_status_file" | "not_applicable";
  mcpConfigured: boolean;
  mcpStarts: boolean | null;
  sdkBootstrap: string;
  backendCount: number | null;
  backends: NormalizedBackend[];
  reason?: string;
  details?: Record<string, unknown>;
  productError?: ProductErrorCode;
};

export type VerifyReport = {
  schemaVersion: 1;
  command: "verify";
  verificationTarget: VerificationTarget;
  result: VerifyResult;
  readiness: {
    cli: ReadinessStatus;
    agentRuntime: ReadinessStatus;
  };
  agent: VerifyAgent;
  browser: VerifyBrowser;
  mcpRuntime: {
    cli: McpRuntimeStatus;
    agentRuntime: McpRuntimeStatus;
  };
  productError: ProductErrorSummary | null;
  nextAction: VerifyNextAction | null;
  checks: VerifyCheck[];
};

export type VerifyOptions = {
  layout: RuntimeLayout;
  agent: AgentId;
  agentInput?: string;
  browser: BrowserKind;
  channel: ExtensionChannel;
  extensionId: string;
  extensionIdSource: ExtensionIdSource;
  server: McpServerInvocation;
  commandPrefix: string;
  repair?: boolean;
  requireAgentRuntime?: boolean;
  profile?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  projectDir?: string;
  agentRuntimeChallengeOut?: string;
  agentRuntimeChallengeJson?: string;
  agentRuntimeStatusJson?: string;
  mcpProbeTimeoutMs?: number;
};

type RuntimeDescriptorProbe =
  | {
    status: "pass";
    state: "pass";
    message: string;
    descriptorFile: string;
    descriptorPath: string;
    metadata: Record<string, unknown>;
    browserKind: string;
    extensionId: string;
    profilePath?: string;
    details: Record<string, unknown>;
  }
  | {
    status: "fail";
    state: ComponentState;
    reason: string;
    message: string;
    result: "needs_repair" | "needs_browser_popup";
    productError: ProductErrorCode;
    details?: Record<string, unknown>;
  };

type ProfileResolution = {
  profile: VerifyBrowserProfile;
  extensionInstalled: ComponentState;
  extensionEnabled: ComponentState;
  reasons: Record<string, string>;
  checks: VerifyCheck[];
};

type RpcResponse = Record<string, any>;

type TrustedRuntimeResult =
  | {
    status: "pass";
    runtimeStatus: Extract<AgentRuntimeStatus, { status: "pass" }>;
    mcpRuntime: McpRuntimeStatus;
    details: Record<string, unknown>;
  }
  | {
    status: "fail";
    reason: string;
    message: string;
    mcpRuntime: McpRuntimeStatus;
    productError?: ProductErrorCode;
    details?: Record<string, unknown>;
  }
  | {
    status: "pending";
    reason: string;
    message: string;
    details?: Record<string, unknown>;
  };

const layerOrder: VerifyLayer[] = [
  "target_support",
  "cli_install",
  "native_host",
  "browser_profile",
  "browser_extension",
  "extension_runtime",
  "runtime_descriptor",
  "agent_mcp",
  "agent_instruction",
  "mcp_runtime",
  "agent_runtime",
];

const resultPriority: Record<Exclude<VerifyResult, "ready">, number> = {
  needs_manual_action: 1,
  needs_repair: 2,
  needs_browser_popup: 3,
};

const manualActionPriority: Record<NextActionKind, number> = {
  install_cli: 1,
  unsupported: 2,
  resolve_config_conflict: 3,
  select_profile: 4,
  install_extension: 5,
  enable_extension: 6,
  collect_agent_runtime_status: 7,
  restart_agent: 8,
  configure_agent: 9,
  run_repair: 99,
  open_popup: 99,
};

export async function applyVerifyRepairs(options: VerifyOptions): Promise<void> {
  await doctorBrowser({
    browser: options.browser,
    channel: options.channel,
    extensionId: options.extensionId,
    extensionIdSource: options.extensionIdSource,
    ...(options.channel === "store" ? {} : { extensionCurrentDir: options.layout.mode === "repo" ? options.layout.extensionDir : options.layout.extensionCurrentDir }),
    repair: true,
    runtimeDir: options.layout.runtimeDir,
    ...(options.env ? { env: options.env } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  await configureAgents({
    agents: [options.agent],
    server: options.server,
    dryRun: false,
    writeInstructions: false,
    commandPrefix: options.commandPrefix,
    ...(options.env ? { env: options.env } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
  });
}

export async function verifyOpenBrowserUse(options: VerifyOptions): Promise<VerifyReport> {
  const targetSupported = supportedNativeHostBrowsers().includes(options.browser);
  if (options.repair && targetSupported) await applyVerifyRepairs(options);

  const verificationTarget: VerificationTarget = options.requireAgentRuntime ? "agent_runtime" : "cli";
  const checks: VerifyCheck[] = [];
  const targetBase = baseTarget(options);
  const homeDir = options.homeDir ?? homeDirFromLayout(options.layout) ?? os.homedir();
  const env = options.env ?? process.env;

  checks.push(await checkCliInstall(options, targetBase));
  checks.push(targetSupportCheck(options, targetSupported, targetBase));
  const nativeHost = await checkNativeHost(options, homeDir, targetBase);
  checks.push(nativeHost.check);

  const descriptorProbe = await probeRuntimeDescriptor(options, targetBase);
  const profileResolution = await resolveBrowserProfile(options, homeDir, descriptorProbe, targetBase);
  checks.push(...profileResolution.checks);

  const extensionCheck = browserExtensionCheck(options, profileResolution, targetBase);
  checks.push(extensionCheck);

  const runtimeChecks = runtimeChecksFromProbe(options, descriptorProbe, profileResolution.profile.path, targetBase);
  checks.push(...runtimeChecks);

  const agentReport = await doctorAgent({
    agent: options.agent,
    server: options.server,
    env,
    homeDir,
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
  });
  const agentMcpDoctorCheck = agentReport.checks.find((row) => row.id === "agent-mcp-server");
  const agentInstructionDoctorCheck = agentReport.checks.find((row) => row.id === "agent-primary-instruction");
  const agentMcpCheck = normalizeAgentMcpCheck(options, agentMcpDoctorCheck, targetBase);
  checks.push(agentMcpCheck);
  const agentInstructionCheck = normalizeAgentInstructionCheck(options, agentInstructionDoctorCheck);
  checks.push(agentInstructionCheck);

  const mcpCli = descriptorProbe.status === "pass"
    ? await probeDirectMcpRuntime(options)
    : notCheckedMcpRuntime("runtime_descriptor_not_active");
  checks.push(normalizeMcpRuntimeCheck(options, mcpCli, descriptorProbe, targetBase));

  const cliReadyBeforeAgentRuntime = !checks.some((check) => check.status === "fail" && check.blocks?.includes("cli"));
  const agentRuntime = await evaluateAgentRuntime(options, verificationTarget, cliReadyBeforeAgentRuntime, targetBase);
  checks.push(agentRuntime.check);

  const readiness = computeReadiness(verificationTarget, checks);
  const { result, nextAction } = selectResultAndAction(verificationTarget, readiness, checks);
  const productError = selectProductError(result, nextAction, checks, descriptorProbe);

  const browser: VerifyBrowser = {
    kind: options.browser,
    channel: options.channel,
    extensionId: options.extensionId,
    extensionIdSource: options.extensionIdSource,
    profile: profileResolution.profile,
    extensionInstalled: profileResolution.extensionInstalled,
    extensionEnabled: profileResolution.extensionEnabled,
    nativeHost: nativeHost.state,
    runtimeDescriptor: descriptorProbe.state,
    resumeRequired: descriptorProbe.status === "fail" && descriptorProbe.result === "needs_browser_popup",
  };
  const browserReasons = { ...profileResolution.reasons };
  if (nativeHost.reason) browserReasons.nativeHost = nativeHost.reason;
  if (descriptorProbe.status === "fail") browserReasons.runtimeDescriptor = descriptorProbe.message;
  if (Object.keys(browserReasons).length > 0) browser.reasons = browserReasons;
  if (descriptorProbe.status === "pass") {
    browser.descriptor = {
      file: descriptorProbe.descriptorFile,
      probe: "getInfo",
      lifecycle: "fresh",
      metadata: descriptorProbe.metadata,
    };
  }

  return {
    schemaVersion: 1,
    command: "verify",
    verificationTarget,
    result,
    readiness,
    agent: {
      id: options.agent,
      ...(options.agentInput ? { input: options.agentInput } : {}),
      mcpConfig: agentMcpSummary(options, agentMcpDoctorCheck, agentMcpCheck),
      instructions: agentInstructionSummary(agentInstructionDoctorCheck, agentInstructionCheck),
      runtimeStatus: agentRuntime.runtimeStatus,
    },
    browser,
    mcpRuntime: {
      cli: mcpCli,
      agentRuntime: agentRuntime.mcpRuntime,
    },
    productError,
    nextAction,
    checks,
  };
}

export function verifyExitCode(report: VerifyReport): number {
  return report.result === "ready" ? 0 : 1;
}

export function formatVerifyReport(report: VerifyReport): string {
  if (report.result === "ready") {
    const backend = report.mcpRuntime.cli.backends[0];
    const descriptor = typeof report.browser.descriptor?.file === "string" ? report.browser.descriptor.file : "descriptor";
    return [
      `open-browser-use is ${report.verificationTarget === "agent_runtime" ? "agent-runtime-ready" : "CLI-ready"}.`,
      `Agent: ${report.agent.id}`,
      `Browser: ${report.browser.kind} ${report.browser.channel === "store" ? "Store extension" : "extension"} ${report.browser.extensionId}`,
      `Backend: ${backend?.type ?? "webextension"} descriptor ${descriptor} responded to getInfo`,
      `MCP runtime: direct probe found ${report.mcpRuntime.cli.backendCount ?? 0} usable backend${report.mcpRuntime.cli.backendCount === 1 ? "" : "s"}`,
      `Agent runtime: ${report.readiness.agentRuntime === "ready" ? "ready" : "not checked"}`,
    ].join("\n");
  }

  if (report.result === "needs_browser_popup") {
    const rerun = report.nextAction?.rerun;
    return [
      "Browser popup required.",
      ...formatProductErrorLine(report.productError),
      "Local setup is correct, but no active WebExtension descriptor exists yet.",
      report.nextAction?.message ?? "Open the open-browser-use extension popup. Click Resume if enabled.",
      ...(rerun ? ["If it already shows Connected, wait briefly and rerun:", `  ${rerun}`] : []),
    ].join("\n");
  }

  if (report.result === "needs_repair") {
    return [
      "Repair required.",
      ...formatProductErrorLine(report.productError),
      report.nextAction?.message ?? "A deterministic open-browser-use repair is available.",
      ...formatVerifyNextActionDetails(report.nextAction),
    ].join("\n");
  }

  return [
    "Manual action required.",
    ...formatProductErrorLine(report.productError),
    report.nextAction?.message ?? "The selected target needs manual action before open-browser-use can verify readiness.",
    ...formatVerifyNextActionDetails(report.nextAction),
  ].join("\n");
}

function formatProductErrorLine(productError: ProductErrorSummary | null): string[] {
  if (!productError) return [];
  return [`State: ${productError.title} (${productError.code}).`];
}

function formatVerifyNextActionDetails(action: VerifyNextAction | null): string[] {
  if (!action) return [];
  const rows: string[] = [];
  if (action.command) rows.push("Run:", `  ${action.command}`);
  if (action.url) rows.push("Open:", `  ${action.url}`);
  if (action.profile) {
    const profile = action.profile.suggestedPath ?? action.profile.path;
    if (profile) rows.push("Profile:", `  ${profile}`);
  }
  if (action.challenge) rows.push("Challenge:", `  ${action.challenge.path}`);
  if (action.trustedHook) rows.push("Trusted hook:", `  ${action.trustedHook.id} (${action.trustedHook.transport})`);
  if (action.rerun) rows.push("Rerun:", `  ${action.rerun}`);
  return rows;
}

function baseTarget(options: VerifyOptions): VerifyTarget {
  return {
    agent: options.agent,
    browser: options.browser,
    channel: options.channel,
    extensionId: options.extensionId,
    ...(options.profile ? { profile: options.profile } : {}),
  };
}

async function checkCliInstall(options: VerifyOptions, target: VerifyTarget): Promise<VerifyCheck> {
  const version = await packageVersion();
  const versionLooksValid = /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version);
  const expectedCommand = options.layout.openBrowserUseCommand;
  const packagedCommandOk = options.layout.mode !== "packaged" || await executableExists(expectedCommand);
  if (!versionLooksValid || !packagedCommandOk) {
    const message = !versionLooksValid
      ? "obu version is not parseable"
      : `packaged obu command is not executable at ${expectedCommand}`;
    return failCheck({
      id: "cli-version",
      layer: "cli_install",
      reason: "cli_not_runnable",
      message,
      target,
      evidence: expectedEvidence("cli_version"),
      productError: "setup_missing",
      actionCandidate: {
        result: "needs_manual_action",
        kind: "install_cli",
        priority: manualActionPriority.install_cli,
        message: "Install or repair the open-browser-use CLI, then rerun verify.",
      },
    });
  }
  return passCheck({
    id: "cli-version",
    layer: "cli_install",
    message: "obu version is parseable",
    target: {},
    evidence: expectedEvidence("cli_version"),
    details: { version },
  });
}

function targetSupportCheck(options: VerifyOptions, supported: boolean, target: VerifyTarget): VerifyCheck {
  if (supported) {
    return passCheck({
      id: "target-support",
      layer: "target_support",
      message: "verification target is supported by this build",
      target,
      evidence: expectedEvidence("target_registry"),
      details: { platform: process.platform, browser: options.browser },
    });
  }
  return failCheck({
    id: "target-support",
    layer: "target_support",
    reason: "unsupported_browser",
    message: `browser target ${options.browser} is not supported on ${process.platform}`,
    target,
    evidence: expectedEvidence("target_registry"),
    actionCandidate: {
      result: "needs_manual_action",
      kind: "unsupported",
      priority: manualActionPriority.unsupported,
      message: `open-browser-use cannot verify ${options.browser} on ${process.platform} in this build.`,
    },
  });
}

async function checkNativeHost(options: VerifyOptions, homeDir: string, target: VerifyTarget): Promise<{
  check: VerifyCheck;
  state: ComponentState;
  reason?: string;
}> {
  const manifestPath = path.join(nativeMessagingHostDir(options.browser, process.platform, homeDir), `${HOST_NAME}.json`);
  const manifest = await readJson(manifestPath).catch(() => undefined);
  const command = repairCommand(options);
  const expectedWrapperPath = nativeHostWrapperPath({
    nativeHostInstallRoot: options.layout.nativeHostInstallRoot,
    browser: options.browser,
  });
  if (!isRecord(manifest)) {
    return {
      state: "missing",
      reason: `native host manifest missing or invalid at ${manifestPath}`,
      check: failCheck({
        id: "native-host-manifest",
        layer: "native_host",
        reason: "native_host_manifest_missing",
        message: `native host manifest missing or invalid at ${manifestPath}`,
        target,
        evidence: expectedEvidence("native_host_manifest"),
        details: { path: manifestPath },
        productError: "native_host_broken",
        actionCandidate: repairAction(command, "Repair the native host manifest for the selected browser and extension."),
      }),
    };
  }

  const issues: string[] = [];
  const allowedOrigin = `chrome-extension://${options.extensionId}/`;
  if (manifest.name !== HOST_NAME) issues.push(`name must be ${HOST_NAME}`);
  if (manifest.type !== "stdio") issues.push("type must be stdio");
  if (typeof manifest.path !== "string" || !path.isAbsolute(manifest.path)) issues.push("path must be absolute");
  if (typeof manifest.path === "string" && path.isAbsolute(manifest.path) && !samePath(manifest.path, expectedWrapperPath)) {
    issues.push(`path must be the open-browser-use managed wrapper: ${expectedWrapperPath}`);
  }
  if (!Array.isArray(manifest.allowed_origins) || !manifest.allowed_origins.includes(allowedOrigin)) {
    issues.push(`allowed_origins must include ${allowedOrigin}`);
  }
  if (typeof manifest.path === "string" && !await access(manifest.path, constants.X_OK).then(() => true).catch(() => false)) {
    issues.push(`native host path is not executable: ${manifest.path}`);
  }
  if (!await access(options.layout.hostBin, constants.X_OK).then(() => true).catch(() => false)) {
    issues.push(`obu-host is not executable: ${options.layout.hostBin}`);
  }
  if (typeof manifest.path === "string" && path.isAbsolute(manifest.path) && samePath(manifest.path, expectedWrapperPath)) {
    const expectedWrapper = nativeHostWrapperContent({
      hostBin: options.layout.hostBin,
      browser: options.browser,
      runtimeDir: options.layout.runtimeDir,
    });
    const actualWrapper = await readFile(expectedWrapperPath, "utf8").catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      issues.push(`native host wrapper cannot be read: ${nodeError.message ?? String(error)}`);
      return undefined;
    });
    if (actualWrapper !== undefined && actualWrapper !== expectedWrapper) {
      issues.push(`native host wrapper is stale: ${expectedWrapperPath}`);
    }
  }
  if (issues.length > 0) {
    return {
      state: "invalid",
      reason: issues.join("; "),
      check: failCheck({
        id: "native-host-manifest",
        layer: "native_host",
        reason: "native_host_manifest_invalid",
        message: issues.join("; "),
        target,
        evidence: expectedEvidence("native_host_manifest"),
        details: { path: manifestPath, expectedWrapperPath, issues },
        productError: "native_host_broken",
        actionCandidate: repairAction(command, "Repair the native host manifest for the selected browser and extension."),
      }),
    };
  }
  return {
    state: "pass",
    check: passCheck({
      id: "native-host-manifest",
      layer: "native_host",
      message: `native host allows ${allowedOrigin}`,
      target,
      evidence: expectedEvidence("native_host_manifest"),
      details: { path: manifestPath, expectedWrapperPath },
    }),
  };
}

async function resolveBrowserProfile(
  options: VerifyOptions,
  homeDir: string,
  descriptor: RuntimeDescriptorProbe,
  target: VerifyTarget,
): Promise<ProfileResolution> {
  if (options.profile) {
    return resolveExplicitProfile(options, descriptor, target);
  }
  const root = browserProfileRoot(options.browser, process.platform, homeDir);
  const rootStats = await lstat(root).catch((error) => error as NodeJS.ErrnoException);
  if (rootStats instanceof Error || !rootStats.isDirectory()) {
    const reason = rootStats instanceof Error && rootStats.code !== "ENOENT" ? "profile_root_unreadable" : "profile_root_missing";
    const message = rootStats instanceof Error && rootStats.code !== "ENOENT"
      ? `browser profile root cannot be inspected: ${root}`
      : `browser profile root not found at ${root}`;
    return profileResolution({
      profile: {
        path: null,
        suggestedPath: null,
        source: "default_discovery",
        runtimeBinding: "not_available",
        candidates: [],
      },
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        extensionInstalled: "no browser profile can be inspected",
        extensionEnabled: "no browser profile can be inspected",
      },
      checks: [
        failCheck({
          id: "browser-profile",
          layer: "browser_profile",
          reason,
          message,
          target,
          evidence: expectedEvidence("profile_discovery"),
          details: { root },
          productError: "setup_missing",
          actionCandidate: selectProfileAction(options, null, "Select or create the browser profile to verify."),
        }),
      ],
    });
  }

  const profilePaths = await defaultProfileCandidates(root);
  const candidates = await Promise.all(profilePaths.map((candidate) => inspectProfileCandidate(candidate, options.extensionId)));
  if (candidates.length === 0) {
    return profileResolution({
      profile: {
        path: null,
        suggestedPath: null,
        source: "default_discovery",
        runtimeBinding: "not_available",
        candidates: [],
      },
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        extensionInstalled: "no browser profile can be inspected",
        extensionEnabled: "no browser profile can be inspected",
      },
      checks: [
        failCheck({
          id: "browser-profile",
          layer: "browser_profile",
          reason: "profile_root_empty",
          message: `no inspectable browser profiles found under ${root}`,
          target,
          evidence: expectedEvidence("profile_discovery"),
          details: { root },
          productError: "setup_missing",
          actionCandidate: selectProfileAction(options, null, "Select or create the browser profile to verify."),
        }),
      ],
    });
  }

  const inspectable = candidates.filter((candidate) => candidate.profileExists === "pass");
  const matching = inspectable.filter((candidate) => candidate.extensionInstalled === "pass");
  const enabledMatching = matching.filter((candidate) => candidate.extensionEnabled === "pass");
  const descriptorProfile = descriptor.status === "pass" ? descriptor.profilePath : undefined;
  const profileVerified = descriptorProfile
    ? matching.find((candidate) => samePath(candidate.path, descriptorProfile))
    : undefined;
  const resolved = profileVerified
    ?? (matching.length === 1 ? matching[0] : undefined)
    ?? (inspectable.length === 1 ? inspectable[0] : undefined);

  if (matching.length > 1 && !profileVerified) {
    const suggested = (enabledMatching[0] ?? matching[0])?.path ?? null;
    return profileResolution({
      profile: {
        path: null,
        suggestedPath: suggested,
        source: "default_discovery",
        runtimeBinding: descriptor.status === "pass" ? "browser_extension_scope" : "not_available",
        candidates,
      },
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        extensionInstalled: "multiple matching profiles require an explicit profile selection",
        extensionEnabled: "multiple matching profiles require an explicit profile selection",
      },
      checks: [
        failCheck({
          id: "browser-profile",
          layer: "browser_profile",
          reason: "multiple_matching_profiles",
          message: "multiple browser profiles contain the selected extension; select one explicitly",
          target,
          evidence: expectedEvidence("profile_discovery"),
          details: { candidates, suggestedPath: suggested },
          productError: "setup_missing",
          actionCandidate: selectProfileAction(options, suggested, "Select the browser profile to verify before continuing."),
        }),
      ],
    });
  }

  if (!resolved) {
    const suggested = inspectable[0]?.path ?? null;
    return profileResolution({
      profile: {
        path: null,
        suggestedPath: suggested,
        source: "default_discovery",
        runtimeBinding: "not_available",
        candidates,
      },
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        extensionInstalled: "profile choice is ambiguous before extension installation can be checked",
        extensionEnabled: "profile choice is ambiguous before extension installation can be checked",
      },
      checks: [
        failCheck({
          id: "browser-profile",
          layer: "browser_profile",
          reason: "multiple_profiles_without_extension",
          message: "multiple browser profiles were found, but none contains the selected extension",
          target,
          evidence: expectedEvidence("profile_discovery"),
          details: { candidates, suggestedPath: suggested },
          productError: "setup_missing",
          actionCandidate: selectProfileAction(options, suggested, "Choose the intended browser profile before installing the extension."),
        }),
      ],
    });
  }

  const runtimeBinding = runtimeBindingForResolvedProfile({
    options,
    descriptor,
    candidate: resolved,
    source: "default_discovery",
    matchingCount: matching.length,
    explicit: false,
  });
  const checks: VerifyCheck[] = [
    passCheck({
      id: "browser-profile",
      layer: "browser_profile",
      message: profileVerified
        ? "resolved profile from runtime descriptor evidence"
        : matching.length === 1
          ? "resolved one matching browser profile"
          : "resolved the only inspectable browser profile",
      target: { ...target, profile: resolved.path },
      evidence: expectedEvidence("profile_discovery"),
      details: { candidates },
    }),
  ];
  return resolvedProfileResolution(options, resolved, candidates, "default_discovery", runtimeBinding, checks);
}

async function resolveExplicitProfile(
  options: VerifyOptions,
  descriptor: RuntimeDescriptorProbe,
  target: VerifyTarget,
): Promise<ProfileResolution> {
  const profilePath = options.profile!;
  const candidate = await inspectProfileCandidate(profilePath, options.extensionId);
  if (candidate.profileExists !== "pass") {
    const reason = candidate.profileExists === "missing" ? "profile_missing" : "profile_unreadable";
    const message = candidate.profileExists === "missing"
      ? `explicit profile path does not exist: ${profilePath}`
      : `explicit profile path cannot be inspected: ${profilePath}`;
    return profileResolution({
      profile: {
        path: profilePath,
        suggestedPath: null,
        source: "explicit",
        runtimeBinding: "not_available",
        candidates: [candidate],
      },
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        extensionInstalled: "extension state cannot be inspected until the profile exists and is readable",
        extensionEnabled: "extension state cannot be inspected until the profile exists and is readable",
      },
      checks: [
        failCheck({
          id: "browser-profile",
          layer: "browser_profile",
          reason,
          message,
          target: { ...target, profile: profilePath },
          evidence: expectedEvidence("profile_discovery"),
          details: { candidate },
          productError: "setup_missing",
          actionCandidate: selectProfileAction(options, profilePath, "Select a readable browser profile to verify."),
        }),
      ],
    });
  }

  const runtimeBinding = runtimeBindingForResolvedProfile({
    options,
    descriptor,
    candidate,
    source: "explicit",
    matchingCount: candidate.extensionInstalled === "pass" ? 1 : 0,
    explicit: true,
  });
  const checks: VerifyCheck[] = [
    passCheck({
      id: "browser-profile",
      layer: "browser_profile",
      message: "using explicit browser profile",
      target: { ...target, profile: profilePath },
      evidence: expectedEvidence("profile_discovery"),
      details: { candidate },
    }),
  ];
  if (descriptor.status === "pass" && runtimeBinding === "browser_extension_scope") {
    checks.push(warnCheck({
      id: "browser-profile-runtime-binding",
      layer: "browser_profile",
      reason: "profile_runtime_not_bound",
      message: "runtime descriptor proves browser and extension identity, but not the explicit profile identity",
      target: { ...target, profile: profilePath },
      evidence: runtimeEvidence("runtime_descriptor_probe"),
      details: { runtimeBinding },
    }));
  }
  return resolvedProfileResolution(options, candidate, [candidate], "explicit", runtimeBinding, checks);
}

function resolvedProfileResolution(
  options: VerifyOptions,
  resolved: ProfileCandidate,
  candidates: ProfileCandidate[],
  source: "explicit" | "default_discovery",
  runtimeBinding: RuntimeBinding,
  checks: VerifyCheck[],
): ProfileResolution {
  if (resolved.extensionInstalled !== "pass") {
    const reasons = {
      extensionInstalled: resolved.reasons?.extensionInstalled ?? `extension ${options.extensionId} is not installed in the resolved profile`,
      extensionEnabled: resolved.reasons?.extensionEnabled ?? "enablement was not inspected because the extension is missing",
    };
    return profileResolution({
      profile: {
        path: resolved.path,
        suggestedPath: null,
        source,
        runtimeBinding,
        candidates,
      },
      extensionInstalled: "missing",
      extensionEnabled: "not_checked",
      reasons,
      checks,
    });
  }
  if (resolved.extensionEnabled !== "pass") {
    const reasons = {
      extensionEnabled: resolved.reasons?.extensionEnabled ?? "extension is present but disabled in the resolved profile",
    };
    return profileResolution({
      profile: {
        path: resolved.path,
        suggestedPath: null,
        source,
        runtimeBinding,
        candidates,
      },
      extensionInstalled: "pass",
      extensionEnabled: "disabled",
      reasons,
      checks,
    });
  }
  return profileResolution({
    profile: {
      path: resolved.path,
      suggestedPath: null,
      source,
      runtimeBinding,
      candidates,
    },
    extensionInstalled: "pass",
    extensionEnabled: "pass",
    reasons: {},
    checks,
  });
}

function profileResolution(input: ProfileResolution): ProfileResolution {
  return input;
}

function browserExtensionCheck(options: VerifyOptions, resolution: ProfileResolution, target: VerifyTarget): VerifyCheck {
  const profile = resolution.profile.path;
  if (!profile) {
    return notCheckedCheck({
      id: "browser-extension-installed",
      layer: "browser_extension",
      reason: "profile_not_resolved",
      message: "extension installation was not checked because profile selection is ambiguous",
      target,
      evidence: expectedEvidence("profile_preferences"),
    });
  }
  if (resolution.extensionInstalled !== "pass") {
    return failCheck({
      id: "browser-extension-installed",
      layer: "browser_extension",
      reason: "extension_missing",
      message: `extension ${options.extensionId} is not installed in the resolved profile`,
      target: { ...target, profile },
      evidence: expectedEvidence("profile_preferences"),
      productError: "setup_missing",
      actionCandidate: {
        result: "needs_manual_action",
        kind: "install_extension",
        priority: manualActionPriority.install_extension,
        message: `Install extension ${options.extensionId} in the resolved browser profile, then rerun verify.`,
        browser: options.browser,
        profile: { path: profile },
        rerun: verifyCommand(options),
      },
    });
  }
  if (resolution.extensionEnabled !== "pass") {
    return failCheck({
      id: "browser-extension-installed",
      layer: "browser_extension",
      reason: "extension_disabled",
      message: `extension ${options.extensionId} is installed but disabled in the resolved profile`,
      target: { ...target, profile },
      evidence: expectedEvidence("profile_preferences"),
      productError: "setup_missing",
      actionCandidate: {
        result: "needs_manual_action",
        kind: "enable_extension",
        priority: manualActionPriority.enable_extension,
        message: `Enable extension ${options.extensionId} in the resolved browser profile, then rerun verify.`,
        browser: options.browser,
        profile: { path: profile },
        rerun: verifyCommand(options),
      },
    });
  }
  return passCheck({
    id: "browser-extension-installed",
    layer: "browser_extension",
    message: "extension is installed and enabled in the resolved profile",
    target: { ...target, profile },
    evidence: expectedEvidence("profile_preferences"),
  });
}

function runtimeChecksFromProbe(
  options: VerifyOptions,
  descriptor: RuntimeDescriptorProbe,
  profile: string | null,
  target: VerifyTarget,
): VerifyCheck[] {
  const runtimeTarget = { ...target, ...(profile ? { profile } : {}) };
  if (descriptor.status === "pass") {
    return [
      passCheck({
        id: "extension-runtime",
        layer: "extension_runtime",
        message: "extension runtime inferred active from descriptor probe",
        target: runtimeTarget,
        evidence: runtimeEvidence("runtime_descriptor_probe"),
        details: { source: "runtime_descriptor_probe" },
      }),
      passCheck({
        id: "runtime-descriptor-probe",
        layer: "runtime_descriptor",
        message: descriptor.message,
        target: runtimeTarget,
        evidence: runtimeEvidence("runtime_descriptor_probe"),
        details: descriptor.details,
      }),
    ];
  }

  const candidate: ActionCandidate = descriptor.result === "needs_browser_popup"
    ? openPopupAction(options, profile)
    : repairAction(repairCommand(options), descriptor.message);
  return [
    failCheck({
      id: "extension-runtime",
      layer: "extension_runtime",
      reason: "runtime_descriptor_not_active",
      message: "extension runtime is not active from CLI-observable evidence",
      target: runtimeTarget,
      evidence: runtimeEvidence("runtime_descriptor_probe"),
      details: { source: "runtime_descriptor_probe" },
      productError: descriptor.productError,
      actionCandidate: candidate,
    }),
    failCheck({
      id: "runtime-descriptor-probe",
      layer: "runtime_descriptor",
      reason: descriptor.reason,
      message: descriptor.message,
      target: runtimeTarget,
      evidence: runtimeEvidence("runtime_descriptor_probe"),
      actionCandidate: candidate,
      productError: descriptor.productError,
      ...(descriptor.details ? { details: descriptor.details } : {}),
    }),
  ];
}

function normalizeAgentMcpCheck(
  options: VerifyOptions,
  doctorCheck: AgentDoctorCheck | undefined,
  target: VerifyTarget,
): VerifyCheck {
  if (!doctorCheck) {
    return failCheck({
      id: "agent-mcp-server",
      layer: "agent_mcp",
      reason: "agent_mcp_not_checked",
      message: "agent MCP configuration was not checked",
      target: { agent: options.agent },
      evidence: expectedEvidence("agent_config_read"),
      productError: "setup_missing",
      actionCandidate: configureAgentAction(options, "Configure the selected agent with the open-browser-use MCP server."),
    });
  }
  if (doctorCheck.status === "pass") {
    return passCheck({
      id: "agent-mcp-server",
      layer: "agent_mcp",
      message: doctorCheck.message,
      target: { agent: options.agent },
      evidence: expectedEvidence("agent_config_read"),
      ...(doctorCheck.details ? { details: doctorCheck.details } : {}),
    });
  }
  if (doctorCheck.status === "warn") {
    return failCheck({
      id: "target-agent-mcp-support",
      layer: "target_support",
      reason: "agent_mcp_check_not_implemented",
      message: doctorCheck.message,
      target: { agent: options.agent },
      evidence: expectedEvidence("agent_config_read"),
      actionCandidate: {
        result: "needs_manual_action",
        kind: "unsupported",
        priority: manualActionPriority.unsupported,
        message: `Automatic MCP verification is not implemented for ${options.agent}. Configure the open-browser-use MCP server manually and verify from inside that agent.`,
        command: mcpConfigCommand(options),
      },
      ...(doctorCheck.details ? { details: doctorCheck.details } : {}),
    });
  }
  const conflict = /different settings|could not be read|could not be parsed/i.test(doctorCheck.message);
  const executableMissing = /was not found on PATH/i.test(doctorCheck.message);
  const directConfigRepairable = options.agent === "codex-cli" && executableMissing;
  return failCheck({
    id: "agent-mcp-server",
    layer: "agent_mcp",
    reason: conflict ? "config_conflict" : directConfigRepairable ? "agent_mcp_missing" : executableMissing ? "agent_executable_missing" : "agent_mcp_missing",
    message: doctorCheck.message,
    target: { agent: options.agent },
    evidence: expectedEvidence("agent_config_read"),
    productError: "setup_missing",
    actionCandidate: conflict
      ? {
        result: "needs_manual_action",
        kind: "resolve_config_conflict",
        priority: manualActionPriority.resolve_config_conflict,
        message: "Review the selected agent MCP config and keep the intended open-browser-use command.",
        command: mcpConfigCommand(options),
      }
      : directConfigRepairable
        ? repairAction(repairCommand(options), "Configure codex-cli with the expected open-browser-use MCP server.")
        : executableMissing
        ? configureAgentAction(options, "Install the selected agent CLI or configure its MCP server manually.")
        : repairAction(repairCommand(options), "Configure the selected agent with the expected open-browser-use MCP server."),
    ...(doctorCheck.details ? { details: doctorCheck.details } : {}),
  });
}

function normalizeAgentInstructionCheck(options: VerifyOptions, doctorCheck: AgentDoctorCheck | undefined): VerifyCheck {
  if (!doctorCheck) {
    return warnCheck({
      id: "agent-primary-instruction",
      layer: "agent_instruction",
      reason: "not_implemented",
      message: `instruction check is not implemented for ${options.agent}`,
      target: { agent: options.agent },
      evidence: expectedEvidence("agent_instruction_file"),
    });
  }
  if (doctorCheck.status === "pass") {
    return passCheck({
      id: "agent-primary-instruction",
      layer: "agent_instruction",
      message: "primary browser instruction found",
      target: { agent: options.agent },
      evidence: expectedEvidence("agent_instruction_file"),
      ...(doctorCheck.details ? { details: doctorCheck.details } : {}),
    });
  }
  const reason = doctorCheck.status === "warn" ? "not_implemented" : "missing_instruction";
  return warnCheck({
    id: "agent-primary-instruction",
    layer: "agent_instruction",
    reason,
    message: doctorCheck.message,
    target: { agent: options.agent },
    evidence: expectedEvidence("agent_instruction_file"),
    ...(doctorCheck.details ? { details: doctorCheck.details } : {}),
  });
}

function normalizeMcpRuntimeCheck(
  options: VerifyOptions,
  runtime: McpRuntimeStatus,
  descriptor: RuntimeDescriptorProbe,
  target: VerifyTarget,
): VerifyCheck {
  if (runtime.source === "not_checked") {
    return notCheckedCheck({
      id: "mcp-runtime-backend",
      layer: "mcp_runtime",
      reason: runtime.reason ?? "not_checked",
      message: "direct MCP probe was not run",
      target,
      evidence: expectedEvidence("direct_mcp_probe"),
      ...(runtime.details ? { details: runtime.details } : {}),
    });
  }
  if (runtime.mcpStarts && runtime.sdkBootstrap === "available" && (runtime.backendCount ?? 0) > 0) {
    return passCheck({
      id: "mcp-runtime-backend",
      layer: "mcp_runtime",
      message: `direct MCP probe found ${runtime.backendCount} usable backend${runtime.backendCount === 1 ? "" : "s"}`,
      target,
      evidence: expectedEvidence("direct_mcp_probe"),
      ...(runtime.details ? { details: runtime.details } : {}),
    });
  }
  const popupBoundary = descriptor.status === "fail" && descriptor.result === "needs_browser_popup";
  return failCheck({
    id: "mcp-runtime-backend",
    layer: "mcp_runtime",
    reason: popupBoundary ? "zero_backends_after_popup_boundary" : runtime.reason ?? "mcp_runtime_not_ready",
    message: runtime.reason ?? "direct MCP probe did not find a usable backend",
    target,
    evidence: expectedEvidence("direct_mcp_probe"),
    productError: productErrorForMcpRuntime(runtime, popupBoundary),
    actionCandidate: popupBoundary
      ? openPopupAction(options, target.profile ?? null)
      : repairAction(repairCommand(options), "Repair the open-browser-use MCP runtime and browser backend setup."),
    ...(runtime.details ? { details: runtime.details } : {}),
  });
}

async function evaluateAgentRuntime(
  options: VerifyOptions,
  verificationTarget: VerificationTarget,
  cliReady: boolean,
  target: VerifyTarget,
): Promise<{ runtimeStatus: AgentRuntimeStatus; mcpRuntime: McpRuntimeStatus; check: VerifyCheck }> {
  if (verificationTarget === "cli") {
    const runtimeStatus: AgentRuntimeStatus = {
      status: "not_checked",
      provenance: "not_applicable",
      reason: "verification_target_cli",
    };
    return {
      runtimeStatus,
      mcpRuntime: notCheckedAgentRuntimeMcp("verification_target_cli"),
      check: notCheckedCheck({
        id: "agent-runtime-status",
        layer: "agent_runtime",
        reason: "verification_target_cli",
        message: "agent-runtime status was not requested",
        target: { agent: options.agent },
        evidence: {
          scope: "agent_runtime",
          provenance: "not_applicable",
          source: "verification_target_cli",
        },
      }),
    };
  }

  if (!cliReady) {
    const runtimeStatus: AgentRuntimeStatus = {
      status: "not_checked",
      provenance: "not_applicable",
      reason: "cli_readiness_blocked",
    };
    return {
      runtimeStatus,
      mcpRuntime: notCheckedAgentRuntimeMcp("cli_readiness_blocked"),
      check: notCheckedCheck({
        id: "agent-runtime-status",
        layer: "agent_runtime",
        reason: "cli_readiness_blocked",
        message: "agent-runtime status was not checked because CLI readiness is blocked",
        target: { agent: options.agent },
        evidence: {
          scope: "agent_runtime",
          provenance: "not_applicable",
          source: "cli_readiness_blocked",
        },
      }),
    };
  }

  const hook = trustedRuntimeHook(options.agent);

  if (options.agentRuntimeStatusJson) {
    const diagnostic = await diagnosticStatusFileBinding(options);
    const runtimeStatus: AgentRuntimeStatus = {
      status: "not_checked",
      provenance: "user_supplied_status_file",
      reason: "diagnostic_status_file_not_trusted",
      diagnostic,
    };
    return {
      runtimeStatus,
      mcpRuntime: {
        source: "agent_runtime_status_file",
        provenance: "user_supplied_status_file",
        probeCommandSource: "user_supplied_status_file",
        mcpConfigured: true,
        mcpStarts: null,
        sdkBootstrap: "not_checked",
        backendCount: null,
        backends: [],
        reason: "diagnostic_status_file_not_trusted",
      },
      check: failCheck({
        id: "agent-runtime-status",
        layer: "agent_runtime",
        reason: "diagnostic_status_file_not_trusted",
        message: "user-supplied agent runtime status files are diagnostic only",
        target: { ...target, agent: options.agent },
        evidence: {
          scope: "agent_runtime",
          provenance: "user_supplied_status_file",
          source: "agent_runtime_status_file",
        },
        blocks: ["agent_runtime"],
        productError: "setup_missing",
        actionCandidate: hook
          ? collectAgentRuntimeAction(options, hook, options.agentRuntimeChallengeOut, "Collect agent-runtime status through the trusted OBU hook.")
          : agentRuntimeHookUnavailableAction(options, "This build cannot prove readiness from inside the selected running agent process."),
      }),
    };
  }

  if (!hook) {
    const reason = "agent_runtime_hook_unavailable";
    const message = `no trusted agent-runtime hook is registered for ${options.agent}`;
    const runtimeStatus: AgentRuntimeStatus = {
      status: "not_checked",
      provenance: "not_applicable",
      reason,
    };
    return {
      runtimeStatus,
      mcpRuntime: notCheckedAgentRuntimeMcp(reason),
      check: failCheck({
        id: "agent-runtime-status",
        layer: "agent_runtime",
        reason,
        message,
        target: { ...target, agent: options.agent },
        evidence: {
          scope: "agent_runtime",
          provenance: "not_applicable",
          source: "agent_runtime_hook_registry",
        },
        blocks: ["agent_runtime"],
        productError: "setup_missing",
        actionCandidate: agentRuntimeHookUnavailableAction(options, "This build cannot prove readiness from inside the selected running agent process."),
      }),
    };
  }

  let challengePath = options.agentRuntimeChallengeOut;
  if (challengePath) {
    await writeAgentRuntimeChallenge(challengePath, options, hook);
  }

  if (options.agentRuntimeChallengeJson) {
    const trustedResult = await readTrustedRuntimeHookResult(options, hook);
    if (trustedResult.status === "pass") {
      return {
        runtimeStatus: trustedResult.runtimeStatus,
        mcpRuntime: trustedResult.mcpRuntime,
        check: passCheck({
          id: "agent-runtime-status",
          layer: "agent_runtime",
          message: "trusted agent-runtime hook reported a usable browser backend",
          target: { ...target, agent: options.agent },
          evidence: {
            scope: "agent_runtime",
            provenance: "agent_runtime_hook",
            source: "agent_runtime_hook",
          },
          details: trustedResult.details,
        }),
      };
    }
    const runtimeStatus = isRecord(trustedResult.details?.runtimeStatus)
      ? { ...trustedResult.details.runtimeStatus, reason: trustedResult.reason } as AgentRuntimeStatus
      : {
        status: "not_checked",
        provenance: "not_applicable",
        reason: trustedResult.reason,
        ...(hook ? { trustedHook: hook } : {}),
      } satisfies AgentRuntimeStatus;
    const evidenceProvenance: EvidenceProvenance = runtimeStatus.provenance === "agent_runtime_hook" ? "agent_runtime_hook" : "not_applicable";
    return {
      runtimeStatus,
      mcpRuntime: trustedResult.status === "fail" ? trustedResult.mcpRuntime : notCheckedAgentRuntimeMcp(trustedResult.reason),
      check: failCheck({
        id: "agent-runtime-status",
        layer: "agent_runtime",
        reason: trustedResult.reason,
        message: trustedResult.message,
        target: { ...target, agent: options.agent },
        evidence: {
          scope: "agent_runtime",
          provenance: evidenceProvenance,
          source: evidenceProvenance === "agent_runtime_hook" ? "agent_runtime_hook" : "agent_runtime_hook_registry",
        },
        blocks: ["agent_runtime"],
        productError: trustedResult.status === "fail" ? trustedResult.productError ?? "setup_missing" : "setup_missing",
        actionCandidate: collectAgentRuntimeAction(options, hook, options.agentRuntimeChallengeJson, "Collect agent-runtime status through the trusted OBU hook."),
        ...(trustedResult.details ? { details: trustedResult.details } : {}),
      }),
    };
  }

  const reason = challengePath ? "agent_runtime_challenge_issued" : "agent_runtime_status_unavailable";
  const runtimeStatus: AgentRuntimeStatus = {
    status: "not_checked",
    provenance: "not_applicable",
    reason,
    ...(hook ? { trustedHook: hook } : {}),
  };
  return {
    runtimeStatus,
    mcpRuntime: notCheckedAgentRuntimeMcp(reason),
    check: failCheck({
      id: "agent-runtime-status",
      layer: "agent_runtime",
      reason,
      message: challengePath
        ? "agent-runtime challenge was issued; status has not been returned by a trusted hook"
        : "agent-runtime status is unavailable from this CLI process",
      target: { ...target, agent: options.agent },
      evidence: {
        scope: "agent_runtime",
        provenance: "not_applicable",
        source: "agent_runtime_hook_registry",
      },
      blocks: ["agent_runtime"],
      productError: "setup_missing",
      actionCandidate: collectAgentRuntimeAction(options, hook, challengePath, "Collect agent-runtime status through the trusted OBU hook."),
    }),
  };
}

async function probeDirectMcpRuntime(options: VerifyOptions): Promise<McpRuntimeStatus> {
  if (!await executableExists(options.server.command)) {
    return {
      source: "direct_mcp_probe",
      provenance: "expected_obu_invocation",
      probeCommandSource: "expected_obu_invocation",
      mcpConfigured: true,
      mcpStarts: false,
      sdkBootstrap: "not_checked",
      backendCount: 0,
      backends: [],
      reason: `MCP command is not executable: ${options.server.command}`,
      details: { command: options.server.command, args: options.server.args },
      productError: "setup_missing",
    };
  }

  try {
    const rawStatus = await runMcpBrowserStatusProbe(options.server.command, options.server.args, {
      ...process.env,
      ...(options.env ?? {}),
      OBU_RUNTIME_DIR: options.layout.runtimeDir,
    }, options.mcpProbeTimeoutMs ?? DEFAULT_MCP_PROBE_TIMEOUT_MS);
    const rawBackends = Array.isArray(rawStatus.backends) ? rawStatus.backends : [];
    const backends = rawBackends.map((backend) => normalizeBackend(backend, options));
    const usable = backends.filter((backend) => backend.extensionIdentity.verified);
    const sdkBootstrap = typeof rawStatus.sdk_bootstrap === "string" ? rawStatus.sdk_bootstrap : "missing";
    const productError = productErrorFromBrowserStatus(rawStatus, sdkBootstrap, usable.length);
    return {
      source: "direct_mcp_probe",
      provenance: "expected_obu_invocation",
      probeCommandSource: "expected_obu_invocation",
      mcpConfigured: true,
      mcpStarts: true,
      sdkBootstrap,
      backendCount: usable.length,
      backends: usable,
      ...(sdkBootstrap !== "available" ? { reason: `sdk bootstrap is ${sdkBootstrap}` } : usable.length === 0 ? { reason: "direct MCP probe found zero usable browser backends" } : {}),
      details: { raw: rawStatus },
      ...(productError ? { productError } : {}),
    };
  } catch (error) {
    const productError: ProductErrorCode = error instanceof McpProbeTimeoutError ? "timeout" : "transport_closed";
    return {
      source: "direct_mcp_probe",
      provenance: "expected_obu_invocation",
      probeCommandSource: "expected_obu_invocation",
      mcpConfigured: true,
      mcpStarts: false,
      sdkBootstrap: "not_checked",
      backendCount: 0,
      backends: [],
      reason: `direct MCP probe failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { command: options.server.command, args: options.server.args },
      productError,
    };
  }
}

class McpProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = "McpProbeTimeoutError";
  }
}

function productErrorFromBrowserStatus(
  status: Record<string, any>,
  sdkBootstrap: string,
  backendCount: number,
): ProductErrorCode | undefined {
  const productError = isRecord(status.product_error) && typeof status.product_error.code === "string"
    ? status.product_error.code
    : undefined;
  if (productError && isProductErrorCode(productError)) return productError;
  if (sdkBootstrap !== "available") return "setup_missing";
  if (backendCount === 0) return "no_backend";
  return undefined;
}

function runMcpBrowserStatusProbe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    const pending = new Map<number, (value: RpcResponse) => void>();
    const timer = setTimeout(() => {
      finish(new McpProbeTimeoutError(timeoutMs));
    }, Math.max(1, timeoutMs));
    const finish = (result: Error | Record<string, any>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const send = (payload: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<RpcResponse>((requestResolve) => {
      pending.set(id, requestResolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
    child.once("error", (error) => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const index = stdoutBuffer.indexOf("\n");
        if (index < 0) break;
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line.length === 0) continue;
        let message: RpcResponse;
        try {
          message = JSON.parse(line);
        } catch (error) {
          finish(new Error(`invalid MCP JSON response: ${String(error)}`));
          return;
        }
        const id = typeof message.id === "number" ? message.id : undefined;
        if (id !== undefined) {
          const resolver = pending.get(id);
          if (resolver) {
            pending.delete(id);
            resolver(message);
          }
        }
      }
    });
    child.once("exit", (code) => {
      if (!settled && code !== 0) finish(new Error(`MCP process exited with code ${code}; stderr: ${stderr.trim()}`));
    });

    (async () => {
      const init = await request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "obu-verify", version: "0.0.0" },
      });
      if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const status = await request(2, "tools/call", {
        name: "browser_status",
        arguments: {},
      });
      if (status.error) throw new Error(`browser_status failed: ${JSON.stringify(status.error)}`);
      const structured = status.result?.structuredContent;
      if (!isRecord(structured)) throw new Error("browser_status returned no structuredContent");
      finish(structured);
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

async function probeRuntimeDescriptor(options: VerifyOptions, target: VerifyTarget): Promise<RuntimeDescriptorProbe> {
  const descriptorDir = path.join(options.layout.runtimeDir, "webextension");
  const dirStats = await lstat(descriptorDir).catch((error) => error as NodeJS.ErrnoException);
  if (dirStats instanceof Error) {
    if (dirStats.code === "ENOENT") {
      return {
        status: "fail",
        state: "missing",
        reason: "descriptor_dir_missing",
        message: `runtime descriptor directory missing at ${descriptorDir}`,
        result: "needs_repair",
        productError: "setup_missing",
        details: { path: descriptorDir },
      };
    }
    return {
      status: "fail",
      state: "unreadable",
      reason: "descriptor_dir_unreadable",
      message: `runtime descriptor directory cannot be read: ${descriptorDir}`,
      result: "needs_repair",
      productError: "setup_missing",
      details: { path: descriptorDir, error: dirStats.message },
    };
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    return {
      status: "fail",
      state: "invalid",
      reason: "descriptor_dir_invalid",
      message: `runtime descriptor path is not an owner-only directory: ${descriptorDir}`,
      result: "needs_repair",
      productError: "setup_missing",
      details: { path: descriptorDir },
    };
  }
  const ownerIssue = ownerOnlyIssue(dirStats, "runtime descriptor directory");
  if (ownerIssue) {
    return {
      status: "fail",
      state: "invalid",
      reason: "descriptor_dir_permissions",
      message: ownerIssue,
      result: "needs_repair",
      productError: "setup_missing",
      details: { path: descriptorDir },
    };
  }

  const files = (await readdir(descriptorDir).catch(() => [])).filter((entry) => entry.endsWith(".json")).sort();
  if (files.length === 0) {
    return {
      status: "fail",
      state: "missing",
      reason: "descriptor_missing",
      message: "no active WebExtension descriptor found",
      result: "needs_browser_popup",
      productError: "browser_popup_boundary",
      details: {
        resumeRequired: true,
        resumeAction: "open the open-browser-use extension popup; click Resume if it is enabled, otherwise wait for Connected and rerun verify",
      },
    };
  }

  const errors: DescriptorProbeFailure[] = [];
  for (const file of files) {
    const descriptorPath = path.join(descriptorDir, file);
    const fileIssue = await validateDescriptorFile(descriptorPath);
    if (fileIssue) {
      errors.push(descriptorProbeFailure(`${file}: ${fileIssue}`, "stale_descriptor"));
      continue;
    }
    const descriptor = await readJson(descriptorPath).catch((error) => {
      errors.push(descriptorProbeFailure(`${file}: invalid json (${error})`, "stale_descriptor"));
      return undefined;
    });
    if (!isRecord(descriptor)) continue;
    const probe = await probeOneDescriptor(descriptor, descriptorPath, file, options);
    if (probe.status === "pass") return probe;
    errors.push(descriptorProbeFailure(`${file}: ${probe.message}`, probe.productError, probe.result, probe.state));
  }
  const productError = descriptorProductError(errors);

  return {
    status: "fail",
    state: productError === "stale_descriptor" ? "stale" : "invalid",
    reason: "descriptor_unusable",
    message: errors.length > 0 ? errors.map((error) => error.message).join("; ") : "no usable WebExtension descriptor found",
    result: productError === "stale_descriptor" ? "needs_repair" : "needs_browser_popup",
    productError,
    details: {
      resumeRequired: true,
      descriptorErrors: errors.map((error) => error.message),
      descriptorProductErrors: errors.map((error) => error.productError),
    },
  };
}

async function probeOneDescriptor(
  descriptor: Record<string, unknown>,
  descriptorPath: string,
  descriptorFile: string,
  options: VerifyOptions,
): Promise<RuntimeDescriptorProbe> {
  if (descriptor.schema_version !== 1) return descriptorFailure("schema_version must be 1", "stale_descriptor");
  if (descriptor.type !== "webextension") return descriptorFailure("type must be webextension", "stale_descriptor");
  if (typeof descriptor.socketPath !== "string") return descriptorFailure("socketPath missing", "stale_descriptor");
  if (typeof descriptor.sdk_auth_token !== "string") return descriptorFailure("sdk_auth_token missing", "stale_descriptor");
  const processIssue = descriptorProcessIssue(descriptor);
  if (processIssue) return descriptorFailure(processIssue, "stale_descriptor");
  const socketIssue = await validateDescriptorSocket(descriptor.socketPath);
  if (socketIssue) return descriptorFailure(socketIssue, "stale_descriptor");
  try {
    const [auth, info] = await rpcSequenceOverUnixSocket(descriptor.socketPath, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "auth",
        params: { capability_token: descriptor.sdk_auth_token },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "getInfo",
        params: {},
      },
    ]);
    if (auth?.error) return descriptorFailure("auth rejected", "stale_descriptor");
    if (info?.error) return descriptorFailure(`getInfo failed: ${JSON.stringify(info.error)}`, "stale_descriptor");
    if (info?.result?.type !== "webextension") return descriptorFailure("getInfo type mismatch", "stale_descriptor");
    if (info?.result?.name !== descriptor.name) return descriptorFailure("getInfo name mismatch", "stale_descriptor");
    const metadata = mergedDescriptorMetadata(descriptor, info.result);
    const browserKind = stringFromPath(metadata, ["browser_kind"]) ?? String(descriptor.name ?? "");
    const extensionId = stringFromPath(metadata, ["extension_id"]) ?? "unknown";
    if (browserKind !== runtimeBrowserKind(options.browser)) {
      return descriptorFailure(
        `descriptor browser kind ${browserKind || "unknown"} does not match ${runtimeBrowserKind(options.browser)}`,
        "browser_popup_boundary",
        "needs_browser_popup",
      );
    }
    if (extensionId !== options.extensionId) {
      return descriptorFailure(
        `descriptor extension id ${extensionId} does not match ${options.extensionId}`,
        "extension_id_mismatch",
        "needs_browser_popup",
      );
    }
    const profilePath = descriptorProfilePath(metadata);
    return {
      status: "pass",
      state: "pass",
      message: `${descriptorFile} responded to getInfo`,
      descriptorFile,
      descriptorPath,
      metadata,
      browserKind,
      extensionId,
      ...(profilePath ? { profilePath } : {}),
      details: {
        descriptor: descriptorFile,
        descriptorPath,
        source: "runtime_descriptor_probe",
        resumeRequired: false,
        metadata,
      },
    };
  } catch (error) {
    return descriptorFailure(`socket probe failed: ${String(error)}`, "stale_descriptor");
  }
}

type DescriptorProbeFailure = {
  message: string;
  productError: ProductErrorCode;
  result: "needs_repair" | "needs_browser_popup";
  state: ComponentState;
};

function descriptorProbeFailure(
  message: string,
  productError: ProductErrorCode,
  result: "needs_repair" | "needs_browser_popup" = productError === "stale_descriptor" ? "needs_repair" : "needs_browser_popup",
  state: ComponentState = productError === "stale_descriptor" ? "stale" : "invalid",
): DescriptorProbeFailure {
  return { message, productError, result, state };
}

function descriptorProductError(errors: DescriptorProbeFailure[]): ProductErrorCode {
  return errors.find((error) => error.productError === "extension_id_mismatch")?.productError
    ?? errors.find((error) => error.productError === "browser_popup_boundary")?.productError
    ?? errors[0]?.productError
    ?? "stale_descriptor";
}

function descriptorFailure(
  message: string,
  productError: ProductErrorCode,
  result: "needs_repair" | "needs_browser_popup" = productError === "stale_descriptor" ? "needs_repair" : "needs_browser_popup",
): RuntimeDescriptorProbe {
  return {
    status: "fail",
    state: productError === "stale_descriptor" ? "stale" : "invalid",
    reason: "descriptor_invalid",
    message,
    result,
    productError,
  };
}

async function defaultProfileCandidates(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.name === "NativeMessagingHosts") continue;
    if (entry.name === "Default" || /^Profile \d+$/.test(entry.name)) {
      candidates.push(candidate);
      continue;
    }
    if (await access(path.join(candidate, "Preferences"), constants.R_OK).then(() => true).catch(() => false)) {
      candidates.push(candidate);
    }
  }
  return candidates.sort(compareProfilePaths);
}

async function inspectProfileCandidate(profilePath: string, extensionId: string): Promise<ProfileCandidate> {
  const stats = await lstat(profilePath).catch((error) => error as NodeJS.ErrnoException);
  if (stats instanceof Error) {
    const missing = stats.code === "ENOENT";
    return {
      path: profilePath,
      profileExists: missing ? "missing" : "unreadable",
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        profileExists: missing ? "profile path does not exist" : `profile path cannot be inspected: ${stats.message}`,
        extensionInstalled: "extension state cannot be inspected until the profile exists and is readable",
        extensionEnabled: "extension state cannot be inspected until the profile exists and is readable",
      },
    };
  }
  if (!stats.isDirectory()) {
    return {
      path: profilePath,
      profileExists: "unreadable",
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        profileExists: "profile path is not a directory",
        extensionInstalled: "extension state cannot be inspected until the profile path is a readable directory",
        extensionEnabled: "extension state cannot be inspected until the profile path is a readable directory",
      },
    };
  }
  if (!await access(profilePath, constants.R_OK).then(() => true).catch(() => false)) {
    return {
      path: profilePath,
      profileExists: "unreadable",
      extensionInstalled: "not_checked",
      extensionEnabled: "not_checked",
      reasons: {
        profileExists: "profile directory is not readable",
        extensionInstalled: "extension state cannot be inspected until the profile is readable",
        extensionEnabled: "extension state cannot be inspected until the profile is readable",
      },
    };
  }

  const preferenceFiles = [
    path.join(profilePath, "Preferences"),
    path.join(profilePath, "Secure Preferences"),
  ];
  let sawPreferenceFile = false;
  for (const file of preferenceFiles) {
    const preferences = await readJson(file).catch((error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") return undefined;
      return { __obu_read_error: nodeError.message ?? String(error) };
    });
    if (preferences === undefined) continue;
    sawPreferenceFile = true;
    if (isRecord(preferences) && typeof preferences.__obu_read_error === "string") {
      return {
        path: profilePath,
        profileExists: "unreadable",
        extensionInstalled: "not_checked",
        extensionEnabled: "not_checked",
        reasons: {
          profileExists: `profile preferences cannot be read: ${preferences.__obu_read_error}`,
          extensionInstalled: "extension state cannot be inspected until profile preferences are readable",
          extensionEnabled: "extension state cannot be inspected until profile preferences are readable",
        },
      };
    }
    const settings = extensionSettings(preferences, extensionId);
    if (!settings) continue;
    if (settings.state === 0 || hasDisableReasons(settings.disable_reasons)) {
      return {
        path: profilePath,
        profileExists: "pass",
        extensionInstalled: "pass",
        extensionEnabled: "disabled",
        reasons: {
          extensionEnabled: `extension is disabled in ${file}`,
        },
      };
    }
    return {
      path: profilePath,
      profileExists: "pass",
      extensionInstalled: "pass",
      extensionEnabled: "pass",
    };
  }
  return {
    path: profilePath,
    profileExists: "pass",
    extensionInstalled: "missing",
    extensionEnabled: "not_checked",
    reasons: {
      extensionInstalled: sawPreferenceFile
        ? `extension ${extensionId} was not found in profile preferences`
        : "profile preferences do not exist yet",
      extensionEnabled: "enablement was not inspected because the extension is missing",
    },
  };
}

function extensionSettings(preferences: unknown, extensionId: string): Record<string, any> | undefined {
  if (!isRecord(preferences)) return undefined;
  const extensions = preferences.extensions;
  if (!isRecord(extensions)) return undefined;
  const settings = extensions.settings;
  if (!isRecord(settings)) return undefined;
  const extension = settings[extensionId];
  return isRecord(extension) ? extension : undefined;
}

function hasDisableReasons(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function runtimeBindingForResolvedProfile(input: {
  options: VerifyOptions;
  descriptor: RuntimeDescriptorProbe;
  candidate: ProfileCandidate;
  source: "explicit" | "default_discovery";
  matchingCount: number;
  explicit: boolean;
}): RuntimeBinding {
  if (input.descriptor.status !== "pass") return "not_available";
  if (input.descriptor.profilePath && samePath(input.descriptor.profilePath, input.candidate.path)) return "profile_verified";
  if (input.explicit) return "browser_extension_scope";
  if (input.matchingCount === 1) return "single_candidate";
  return "browser_extension_scope";
}

function computeReadiness(verificationTarget: VerificationTarget, checks: VerifyCheck[]): VerifyReport["readiness"] {
  const cliBlocked = checks.some((check) => check.status === "fail" && check.blocks?.includes("cli"));
  const agentRuntimeBlocked = checks.some((check) => check.status === "fail" && check.blocks?.includes("agent_runtime"));
  return {
    cli: cliBlocked ? "blocked" : "ready",
    agentRuntime: verificationTarget === "cli" ? "not_checked" : cliBlocked ? "not_checked" : agentRuntimeBlocked ? "blocked" : "ready",
  };
}

function selectResultAndAction(
  verificationTarget: VerificationTarget,
  readiness: VerifyReport["readiness"],
  checks: VerifyCheck[],
): { result: VerifyResult; nextAction: VerifyNextAction | null } {
  const eligible = readiness.cli !== "ready"
    ? checks.filter((check) => check.status === "fail" && check.blocks?.includes("cli"))
    : verificationTarget === "agent_runtime" && readiness.agentRuntime !== "ready"
      ? checks.filter((check) => check.status === "fail" && check.blocks?.includes("agent_runtime"))
      : [];
  if (eligible.length === 0) return { result: "ready", nextAction: null };
  const candidates = eligible.flatMap((check) => check.actionCandidate ? [{ check, candidate: check.actionCandidate }] : []);
  if (candidates.length === 0) {
    return {
      result: "needs_manual_action",
      nextAction: {
        kind: "unsupported",
        message: "Verification found a blocking state without an automated next action.",
      },
    };
  }
  candidates.sort((left, right) => {
    const resultDelta = resultPriority[left.candidate.result] - resultPriority[right.candidate.result];
    if (resultDelta !== 0) return resultDelta;
    const actionDelta = left.candidate.priority - right.candidate.priority;
    if (actionDelta !== 0) return actionDelta;
    return layerOrder.indexOf(left.check.layer) - layerOrder.indexOf(right.check.layer);
  });
  const selected = candidates[0]!.candidate;
  const { result, priority, ...nextAction } = selected;
  return { result, nextAction };
}

function selectProductError(
  result: VerifyResult,
  nextAction: VerifyNextAction | null,
  checks: VerifyCheck[],
  descriptor: RuntimeDescriptorProbe,
): ProductErrorSummary | null {
  if (result === "ready") return null;
  const failed = checks.filter((check) => check.status === "fail");
  const explicit = failed.find((check) => nextAction && check.actionCandidate?.kind === nextAction.kind && check.productError)?.productError
    ?? failed.find((check) => check.productError)?.productError;
  if (explicit) return productErrorSummary(explicit, nextAction);
  if (descriptor.status === "fail") return productErrorSummary(descriptor.productError, nextAction);
  if (nextAction && ["install_cli", "configure_agent", "select_profile", "install_extension", "enable_extension"].includes(nextAction.kind)) {
    return productErrorSummary("setup_missing", nextAction);
  }
  if (nextAction?.kind === "open_popup") {
    return productErrorSummary("browser_popup_boundary", nextAction);
  }
  return productErrorSummary("setup_missing", nextAction);
}

function productErrorSummary(code: ProductErrorCode, nextAction: VerifyNextAction | null): ProductErrorSummary {
  const descriptor = PRODUCT_ERROR_BY_CODE.get(code)!;
  return {
    code,
    title: descriptor.title,
    summary: descriptor.summary,
    nextAction,
  };
}

function productErrorForMcpRuntime(runtime: McpRuntimeStatus, popupBoundary: boolean): ProductErrorCode {
  if (popupBoundary) return "browser_popup_boundary";
  if (runtime.productError) return runtime.productError;
  if (runtime.sdkBootstrap !== "available") return "setup_missing";
  if ((runtime.backendCount ?? 0) === 0) return "no_backend";
  return "transport_closed";
}

const PRODUCT_ERROR_BY_CODE = new Map<ProductErrorCode, (typeof PRODUCT_ERROR_SCHEMA)[number]>(
  PRODUCT_ERROR_SCHEMA.map((entry) => [entry.code, entry]),
);

function isProductErrorCode(code: string): code is ProductErrorCode {
  return PRODUCT_ERROR_BY_CODE.has(code as ProductErrorCode);
}

function agentMcpSummary(
  options: VerifyOptions,
  doctorCheck: AgentDoctorCheck | undefined,
  normalized: VerifyCheck,
): VerifyAgent["mcpConfig"] {
  const details = doctorCheck?.details;
  const summary: VerifyAgent["mcpConfig"] = {
    status: normalized.status,
    serverName: SERVER_NAME,
    command: options.server.command,
    args: options.server.args,
  };
  if (isRecord(details) && typeof details.path === "string") summary.path = details.path;
  if (normalized.reason) summary.reason = normalized.reason;
  if (details) summary.details = details;
  return summary;
}

function agentInstructionSummary(
  doctorCheck: AgentDoctorCheck | undefined,
  normalized: VerifyCheck,
): VerifyAgent["instructions"] {
  const summary: VerifyAgent["instructions"] = {
    status: normalized.status,
  };
  if (normalized.reason === "missing_instruction" || normalized.reason === "not_implemented") summary.reason = normalized.reason;
  if (isRecord(doctorCheck?.details) && typeof doctorCheck.details.path === "string") summary.path = doctorCheck.details.path;
  return summary;
}

function notCheckedMcpRuntime(reason: string): McpRuntimeStatus {
  return {
    source: "not_checked",
    provenance: "not_applicable",
    probeCommandSource: "not_applicable",
    mcpConfigured: true,
    mcpStarts: null,
    sdkBootstrap: "not_checked",
    backendCount: null,
    backends: [],
    reason,
  };
}

function notCheckedAgentRuntimeMcp(reason: string): McpRuntimeStatus {
  return {
    source: "not_checked",
    provenance: "not_applicable",
    probeCommandSource: "not_applicable",
    mcpConfigured: true,
    mcpStarts: null,
    sdkBootstrap: "not_checked",
    backendCount: null,
    backends: [],
    reason,
  };
}

function normalizeBackend(value: unknown, options: VerifyOptions): NormalizedBackend {
  const row = isRecord(value) ? value : {};
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const browserKind = typeof metadata.browser_kind === "string" ? metadata.browser_kind : typeof row.name === "string" ? row.name : undefined;
  const extensionId = typeof metadata.extension_id === "string" ? metadata.extension_id : undefined;
  const verified = row.type === "webextension" &&
    browserKind === runtimeBrowserKind(options.browser) &&
    extensionId === options.extensionId;
  return {
    type: typeof row.type === "string" ? row.type : "unknown",
    browser: browserKind ?? null,
    extensionId: extensionId ?? null,
    extensionIdentity: {
      source: extensionId ? "descriptor_metadata" : "missing",
      verified,
    },
    metadata: {
      ...(browserKind ? { browserKind } : {}),
      ...(extensionId ? { extensionId } : {}),
      raw: metadata,
    },
  };
}

async function writeAgentRuntimeChallenge(file: string, options: VerifyOptions, hook: TrustedRuntimeHook | undefined): Promise<void> {
  const nonce = randomBytes(24).toString("hex");
  const payload = {
    schemaVersion: 1,
    agentId: options.agent,
    mcpServerName: SERVER_NAME,
    challenge: {
      nonce,
      issuedAt: new Date().toISOString(),
    },
    target: {
      browser: options.browser,
      channel: options.channel,
      extensionId: options.extensionId,
      ...(options.profile ? { profile: options.profile } : {}),
    },
    ...(hook ? { trustedHook: hook } : {}),
  };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600);
}

async function diagnosticStatusFileBinding(options: VerifyOptions): Promise<{
  statusFile: string;
  targetBound: boolean;
  challengeBound: boolean;
}> {
  const statusFile = options.agentRuntimeStatusJson!;
  const payload = await readJson(statusFile).catch(() => undefined);
  const challenge = options.agentRuntimeChallengeJson ? await readJson(options.agentRuntimeChallengeJson).catch(() => undefined) : undefined;
  const targetBound = isRecord(payload) && isRecord(payload.target) &&
    payload.agentId === options.agent &&
    payload.mcpServerName === SERVER_NAME &&
    payload.target.browser === options.browser &&
    payload.target.channel === options.channel &&
    payload.target.extensionId === options.extensionId &&
    ((options.profile ?? undefined) === (typeof payload.target.profile === "string" ? payload.target.profile : undefined));
  const challengeBound = isRecord(payload) && isRecord(payload.challenge) && isRecord(challenge) && isRecord(challenge.challenge) &&
    payload.challenge.nonce === challenge.challenge.nonce;
  return { statusFile, targetBound, challengeBound };
}

async function readTrustedRuntimeHookResult(options: VerifyOptions, hook: TrustedRuntimeHook | undefined): Promise<TrustedRuntimeResult> {
  if (!hook) {
    return {
      status: "pending",
      reason: "agent_runtime_hook_unavailable",
      message: `no trusted agent-runtime hook is registered for ${options.agent}`,
    };
  }
  const challenge = await readAgentRuntimeChallenge(options, hook);
  if (challenge.status === "fail") return challenge;
  const resultFile = trustedRuntimeHookResultFile(options.layout.runtimeDir, options.agent, hook, challenge.nonce);
  const payload = await readJson(resultFile).catch(() => undefined);
  if (payload !== undefined) {
    return validateTrustedRuntimeHookPayload(options, hook, challenge, payload, resultFile);
  }

  return {
    status: "pending",
    reason: "agent_runtime_challenge_pending",
    message: "agent-runtime challenge is valid, but no trusted hook transport has delivered status for this CLI process",
    details: { challengePath: options.agentRuntimeChallengeJson, resultFile, trustedHook: hook },
  };
}

type ValidAgentRuntimeChallenge = {
  status: "pass";
  nonce: string;
  issuedAt?: string;
};

async function readAgentRuntimeChallenge(
  options: VerifyOptions,
  hook: TrustedRuntimeHook,
): Promise<
  | ValidAgentRuntimeChallenge
  | Extract<TrustedRuntimeResult, { status: "fail" }>
> {
  const challengePath = options.agentRuntimeChallengeJson!;
  const payload = await readJson(challengePath).catch((error) => {
    const nodeError = error as NodeJS.ErrnoException;
    return { __obu_read_error: nodeError.message ?? String(error) };
  });
  if (!isRecord(payload)) {
    return trustedHookFailure("agent_runtime_challenge_invalid", "agent-runtime challenge JSON is not an object", { challengePath });
  }
  if (typeof payload.__obu_read_error === "string") {
    return trustedHookFailure("agent_runtime_challenge_unreadable", "agent-runtime challenge JSON could not be read", {
      challengePath,
      error: payload.__obu_read_error,
    });
  }
  const challengeRecord = isRecord(payload.challenge) ? payload.challenge : {};
  const nonce = typeof challengeRecord.nonce === "string" ? challengeRecord.nonce : undefined;
  if (!nonce) {
    return trustedHookFailure("agent_runtime_challenge_invalid", "agent-runtime challenge is missing a nonce", { challengePath });
  }
  const targetBound =
    payload.schemaVersion === 1 &&
    payload.agentId === options.agent &&
    payload.mcpServerName === SERVER_NAME &&
    targetMatches(payload.target, options);
  if (!targetBound) {
    return trustedHookFailure("agent_runtime_challenge_target_mismatch", "agent-runtime challenge does not match this verification target", {
      challengePath,
      target: payload.target,
    });
  }
  const challengeHook = isRecord(payload.trustedHook) ? payload.trustedHook : undefined;
  if (challengeHook && (challengeHook.id !== hook.id || challengeHook.transport !== hook.transport)) {
    return trustedHookFailure("agent_runtime_challenge_hook_mismatch", "agent-runtime challenge was issued for a different trusted hook", {
      challengePath,
      trustedHook: challengeHook,
    });
  }
  return {
    status: "pass",
    nonce,
    ...(typeof challengeRecord.issuedAt === "string" ? { issuedAt: challengeRecord.issuedAt } : {}),
  };
}

function validateTrustedRuntimeHookPayload(
  options: VerifyOptions,
  hook: TrustedRuntimeHook,
  challenge: ValidAgentRuntimeChallenge,
  payload: unknown,
  resultFile: string,
): TrustedRuntimeResult {
  if (!isRecord(payload)) {
    return trustedRuntimePayloadFailure(options, hook, "agent_runtime_status_invalid", "trusted agent-runtime hook result JSON is not an object", {
      resultFile,
      challengeBound: false,
      targetBound: false,
    });
  }

  const envelopeHook = isRecord(payload.hook) ? payload.hook : {};
  if (envelopeHook.id !== hook.id || envelopeHook.transport !== hook.transport) {
    return trustedRuntimePayloadFailure(options, hook, "agent_runtime_hook_mismatch", "trusted agent-runtime hook result came from a different hook", {
      resultFile,
      hook: envelopeHook,
      challengeBound: false,
      targetBound: false,
    });
  }

  const envelopeChallenge = isRecord(payload.challenge) ? payload.challenge : {};
  const challengeBound = envelopeChallenge.nonce === challenge.nonce;
  const targetBound = targetMatches(payload.target, options);
  const generatedAt = typeof payload.generatedAt === "string" ? payload.generatedAt : undefined;
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : NaN;
  const ageMs = Number.isFinite(generatedAtMs) ? Date.now() - generatedAtMs : NaN;
  const runtimeStatus = hookStatusBase(hook, generatedAt, targetBound, challengeBound);

  if (payload.schemaVersion !== 1 || payload.agentId !== options.agent || payload.mcpServerName !== SERVER_NAME || payload.provenance !== "agent_runtime_hook") {
    return trustedRuntimePayloadFailure(options, hook, "agent_runtime_status_invalid", "trusted agent-runtime hook result envelope is invalid", {
      resultFile,
      challengeBound,
      targetBound,
      runtimeStatus,
    });
  }
  if (!challengeBound) {
    return trustedRuntimePayloadFailure(options, hook, "challenge_mismatch", "trusted agent-runtime hook result does not match this challenge", {
      resultFile,
      challengeBound,
      targetBound,
      runtimeStatus,
    });
  }
  if (!targetBound) {
    return trustedRuntimePayloadFailure(options, hook, "target_mismatch", "trusted agent-runtime hook result does not match this verification target", {
      resultFile,
      challengeBound,
      targetBound,
      runtimeStatus,
    });
  }
  if (!generatedAt || !Number.isFinite(generatedAtMs)) {
    return trustedRuntimePayloadFailure(options, hook, "generated_at_invalid", "trusted agent-runtime hook result has no valid generatedAt timestamp", {
      resultFile,
      challengeBound,
      targetBound,
      runtimeStatus,
    });
  }
  if (ageMs < 0 || ageMs > TRUSTED_AGENT_RUNTIME_FRESHNESS_MS) {
    return trustedRuntimePayloadFailure(options, hook, "stale_status", "trusted agent-runtime hook result is stale", {
      resultFile,
      challengeBound,
      targetBound,
      ageMs,
      freshnessMs: TRUSTED_AGENT_RUNTIME_FRESHNESS_MS,
      runtimeStatus,
    });
  }

  const rawStatus = isRecord(payload.status) ? payload.status : {};
  const rawBackends = Array.isArray(rawStatus.backends) ? rawStatus.backends : [];
  const backends = rawBackends.map((backend) => normalizeBackend(backend, options));
  const usable = backends.filter((backend) => backend.extensionIdentity.verified);
  const sdkBootstrap = typeof rawStatus.sdk_bootstrap === "string" ? rawStatus.sdk_bootstrap : "missing";
  const productError = productErrorFromBrowserStatus(rawStatus, sdkBootstrap, usable.length);
  const mcpRuntime: McpRuntimeStatus = {
    source: "agent_runtime",
    provenance: "agent_runtime_hook",
    probeCommandSource: "agent_runtime_hook",
    mcpConfigured: true,
    mcpStarts: null,
    sdkBootstrap,
    backendCount: usable.length,
    backends: usable,
    ...(sdkBootstrap !== "available" ? { reason: `sdk bootstrap is ${sdkBootstrap}` } : usable.length === 0 ? { reason: "trusted agent-runtime hook found zero usable browser backends" } : {}),
    details: { raw: rawStatus, resultFile, trustedHook: hook },
    ...(productError ? { productError } : {}),
  };

  if (sdkBootstrap !== "available") {
    return {
    status: "fail",
    reason: "sdk_bootstrap_missing",
    message: `trusted agent-runtime hook reported sdk bootstrap is ${sdkBootstrap}`,
    mcpRuntime,
    productError: "setup_missing",
    details: { resultFile, runtimeStatus, raw: rawStatus },
  };
  }
  if (usable.length === 0) {
    return {
      status: "fail",
    reason: "zero_backends",
    message: "trusted agent-runtime hook reported zero usable browser backends",
    mcpRuntime,
    productError: "no_backend",
    details: { resultFile, runtimeStatus, raw: rawStatus },
  };
  }

  return {
    status: "pass",
    runtimeStatus: {
      status: "pass",
      provenance: "agent_runtime_hook",
      hook: { ...hook, trusted: true },
      generatedAt,
      targetBound: true,
      challengeBound: true,
    },
    mcpRuntime,
    details: { resultFile, generatedAt, trustedHook: hook },
  };
}

function hookStatusBase(
  hook: TrustedRuntimeHook,
  generatedAt: string | undefined,
  targetBound: boolean,
  challengeBound: boolean,
): Omit<Extract<AgentRuntimeStatus, { status: "fail" }>, "reason"> {
  return {
    status: "fail",
    provenance: "agent_runtime_hook",
    hook: { ...hook, trusted: true },
    ...(generatedAt ? { generatedAt } : {}),
    targetBound,
    challengeBound,
  };
}

function trustedRuntimePayloadFailure(
  options: VerifyOptions,
  hook: TrustedRuntimeHook,
  reason: string,
  message: string,
  details: Record<string, unknown>,
): Extract<TrustedRuntimeResult, { status: "fail" }> {
  const runtimeStatus = isRecord(details.runtimeStatus)
    ? details.runtimeStatus as Omit<Extract<AgentRuntimeStatus, { status: "fail" }>, "reason">
    : hookStatusBase(
      hook,
      typeof details.generatedAt === "string" ? details.generatedAt : undefined,
      details.targetBound === true,
      details.challengeBound === true,
    );
  return {
    status: "fail",
    reason,
    message,
    mcpRuntime: notCheckedAgentRuntimeMcp(reason),
    details: {
      ...details,
      runtimeStatus: { ...runtimeStatus, reason },
      target: {
        agent: options.agent,
        browser: options.browser,
        channel: options.channel,
        extensionId: options.extensionId,
        ...(options.profile ? { profile: options.profile } : {}),
      },
    },
  };
}

function trustedHookFailure(reason: string, message: string, details?: Record<string, unknown>): Extract<TrustedRuntimeResult, { status: "fail" }> {
  return {
    status: "fail",
    reason,
    message,
    mcpRuntime: notCheckedAgentRuntimeMcp(reason),
    ...(details ? { details } : {}),
  };
}

function trustedRuntimeHookResultFile(runtimeDir: string, agent: AgentId, hook: TrustedRuntimeHook, nonce: string): string {
  const digest = createHash("sha256").update(nonce).digest("hex");
  return path.join(runtimeDir, "agent-runtime-hooks", agent, hook.id, `${digest}.json`);
}

function targetMatches(value: unknown, options: VerifyOptions): boolean {
  if (!isRecord(value)) return false;
  return value.browser === options.browser &&
    value.channel === options.channel &&
    value.extensionId === options.extensionId &&
    ((options.profile ?? undefined) === (typeof value.profile === "string" ? value.profile : undefined));
}

type TrustedRuntimeHook = {
  id: string;
  transport: "agent_connector" | "agent_owned_ipc" | "in_process_adapter";
};

const TRUSTED_RUNTIME_HOOKS: Partial<Record<AgentId, TrustedRuntimeHook>> = {
  "codex-cli": {
    id: "codex-cli-runtime-status",
    transport: "agent_owned_ipc",
  },
};

function trustedRuntimeHook(agent: AgentId): TrustedRuntimeHook | undefined {
  return TRUSTED_RUNTIME_HOOKS[agent];
}

function passCheck(input: {
  id: string;
  layer: VerifyLayer;
  message: string;
  target: VerifyTarget;
  evidence: Evidence;
  details?: Record<string, unknown>;
}): VerifyCheck {
  return {
    id: input.id,
    layer: input.layer,
    status: "pass",
    message: input.message,
    target: input.target,
    evidence: input.evidence,
    ...(input.details && Object.keys(input.details).length > 0 ? { details: input.details } : {}),
  };
}

function warnCheck(input: {
  id: string;
  layer: VerifyLayer;
  reason: string;
  message: string;
  target: VerifyTarget;
  evidence: Evidence;
  details?: Record<string, unknown>;
}): VerifyCheck {
  return {
    id: input.id,
    layer: input.layer,
    status: "warn",
    reason: input.reason,
    message: input.message,
    target: input.target,
    evidence: input.evidence,
    ...(input.details && Object.keys(input.details).length > 0 ? { details: input.details } : {}),
  };
}

function notCheckedCheck(input: {
  id: string;
  layer: VerifyLayer;
  reason: string;
  message: string;
  target: VerifyTarget;
  evidence: Evidence;
  details?: Record<string, unknown>;
}): VerifyCheck {
  return {
    id: input.id,
    layer: input.layer,
    status: "not_checked",
    reason: input.reason,
    message: input.message,
    target: input.target,
    evidence: input.evidence,
    ...(input.details && Object.keys(input.details).length > 0 ? { details: input.details } : {}),
  };
}

function failCheck(input: {
  id: string;
  layer: VerifyLayer;
  reason: string;
  message: string;
  target: VerifyTarget;
  evidence: Evidence;
  details?: Record<string, unknown>;
  blocks?: Array<"cli" | "agent_runtime">;
  actionCandidate?: ActionCandidate;
  productError?: ProductErrorCode;
}): VerifyCheck {
  return {
    id: input.id,
    layer: input.layer,
    status: "fail",
    reason: input.reason,
    message: input.message,
    target: input.target,
    evidence: input.evidence,
    blocks: input.blocks ?? ["cli"],
    ...(input.details && Object.keys(input.details).length > 0 ? { details: input.details } : {}),
    ...(input.actionCandidate ? { actionCandidate: input.actionCandidate } : {}),
    ...(input.productError ? { productError: input.productError } : {}),
  };
}

function expectedEvidence(source: string): Evidence {
  return {
    scope: "cli",
    provenance: "expected_obu_invocation",
    source,
  };
}

function runtimeEvidence(source: string): Evidence {
  return {
    scope: "browser_extension",
    provenance: "runtime_descriptor_probe",
    source,
  };
}

function repairAction(command: string, message: string): ActionCandidate {
  return {
    result: "needs_repair",
    kind: "run_repair",
    priority: 1,
    message,
    command,
  };
}

function openPopupAction(options: VerifyOptions, profile: string | null): ActionCandidate {
  return {
    result: "needs_browser_popup",
    kind: "open_popup",
    priority: 1,
    message: "Open the open-browser-use extension popup. Click Resume if enabled; otherwise wait for Connected and rerun verify.",
    url: `chrome-extension://${options.extensionId}/popup.html`,
    browser: options.browser,
    profile: { path: profile },
    rerun: verifyCommand(options),
  };
}

function selectProfileAction(options: VerifyOptions, suggestedPath: string | null, message: string): ActionCandidate {
  return {
    result: "needs_manual_action",
    kind: "select_profile",
    priority: manualActionPriority.select_profile,
    message,
    browser: options.browser,
    profile: options.profile ? { path: options.profile, suggestedPath: null } : { path: null, suggestedPath },
    rerun: verifyCommand(options),
  };
}

function configureAgentAction(options: VerifyOptions, message: string): ActionCandidate {
  return {
    result: "needs_manual_action",
    kind: "configure_agent",
    priority: manualActionPriority.configure_agent,
    message,
    command: mcpConfigCommand(options),
  };
}

function agentRuntimeHookUnavailableAction(options: VerifyOptions, message: string): ActionCandidate {
  return {
    result: "needs_manual_action",
    kind: "unsupported",
    priority: manualActionPriority.unsupported,
    message,
    command: appendShellArgs(options.commandPrefix, verifyArgs(options, false, { requireAgentRuntime: false })),
  };
}

function collectAgentRuntimeAction(
  options: VerifyOptions,
  hook: TrustedRuntimeHook | undefined,
  challengePath: string | undefined,
  message: string,
): ActionCandidate {
  return {
    result: "needs_manual_action",
    kind: "collect_agent_runtime_status",
    priority: manualActionPriority.collect_agent_runtime_status,
    message,
    ...(challengePath ? { challenge: { path: challengePath } } : {}),
    ...(hook ? { trustedHook: hook } : {}),
    rerun: appendShellArgs(options.commandPrefix, verifyArgs(options, false, challengePath ? { agentRuntimeChallengeJson: challengePath } : {})),
  };
}

function verifyCommand(options: VerifyOptions): string {
  return appendShellArgs(options.commandPrefix, verifyArgs(options, false));
}

function repairCommand(options: VerifyOptions): string {
  return appendShellArgs(options.commandPrefix, verifyArgs(options, true));
}

function mcpConfigCommand(options: VerifyOptions): string {
  return appendShellArgs(options.commandPrefix, ["mcp-config", `--agent=${options.agent}`, "--print"]);
}

function verifyArgs(options: VerifyOptions, repair: boolean, extra: { agentRuntimeChallengeJson?: string; requireAgentRuntime?: boolean } = {}): string[] {
  const args = [
    "verify",
    `--agent=${options.agent}`,
    `--browser=${options.browser}`,
    `--channel=${options.channel}`,
    `--extension-id=${options.extensionId}`,
  ];
  if (options.profile) args.push(`--profile=${options.profile}`);
  if (extra.requireAgentRuntime ?? options.requireAgentRuntime) args.push("--require-agent-runtime");
  if (extra.agentRuntimeChallengeJson) args.push(`--agent-runtime-challenge-json=${extra.agentRuntimeChallengeJson}`);
  if (repair) args.push("--repair");
  return args;
}

function homeDirFromLayout(layout: RuntimeLayout): string | undefined {
  const obuDir = path.dirname(layout.userConfigPath);
  return path.basename(obuDir) === ".obu" ? path.dirname(obuDir) : undefined;
}

function runtimeBrowserKind(browser: BrowserKind): string {
  return browser === "chrome-for-testing" ? "chrome" : browser;
}

function compareProfilePaths(left: string, right: string): number {
  const leftName = path.basename(left);
  const rightName = path.basename(right);
  const leftRank = profileSortRank(leftName);
  const rightRank = profileSortRank(rightName);
  if (leftRank[0] !== rightRank[0]) return leftRank[0] - rightRank[0];
  if (leftRank[1] !== rightRank[1]) return leftRank[1] - rightRank[1];
  return path.resolve(left).localeCompare(path.resolve(right));
}

function profileSortRank(name: string): [number, number] {
  if (name === "Default") return [0, 0];
  const profile = /^Profile (\d+)$/.exec(name);
  if (profile) return [1, Number(profile[1])];
  return [2, 0];
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "darwin" || process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

async function validateDescriptorFile(file: string): Promise<string | undefined> {
  const stats = await lstat(file).catch((error) => `stat descriptor failed: ${String(error)}`);
  if (typeof stats === "string") return stats;
  if (stats.isSymbolicLink()) return "descriptor is a symlink";
  if (!stats.isFile()) return "descriptor is not a file";
  return ownerOnlyIssue(stats, "descriptor");
}

function descriptorProcessIssue(descriptor: Record<string, unknown>): string | undefined {
  if (process.platform === "win32") return undefined;
  const pid = descriptor.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || Number(pid) > 2_147_483_647) {
    return "descriptor pid missing or invalid";
  }
  try {
    process.kill(Number(pid), 0);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return undefined;
    return "descriptor process is not alive";
  }
}

async function validateDescriptorSocket(socketPath: string): Promise<string | undefined> {
  const stats = await stat(socketPath).catch((error) => `stat descriptor socket failed: ${String(error)}`);
  if (typeof stats === "string") return stats;
  if (process.platform !== "win32" && !stats.isSocket()) return "descriptor socket path is not a socket";
  return ownerOnlyIssue(stats, "descriptor socket");
}

function ownerOnlyIssue(stats: { uid?: number; mode: number }, label: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== undefined && stats.uid !== uid) return `${label} is not owned by current user`;
  if ((stats.mode & 0o077) !== 0) return `${label} permissions must be owner-only`;
  return undefined;
}

function rpcSequenceOverUnixSocket(socketPath: string, payloads: Record<string, unknown>[]): Promise<RpcResponse[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, 800);
    let buffer = Buffer.alloc(0);
    let nextRequest = 0;
    const responses: RpcResponse[] = [];
    const finish = (value: RpcResponse[]) => {
      clearTimeout(timer);
      socket.end();
      resolve(value);
    };
    const fail = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const writeNext = () => {
      if (nextRequest >= payloads.length) {
        finish(responses);
        return;
      }
      socket.write(encodeFrame(payloads[nextRequest]!));
    };
    socket.once("error", fail);
    socket.once("connect", writeNext);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        try {
          responses.push(JSON.parse(body.toString("utf8")));
        } catch (error) {
          fail(error);
          return;
        }
        nextRequest += 1;
        writeNext();
      }
    });
  });
}

function encodeFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function mergedDescriptorMetadata(descriptor: Record<string, unknown>, infoResult: Record<string, any>): Record<string, unknown> {
  const descriptorMetadata = isRecord(descriptor.metadata) ? descriptor.metadata : {};
  const infoBackend = isRecord(infoResult.metadata?.backend) ? infoResult.metadata.backend : {};
  return { ...infoBackend, ...descriptorMetadata };
}

function descriptorProfilePath(metadata: Record<string, unknown>): string | undefined {
  for (const key of ["profile_path", "profilePath", "browser_profile_path"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stringFromPath(value: Record<string, unknown>, pathParts: string[]): string | undefined {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
