#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

import { doctorAgent, formatAgentDoctorReport, hasAgentDoctorFailures } from "./agents/doctor.js";
import {
  normalizeAgentId,
  renderAgentMcpConfig,
  supportedAgentAliasHelp,
  supportedAgentIds,
  type AgentId,
  type McpServerInvocation,
} from "./agents/registry.js";
import { appendShellArgs, formatShellCommand } from "./command-line.js";
import { doctorAggregate, formatAggregateDoctorReport } from "./doctor.js";
import { doctorJson } from "./doctor-json.js";
import { doctorBrowser, formatDoctorReport, hasDoctorFailures, type BrowserKind, type DoctorReport } from "./doctor-browser.js";
import { parseExtensionChannel, resolveExtensionTarget, userConfigForExtensionTarget } from "./extension-channel.js";
import {
  formatDoctorSummary,
  formatInstallHostSummary,
  formatInstallHostVerbose,
  formatSetupSummary,
  formatSetupVerbose,
  formatUpdateExtensionSummary,
  formatUpdateExtensionVerbose,
} from "./human-output.js";
import { updateExtension } from "./extension-update.js";
import { installNativeHosts, supportedNativeHostBrowsers } from "./native-host.js";
import { ensureRuntimeDir, executableExists, packageVersion, resolveRuntimeLayout, validateRuntimeDir, writeUserConfig } from "./runtime-layout.js";
import { setupOpenBrowserUse, type SetupJson } from "./setup.js";
import { formatVerifyReport, verifyExitCode, verifyOpenBrowserUse } from "./verify.js";

type ParsedArgs = {
  command?: string;
  subject?: string;
  browser?: BrowserKind;
  agent?: string;
  json: boolean;
  verbose: boolean;
  recovery: boolean;
  repair: boolean;
  cleanBackups: boolean;
  strict: boolean;
  print: boolean;
  all: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
  extensionId?: string;
  channel?: string;
  extensionPath?: string;
  noWait: boolean;
  yes: boolean;
  agents: string[];
  skipExtension: boolean;
  skipAgents: boolean;
  writeInstructions: boolean;
  requireAgentRuntime: boolean;
  profile?: string;
  agentRuntimeChallengeOut?: string;
  agentRuntimeChallengeJson?: string;
  agentRuntimeStatusJson?: string;
};

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.version || args.command === "version") {
    console.log(await packageVersion());
    return 0;
  }
  if (args.command === "doctor") {
    return runDoctor(args);
  }
  if (args.command === "verify") {
    return runVerify(args);
  }
  if (args.command === "mcp-config") {
    return runMcpConfig(args);
  }
  if (args.command === "agent" && args.subject === "doctor") {
    return runAgentDoctor(args);
  }
  if (args.command === "shellenv") {
    return runShellenv(args);
  }
  if (args.command === "mcp" && args.subject === "stdio") {
    return runMcpStdio();
  }
  if (args.command === "install-host") {
    return runInstallHost(args);
  }
  if (args.command === "update-extension") {
    return runUpdateExtension(args);
  }
  if (args.command === "setup") {
    return runSetup(args);
  }
  if (args.command === "bootstrap") {
    return runBootstrap(args);
  }
  if (args.command === "repl") {
    console.error("obu repl is deferred in P4a. Use `obu mcp stdio` for MCP clients; a direct debug REPL needs a separate tested contract.");
    return 2;
  }
  printHelp();
  return 2;
}

async function runBootstrap(args: ParsedArgs): Promise<number> {
  const layout = await resolveRuntimeLayout();
  if (layout.configIssue) {
    console.error(`open-browser-use user config is invalid: ${layout.configIssue.message}. Fix or remove ${layout.configIssue.path}, then rerun obu bootstrap.`);
    return 2;
  }
  let extensionTarget;
  try {
    extensionTarget = await resolveExtensionTarget({
      layout,
      channel: args.channel,
      explicitExtensionId: args.extensionId,
      env: process.env,
      ...(args.extensionPath ? { manifestPath: path.join(args.extensionPath, "manifest.json") } : {}),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (extensionTarget.channel === "store" && args.extensionPath) {
    console.error("bootstrap --channel=store does not support --path; install the extension from Chrome Web Store instead.");
    return 2;
  }
  const supported = supportedNativeHostBrowsers();
  const browsers = args.all ? supported : [args.browser ?? ("chrome" as BrowserKind)];
  const unsupported = browsers.filter((browser) => !supported.includes(browser));
  if (unsupported.length > 0) {
    console.error(`unsupported bootstrap browser target on ${process.platform}: ${unsupported.join(", ")}`);
    return 2;
  }
  const requestedAgents = normalizeAgentArgs(args.agents);
  if (requestedAgents.unsupported.length > 0) {
    console.error(unsupportedAgentMessage(requestedAgents.unsupported));
    return 2;
  }
  const invocation = await resolveMcpInvocation(layout.openBrowserUseCommand, layout.cliEntry);
  const commandPrefix = await resolveHumanCommandPrefix(layout);
  const server: McpServerInvocation = {
    name: "open-browser-use",
    command: invocation.command,
    args: invocation.args,
  };
  const setupReport = await setupOpenBrowserUse({
    layout,
    obuVersion: await packageVersion(),
    browsers,
    agents: requestedAgents.agents,
    server,
    extensionChannel: extensionTarget.channel,
    extensionId: extensionTarget.extensionId,
    extensionIdSource: extensionTarget.extensionIdSource,
    dryRun: args.dryRun,
    skipExtension: args.skipExtension,
    skipAgents: args.skipAgents,
    writeInstructions: args.writeInstructions,
    env: process.env,
    commandPrefix,
    projectDir: process.cwd(),
    ...(args.extensionPath ? { extensionPath: args.extensionPath } : {}),
  });

  let browserReport: DoctorReport | undefined;
  if (setupReport.result !== "failed") {
    browserReport = await doctorBrowser({
      ...(args.browser === undefined ? {} : { browser: args.browser }),
      channel: extensionTarget.channel,
      extensionId: extensionTarget.extensionId,
      extensionIdSource: extensionTarget.extensionIdSource,
      ...(extensionTarget.channel === "store" ? {} : { extensionCurrentDir: layout.mode === "repo" ? layout.extensionDir : layout.extensionCurrentDir }),
      repair: !args.dryRun,
    });
  }

  if (args.json) {
    const doctorExit = browserReport ? doctorExitCode(browserReport, false) : 0;
    const result = setupReport.result === "failed" || doctorExit !== 0
      ? "failed"
      : setupReport.result === "manual_action_required" || browserResumeRequired(browserReport)
        ? "manual_action_required"
        : "complete";
    const payload: {
      schemaVersion: 1;
      command: "bootstrap";
      result: "complete" | "manual_action_required" | "failed";
      setup: SetupJson;
      browserDoctor?: DoctorReport;
    } = {
      schemaVersion: 1,
      command: "bootstrap",
      result,
      setup: setupReport,
    };
    if (browserReport) payload.browserDoctor = browserReport;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(formatBootstrapSummary(setupReport, browserReport));
  }

  if (setupReport.result === "failed") return 1;
  if (!browserReport) return 1;
  const doctorExit = doctorExitCode(browserReport, false);
  if (doctorExit !== 0) return doctorExit;
  if (setupReport.result === "manual_action_required" || browserResumeRequired(browserReport)) return 1;
  return 0;
}

async function runSetup(args: ParsedArgs): Promise<number> {
  const layout = await resolveRuntimeLayout();
  if (layout.configIssue) {
    console.error(`open-browser-use user config is invalid: ${layout.configIssue.message}. Fix or remove ${layout.configIssue.path}, then rerun obu setup.`);
    return 2;
  }
  let extensionTarget;
  try {
    extensionTarget = await resolveExtensionTarget({
      layout,
      channel: args.channel,
      explicitExtensionId: args.extensionId,
      env: process.env,
      ...(args.extensionPath ? { manifestPath: path.join(args.extensionPath, "manifest.json") } : {}),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (extensionTarget.channel === "store" && args.extensionPath) {
    console.error("setup --channel=store does not support --path; install the extension from Chrome Web Store instead.");
    return 2;
  }
  const supported = supportedNativeHostBrowsers();
  const browsers = args.all ? supported : [args.browser ?? ("chrome" as BrowserKind)];
  const unsupported = browsers.filter((browser) => !supported.includes(browser));
  if (unsupported.length > 0) {
    console.error(`unsupported setup browser target on ${process.platform}: ${unsupported.join(", ")}`);
    return 2;
  }
  const requestedAgents = normalizeAgentArgs(args.agents);
  if (requestedAgents.unsupported.length > 0) {
    console.error(unsupportedAgentMessage(requestedAgents.unsupported));
    return 2;
  }
  const invocation = await resolveMcpInvocation(layout.openBrowserUseCommand, layout.cliEntry);
  const commandPrefix = await resolveHumanCommandPrefix(layout);
  const server: McpServerInvocation = {
    name: "open-browser-use",
    command: invocation.command,
    args: invocation.args,
  };
  const report = await setupOpenBrowserUse({
    layout,
    obuVersion: await packageVersion(),
    browsers,
    agents: requestedAgents.agents,
    server,
    extensionChannel: extensionTarget.channel,
    extensionId: extensionTarget.extensionId,
    extensionIdSource: extensionTarget.extensionIdSource,
    dryRun: args.dryRun,
    skipExtension: args.skipExtension,
    skipAgents: args.skipAgents,
    writeInstructions: args.writeInstructions,
    env: process.env,
    commandPrefix,
    projectDir: process.cwd(),
    ...(args.extensionPath ? { extensionPath: args.extensionPath } : {}),
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(args.verbose ? formatSetupVerbose(report) : formatSetupSummary(report));
  }
  if (report.result === "complete") return 0;
  if (report.result === "manual_action_required" && args.recovery && isBrowserRecoveryBoundary(report)) return 0;
  return 1;
}

async function runVerify(args: ParsedArgs): Promise<number> {
  if (!args.agent) throw new Error("verify requires --agent=<id>");
  const agent = normalizeAgentId(args.agent);
  if (!agent) throw new Error(unsupportedAgentMessage([args.agent]));
  const layout = await resolveRuntimeLayout();
  if (layout.configIssue) {
    console.error(`open-browser-use user config is invalid: ${layout.configIssue.message}. Fix or remove ${layout.configIssue.path}, then rerun obu verify.`);
    return 2;
  }
  let extensionTarget;
  try {
    extensionTarget = await resolveExtensionTarget({
      layout,
      channel: args.channel,
      explicitExtensionId: args.extensionId,
      env: process.env,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const browser = args.browser ?? ("chrome" as BrowserKind);
  const invocation = await resolveMcpInvocation(layout.openBrowserUseCommand, layout.cliEntry);
  const server: McpServerInvocation = {
    name: "open-browser-use",
    command: invocation.command,
    args: invocation.args,
  };
  const commandPrefix = await resolveHumanCommandPrefix(layout);
  const report = await verifyOpenBrowserUse({
    layout,
    agent,
    agentInput: args.agent,
    browser,
    channel: extensionTarget.channel,
    extensionId: extensionTarget.extensionId,
    extensionIdSource: extensionTarget.extensionIdSource,
    server,
    commandPrefix,
    repair: args.repair,
    requireAgentRuntime: args.requireAgentRuntime,
    env: process.env,
    homeDir: path.dirname(path.dirname(layout.userConfigPath)),
    projectDir: process.cwd(),
    ...(args.profile ? { profile: args.profile } : {}),
    ...(args.agentRuntimeChallengeOut ? { agentRuntimeChallengeOut: args.agentRuntimeChallengeOut } : {}),
    ...(args.agentRuntimeChallengeJson ? { agentRuntimeChallengeJson: args.agentRuntimeChallengeJson } : {}),
    ...(args.agentRuntimeStatusJson ? { agentRuntimeStatusJson: args.agentRuntimeStatusJson } : {}),
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatVerifyReport(report));
  }
  return verifyExitCode(report);
}

async function runShellenv(args: ParsedArgs): Promise<number> {
  const layout = await resolveRuntimeLayout();
  const shell = parseShellEnv(args.subject ?? process.env.SHELL?.split(/[\\/]/).filter(Boolean).at(-1) ?? "sh");
  const output = formatShellEnv(shell, shellEnvInstallDir(layout), process.env);
  if (output.length > 0) console.log(output);
  return 0;
}

async function runUpdateExtension(args: ParsedArgs): Promise<number> {
  const layout = await resolveRuntimeLayout();
  if (layout.configIssue) {
    console.error(`open-browser-use user config is invalid: ${layout.configIssue.message}. Fix or remove ${layout.configIssue.path}, then rerun obu update-extension.`);
    return 2;
  }
  const channel = parseExtensionChannel(args.channel, layout.userConfig?.extensionChannel);
  if (channel === "store") {
    console.error("update-extension is not available for --channel=store; Chrome Web Store manages Store extension updates.");
    return 2;
  }
  if (!args.dryRun) {
    const runtime = await ensureRuntimeDir(layout.runtimeDir);
    if (!runtime.ok) {
      console.error(`open-browser-use runtime is not ready: ${runtime.message ?? "invalid runtime directory"}`);
      return 2;
    }
    await writeUserConfig(layout.userConfigPath, {
      schemaVersion: 1,
      runtimeDir: layout.runtimeDir,
      extensionCurrentDir: layout.extensionCurrentDir,
      nativeHostInstallRoot: layout.nativeHostInstallRoot,
    });
  }
  const report = await updateExtension({
    layout,
    dryRun: args.dryRun,
    noWait: args.noWait,
    ...(args.extensionPath ? { sourceDir: args.extensionPath } : {}),
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(args.verbose ? formatUpdateExtensionVerbose(report) : formatUpdateExtensionSummary(report));
  }
  return report.result === "complete" ? 0 : 1;
}

async function runInstallHost(args: ParsedArgs): Promise<number> {
  const layout = await resolveRuntimeLayout();
  if (layout.configIssue) {
    console.error(`open-browser-use user config is invalid: ${layout.configIssue.message}. Fix or remove ${layout.configIssue.path}, then rerun obu install-host.`);
    return 2;
  }
  let extensionTarget;
  try {
    extensionTarget = await resolveExtensionTarget({
      layout,
      channel: args.channel,
      explicitExtensionId: args.extensionId,
      env: process.env,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!args.dryRun) {
    const runtime = await ensureRuntimeDir(layout.runtimeDir);
    if (!runtime.ok) {
      console.error(`open-browser-use runtime is not ready: ${runtime.message ?? "invalid runtime directory"}`);
      return 2;
    }
    await writeUserConfig(layout.userConfigPath, userConfigForExtensionTarget(layout, extensionTarget));
  }
  const supported = supportedNativeHostBrowsers();
  const browsers = args.all ? supported : [args.browser ?? ("chrome" as BrowserKind)];
  const unsupported = browsers.filter((browser) => !supported.includes(browser));
  if (unsupported.length > 0) {
    console.error(`unsupported native-host browser target on ${process.platform}: ${unsupported.join(", ")}`);
    return 2;
  }
  const actions = await installNativeHosts({
    layout,
    browsers,
    dryRun: args.dryRun,
    extensionId: extensionTarget.extensionId,
  });
  if (args.json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      command: "install-host",
      extensionChannel: extensionTarget.channel,
      extensionId: extensionTarget.extensionId,
      extensionIdSource: extensionTarget.extensionIdSource,
      actions,
    }, null, 2));
  } else {
    console.log(args.verbose ? formatInstallHostVerbose(actions) : formatInstallHostSummary(actions));
  }
  return actions.some((action) => action.status === "failed") ? 1 : 0;
}

async function runMcpStdio(): Promise<number> {
  const layout = await resolveRuntimeLayout();
  if (layout.configIssue) {
    console.error(`open-browser-use user config is invalid: ${layout.configIssue.message}. Fix or remove ${layout.configIssue.path}, then run obu doctor.`);
    return 2;
  }
  const runtime = await validateRuntimeDir(layout.runtimeDir);
  if (!runtime.ok) {
    console.error(`open-browser-use runtime is not ready: ${runtime.message ?? "invalid runtime directory"}. Run obu setup before wiring agents.`);
    return 2;
  }
  if (!await executableExists(layout.nodeReplBin)) {
    console.error(`obu-node-repl is not executable at ${layout.nodeReplBin}. Build or install the open-browser-use payload, then rerun obu setup.`);
    return 2;
  }
  const child = spawn(layout.nodeReplBin, ["mcp", "stdio"], {
    stdio: "inherit",
    env: {
      ...process.env,
      OBU_NODE_BINARY: layout.nodeBin,
      OBU_NODE_REPL_MODULE_DIRS: layout.nodeModulesRoot,
      OBU_RUNTIME_DIR: layout.runtimeDir,
    },
  });
  return new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`failed to launch obu-node-repl: ${error.message}`);
      resolve(2);
    });
    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      console.error(`obu-node-repl exited from signal ${signal ?? "unknown"}`);
      resolve(1);
    });
  });
}

async function runDoctor(args: ParsedArgs): Promise<number> {
  if (args.subject && args.subject !== "browser") {
    throw new Error(`unsupported doctor subject: ${args.subject}`);
  }
  if (args.subject === "browser" && args.cleanBackups) {
    throw new Error("doctor browser does not support --clean-backups; run `obu doctor --clean-backups`");
  }
  const layout = await resolveRuntimeLayout();
  let extensionTarget;
  try {
    extensionTarget = await resolveExtensionTarget({
      layout,
      channel: args.channel,
      explicitExtensionId: args.extensionId,
      env: process.env,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const browserOptions = {
    ...(args.browser === undefined ? {} : { browser: args.browser }),
    channel: extensionTarget.channel,
    extensionId: extensionTarget.extensionId,
    extensionIdSource: extensionTarget.extensionIdSource,
    ...(extensionTarget.channel === "store" ? {} : { extensionCurrentDir: layout.mode === "repo" ? layout.extensionDir : layout.extensionCurrentDir }),
    repair: args.repair,
  };
  const report = args.subject === "browser"
    ? await doctorBrowser(browserOptions)
    : await doctorAggregate({ layout, browserOptions, cleanBackups: args.cleanBackups });
  const command = args.subject === "browser" ? "doctor browser" : "doctor";
  if (args.json) {
    console.log(JSON.stringify(doctorJson({
      report,
      layout,
      obuVersion: await packageVersion(),
      command,
      strict: args.strict,
    }), null, 2));
  } else {
    const commandPrefix = await resolveHumanCommandPrefix(layout);
    console.log(args.verbose
      ? args.subject === "browser" ? formatDoctorReport(report as DoctorReport) : formatAggregateDoctorReport(report)
      : formatDoctorSummary(report, command, args.strict, doctorVerboseCommand(args, commandPrefix)));
  }
  return doctorExitCode(report, args.strict);
}

async function runMcpConfig(args: ParsedArgs): Promise<number> {
  if (!args.agent) throw new Error("mcp-config requires --agent=<id>");
  if (!args.print) throw new Error("mcp-config currently supports --print only");
  const agent = normalizeAgentId(args.agent);
  if (!agent) throw new Error(unsupportedAgentMessage([args.agent]));
  const layout = await resolveRuntimeLayout();
  const invocation = await resolveMcpInvocation(layout.openBrowserUseCommand, layout.cliEntry);
  const server: McpServerInvocation = {
    name: "open-browser-use",
    command: invocation.command,
    args: invocation.args,
  };
  console.log(JSON.stringify(renderAgentMcpConfig(agent, server), null, 2));
  return 0;
}

async function runAgentDoctor(args: ParsedArgs): Promise<number> {
  if (!args.agent) throw new Error("agent doctor requires --agent=<id>");
  const agent = normalizeAgentId(args.agent);
  if (!agent) throw new Error(unsupportedAgentMessage([args.agent]));
  const layout = await resolveRuntimeLayout();
  const invocation = await resolveMcpInvocation(layout.openBrowserUseCommand, layout.cliEntry);
  const server: McpServerInvocation = {
    name: "open-browser-use",
    command: invocation.command,
    args: invocation.args,
  };
  const report = await doctorAgent({
    agent,
    server,
    env: process.env,
    homeDir: path.dirname(path.dirname(layout.userConfigPath)),
    projectDir: process.cwd(),
  });
  if (args.json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      command: "agent doctor",
      ...report,
    }, null, 2));
  } else {
    console.log(formatAgentDoctorReport(report));
  }
  return hasAgentDoctorFailures(report) ? 1 : 0;
}

function normalizeAgentArgs(values: string[]): { agents: AgentId[]; unsupported: string[] } {
  const agents: AgentId[] = [];
  const unsupported: string[] = [];
  for (const value of values) {
    const agent = normalizeAgentId(value);
    if (!agent) {
      unsupported.push(value);
      continue;
    }
    if (!agents.includes(agent)) agents.push(agent);
  }
  return { agents, unsupported };
}

function unsupportedAgentMessage(values: string[]): string {
  return `unsupported agent id(s): ${values.join(", ")}. Supported agents: ${supportedAgentIds().join(", ")}. ${supportedAgentAliasHelp()}`;
}

async function resolveHumanCommandPrefix(layout: Awaited<ReturnType<typeof resolveRuntimeLayout>>): Promise<string> {
  const command = layout.openBrowserUseCommand;
  if (!path.isAbsolute(command) && !command.includes(path.sep)) return formatShellCommand(command);
  const executable = path.isAbsolute(command) ? command : path.resolve(process.cwd(), command);
  if (await executableExists(executable)) return formatShellCommand(executable);
  return formatShellCommand(layout.nodeBin, [layout.cliEntry]);
}

async function resolveMcpInvocation(openBrowserUseCommand: string, cliEntry: string): Promise<{ command: string; args: string[] }> {
  const command = path.isAbsolute(openBrowserUseCommand)
    ? openBrowserUseCommand
    : path.resolve(process.cwd(), openBrowserUseCommand);
  if (await executableExists(command)) {
    return { command, args: ["mcp", "stdio"] };
  }
  return {
    command: process.execPath,
    args: [cliEntry, "mcp", "stdio"],
  };
}

function doctorExitCode(report: { checks: DoctorReport["checks"] }, strict: boolean): number {
  if (hasDoctorFailures(report)) return 1;
  if (strict && report.checks.some((check) => check.status === "warn")) return 1;
  return 0;
}

type ShellEnvKind = "sh" | "bash" | "zsh" | "fish";

function parseShellEnv(value: string): ShellEnvKind {
  if (value === "sh" || value === "bash" || value === "zsh" || value === "fish") return value;
  return "sh";
}

function shellEnvInstallDir(layout: Awaited<ReturnType<typeof resolveRuntimeLayout>>): string {
  if (layout.mode === "packaged") return path.resolve(layout.root, "..", "..");
  const command = layout.openBrowserUseCommand;
  if (path.isAbsolute(command)) return path.dirname(path.dirname(command));
  if (command.includes(path.sep)) return path.dirname(path.dirname(path.resolve(process.cwd(), command)));
  return path.dirname(path.dirname(layout.cliEntry));
}

function formatShellEnv(shell: ShellEnvKind, installDir: string, env: NodeJS.ProcessEnv): string {
  const binDir = path.join(installDir, "bin");
  if (env.OBU_INSTALL_DIR === installDir && firstPathEntry(env.PATH) === binDir) return "";
  if (shell === "fish") {
    return [
      `set --global --export OBU_INSTALL_DIR ${doubleQuoted(installDir)};`,
      `fish_add_path --global --move --path ${doubleQuoted(binDir)};`,
    ].join("\n");
  }
  return [
    `export OBU_INSTALL_DIR=${shellSingleQuoted(installDir)};`,
    'export PATH="${OBU_INSTALL_DIR}/bin${PATH+:$PATH}";',
  ].join("\n");
}

function firstPathEntry(pathValue: string | undefined): string | undefined {
  const first = pathValue?.split(path.delimiter).find((entry) => entry.length > 0);
  return first ? path.resolve(first) : undefined;
}

function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function doubleQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function formatBootstrapSummary(setupReport: SetupJson, browserReport: DoctorReport | undefined): string {
  if (setupReport.result === "failed") return formatSetupSummary(setupReport);

  const rows = [
    setupReport.dryRun ? "open-browser-use bootstrap dry run complete." : "open-browser-use is installed.",
  ];
  if (browserReport) {
    const channelLabel = setupReport.extensionChannel === "store" ? "Chrome Web Store extension" : "extension";
    const browserFailed = hasDoctorFailures(browserReport);
    const needsPopup = browserResumeRequired(browserReport);
    rows.push(setupReport.dryRun
      ? `Browser pairing would be checked for ${channelLabel} ${setupReport.extensionId}.`
      : browserFailed
        ? `Browser repair ran for ${channelLabel} ${setupReport.extensionId}.`
        : needsPopup
          ? `Browser pairing repaired for ${channelLabel} ${setupReport.extensionId}; extension popup activation is still required.`
          : `Browser pairing ready for ${channelLabel} ${setupReport.extensionId}.`);
    if (browserFailed) {
      const failed = browserReport.checks.filter((check) => check.status === "fail");
      rows.push(`Browser doctor still found ${plural(failed.length, "problem")}: ${failed.map((check) => check.label).join(", ")}.`);
    }
  }

  const agentLine = bootstrapAgentSummary(setupReport);
  if (agentLine) rows.push(agentLine);
  if (browserResumeRequired(browserReport)) {
    rows.push("Open the extension popup; click Resume if it is enabled, otherwise wait for Connected and rerun verify.");
  }
  return rows.join("\n");
}

function bootstrapAgentSummary(setupReport: SetupJson): string | undefined {
  const agentSteps = setupReport.steps.filter((step) =>
    step.id.startsWith("agent-") && step.id !== "agent-adapters" && !step.id.endsWith("-instructions")
  );
  const manualAgents = agentSteps
    .filter((step) => step.status === "manual_action_required")
    .map((step) => step.id.replace(/^agent-/, ""));
  if (manualAgents.length > 0) return `MCP setup needs manual action for: ${manualAgents.join(", ")}.`;

  const configuredAgents = agentSteps
    .filter((step) => step.status === "applied")
    .map((step) => step.id.replace(/^agent-/, ""));
  if (configuredAgents.length > 0) return `MCP agents configured: ${configuredAgents.join(", ")}.`;

  const existingAgents = agentSteps
    .filter((step) => step.status === "skipped")
    .map((step) => step.id.replace(/^agent-/, ""));
  if (existingAgents.length > 0) return `MCP agents already configured: ${existingAgents.join(", ")}.`;

  const adapterStep = setupReport.steps.find((step) => step.id === "agent-adapters");
  if (!adapterStep) return undefined;
  if (/no supported coding agents detected/i.test(adapterStep.message)) return "No supported coding agents were detected.";
  if (/skipped agent adapter wiring/i.test(adapterStep.message)) return "MCP agent setup skipped.";
  return adapterStep.message;
}

function browserResumeRequired(report: DoctorReport | undefined): boolean {
  return report?.checks.some((check) => check.details?.resume_required === true) ?? false;
}

function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function isBrowserRecoveryBoundary(report: SetupJson): boolean {
  const manualSteps = report.steps.filter((step) => step.status === "manual_action_required");
  return manualSteps.length > 0 && manualSteps.every((step) => step.id === "runtime-descriptor-probe");
}

function doctorVerboseCommand(args: ParsedArgs, commandPrefix: string): string {
  const parts = ["doctor"];
  if (args.subject === "browser") parts.push("browser");
  if (args.browser) parts.push(`--browser=${args.browser}`);
  if (args.channel) parts.push(`--channel=${args.channel}`);
  if (args.extensionId) parts.push(`--extension-id=${args.extensionId}`);
  if (args.strict) parts.push("--strict");
  if (args.repair) parts.push("--repair");
  if (args.cleanBackups) parts.push("--clean-backups");
  parts.push("--verbose");
  return appendShellArgs(commandPrefix, parts);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    json: false,
    verbose: false,
    recovery: false,
    repair: false,
    strict: false,
    cleanBackups: false,
    print: false,
    all: false,
    dryRun: false,
    noWait: false,
    yes: false,
    agents: [],
    skipExtension: false,
    skipAgents: false,
    writeInstructions: false,
    requireAgentRuntime: false,
    help: false,
    version: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [flag, inlineValue] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index]!;
    };
    switch (flag) {
      case "--browser":
        args.browser = parseBrowser(readValue());
        break;
      case "--agent":
        args.agent = readValue();
        break;
      case "--agents":
        {
          const value = readValue().trim();
          if (value === "auto" || value.length === 0) {
            args.agents = [];
            args.skipAgents = false;
          } else if (value === "none") {
            args.agents = [];
            args.skipAgents = true;
          } else {
            args.agents = value.split(",").map((entry) => entry.trim()).filter(Boolean);
            args.skipAgents = false;
          }
        }
        break;
      case "--json":
        args.json = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--recovery":
        args.recovery = true;
        break;
      case "--repair":
        args.repair = true;
        break;
      case "--clean-backups":
        args.cleanBackups = true;
        break;
      case "--strict":
        args.strict = true;
        break;
      case "--print":
        args.print = true;
        break;
      case "--all":
        args.all = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--extension-id":
        args.extensionId = readValue();
        break;
      case "--channel":
        args.channel = readValue();
        break;
      case "--path":
        args.extensionPath = readValue();
        break;
      case "--no-wait":
        args.noWait = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--skip-extension":
        args.skipExtension = true;
        break;
      case "--skip-agents":
        args.agents = [];
        args.skipAgents = true;
        break;
      case "--write-instructions":
        args.writeInstructions = true;
        break;
      case "--require-agent-runtime":
        args.requireAgentRuntime = true;
        break;
      case "--profile":
        args.profile = readValue();
        break;
      case "--agent-runtime-challenge-out":
        args.agentRuntimeChallengeOut = readValue();
        break;
      case "--agent-runtime-challenge-json":
        args.agentRuntimeChallengeJson = readValue();
        break;
      case "--agent-runtime-status-json":
        args.agentRuntimeStatusJson = readValue();
        break;
      case "--version":
      case "-V":
        args.version = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
        positional.push(arg);
    }
  }
  args.command = positional[0];
  args.subject = positional[1];
  return args;
}

function parseBrowser(value: string): BrowserKind {
  if (["chrome", "chrome-for-testing", "edge", "brave", "arc", "chromium"].includes(value)) {
    return value as BrowserKind;
  }
  throw new Error(`unsupported browser: ${value}`);
}

function printHelp(): void {
  console.log(`Usage:
  obu --version
  obu bootstrap [--yes] [--browser chrome|chrome-for-testing|edge|brave|arc|chromium|--all] [--agents=auto|none|<list>] [--channel unpacked-dev|store] [--extension-id <id>] [--skip-extension] [--write-instructions] [--dry-run] [--json]
  obu setup [--yes] [--browser chrome|chrome-for-testing|edge|brave|arc|chromium|--all] [--agents=auto|none|<list>] [--channel unpacked-dev|store] [--extension-id <id>] [--skip-extension] [--skip-agents] [--write-instructions] [--dry-run] [--recovery] [--verbose] [--json]
  obu verify --agent=<id> [--browser chrome|chrome-for-testing|edge|brave|arc|chromium] [--profile <path>] [--channel unpacked-dev|store] [--extension-id <id>] [--require-agent-runtime] [--agent-runtime-challenge-out <path>] [--agent-runtime-challenge-json <path>] [--agent-runtime-status-json <path>] [--repair] [--json]
  obu doctor [browser] [--browser chrome|chrome-for-testing|edge|brave|arc|chromium] [--channel unpacked-dev|store] [--extension-id <id>] [--verbose] [--json] [--strict] [--repair] [--clean-backups]
  obu install-host [--browser chrome|chrome-for-testing|edge|brave|arc|chromium|--all] [--channel unpacked-dev|store] [--extension-id <id>] [--dry-run] [--verbose] [--json]
  obu update-extension [--path <dir>] [--channel unpacked-dev] [--no-wait] [--dry-run] [--verbose] [--json]
  obu mcp-config --agent=<id> --print
  obu agent doctor --agent=<id> [--json]
  obu shellenv [shell]
  obu mcp stdio

Agent aliases: codex=codex-cli, claude=claude-code, gemini=gemini-cli.`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
