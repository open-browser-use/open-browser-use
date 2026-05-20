import path from "node:path";

import { installNativeHosts } from "./native-host.js";
import { ensureRuntimeDir, type RuntimeLayout, writeUserConfig } from "./runtime-layout.js";
import { updateExtension, type ExtensionUpdateStep } from "./extension-update.js";
import { type ExtensionChannel, type ExtensionIdSource, userConfigForExtensionTarget } from "./extension-channel.js";
import type { BrowserKind } from "./browser-paths.js";
import { configureAgents, detectInstalledAgents } from "./agents/configure.js";
import type { AgentId, McpServerInvocation } from "./agents/registry.js";
import { appendShellArgs, formatShellCommand } from "./command-line.js";

export type SetupStepStatus = "applied" | "skipped" | "would_apply" | "manual_action_required" | "failed";

export type SetupJson = {
  schemaVersion: 1;
  generatedAt: string;
  obuVersion: string;
  extensionChannel: ExtensionChannel;
  extensionId: string;
  extensionIdSource: ExtensionIdSource;
  dryRun: boolean;
  result: "complete" | "manual_action_required" | "failed";
  steps: Array<{
    id: string;
    status: SetupStepStatus;
    message: string;
    details?: Record<string, unknown>;
  }>;
  nextActions: Array<{ kind: "command" | "manual" | "docs"; value: string }>;
};

export type SetupOptions = {
  layout: RuntimeLayout;
  obuVersion: string;
  browsers: BrowserKind[];
  agents: AgentId[];
  server: McpServerInvocation;
  extensionChannel: ExtensionChannel;
  extensionId: string;
  extensionIdSource: ExtensionIdSource;
  dryRun?: boolean;
  skipExtension?: boolean;
  skipAgents?: boolean;
  writeInstructions?: boolean;
  extensionPath?: string;
  env?: NodeJS.ProcessEnv;
  commandPrefix?: string;
  projectDir?: string;
};

export async function setupOpenBrowserUse(options: SetupOptions): Promise<SetupJson> {
  const dryRun = options.dryRun === true;
  const steps: SetupJson["steps"] = [];
  const nextActions: SetupJson["nextActions"] = [];

  if (dryRun) {
    steps.push({
      id: "runtime-dir",
      status: "would_apply",
      message: `would ensure runtime directory ${options.layout.runtimeDir}`,
      details: { runtimeDir: options.layout.runtimeDir, dryRun: true },
    });
  } else {
    const runtime = await ensureRuntimeDir(options.layout.runtimeDir);
    if (!runtime.ok) {
      steps.push({
        id: "runtime-dir",
        status: "failed",
        message: runtime.message ?? "invalid runtime directory",
        ...(runtime.details ? { details: runtime.details } : {}),
      });
      return finalize(options, steps, nextActions);
    }
    await writeUserConfig(options.layout.userConfigPath, {
      ...userConfigForExtensionTarget(options.layout, {
        channel: options.extensionChannel,
        extensionId: options.extensionId,
        extensionIdSource: options.extensionIdSource,
      }),
    });
    steps.push({
      id: "runtime-dir",
      status: "applied",
      message: `ensured runtime directory ${options.layout.runtimeDir}`,
      details: { runtimeDir: options.layout.runtimeDir },
    });
  }

  const hostActions = await installNativeHosts({
    layout: options.layout,
    browsers: options.browsers,
    dryRun,
    extensionId: options.extensionId,
  });
  for (const action of hostActions) {
    steps.push({
      id: `native-host-${action.browser}`,
      status: setupStatus(action.status),
      message: action.message,
      ...(action.details ? { details: action.details } : {}),
    });
  }

  if (options.extensionChannel === "store") {
    steps.push({
      id: "extension-update",
      status: "skipped",
      message: "store channel uses the Chrome Web Store-installed extension",
      details: {
        extensionChannel: options.extensionChannel,
        extensionId: options.extensionId,
        extensionIdSource: options.extensionIdSource,
      },
    });
  } else if (options.skipExtension) {
    steps.push({
      id: "extension-update",
      status: "skipped",
      message: "skipped extension update",
    });
  } else {
    const extension = await updateExtension({
      layout: options.layout,
      dryRun,
      ...(options.extensionPath ? { sourceDir: options.extensionPath } : {}),
    });
    for (const step of extension.steps) steps.push(mapExtensionStep(step));
    nextActions.push(...extension.nextActions);
  }

  const agentHomeDir = path.dirname(path.dirname(options.layout.userConfigPath));
  const agents = options.skipAgents
    ? []
    : options.agents.length > 0
      ? options.agents
      : await detectInstalledAgents({
        ...(options.env ? { env: options.env } : {}),
        homeDir: agentHomeDir,
      });

  if (options.skipAgents || agents.length === 0) {
    steps.push({
      id: "agent-adapters",
      status: "skipped",
      message: options.skipAgents ? "skipped agent adapter wiring" : "no supported coding agents detected",
    });
  } else {
    const agentSteps = await configureAgents({
      agents,
      server: options.server,
      dryRun,
      ...(options.env ? { env: options.env } : {}),
      homeDir: agentHomeDir,
      ...(options.commandPrefix ? { commandPrefix: options.commandPrefix } : {}),
      ...(options.writeInstructions ? { writeInstructions: options.writeInstructions } : {}),
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
    });
    for (const step of agentSteps) {
      steps.push({
        id: step.id,
        status: step.status,
        message: step.message,
        ...(step.details ? { details: step.details } : {}),
      });
      if (step.nextActions) nextActions.push(...step.nextActions);
    }
  }

  nextActions.push(...verificationActions(options, agents));
  return finalize(options, steps, dedupeActions(nextActions));
}

function verificationActions(options: SetupOptions, agents: AgentId[]): SetupJson["nextActions"] {
  if (agents.length === 0) {
    return options.browsers.map((browser) => ({
      kind: "manual" as const,
      value: `Choose the agent id to verify, then run ${formatSetupCommand(options, verifyCommandArgs(options, browser, "<agent-id>"))}.`,
    }));
  }
  return agents.flatMap((agent) =>
    options.browsers.map((browser) => ({
      kind: "command" as const,
      value: formatSetupCommand(options, verifyCommandArgs(options, browser, agent)),
    }))
  );
}

function verifyCommandArgs(options: SetupOptions, browser: BrowserKind, agent: AgentId | "<agent-id>"): string[] {
  return [
    "verify",
    `--agent=${agent}`,
    `--browser=${browser}`,
    `--channel=${options.extensionChannel}`,
    `--extension-id=${options.extensionId}`,
  ];
}

function formatSetupCommand(options: SetupOptions, args: string[]): string {
  if (options.commandPrefix) return appendShellArgs(options.commandPrefix, args);
  return formatShellCommand(options.layout.openBrowserUseCommand, args);
}

function mapExtensionStep(step: ExtensionUpdateStep): SetupJson["steps"][number] {
  return {
    id: step.id,
    status: setupStatus(step.status),
    message: step.message,
    ...(step.details ? { details: step.details } : {}),
  };
}

function setupStatus(status: string): SetupStepStatus {
  if (status === "failed") return "failed";
  if (status === "manual_action_required") return "manual_action_required";
  if (status === "would_apply") return "would_apply";
  if (status === "skipped") return "skipped";
  return "applied";
}

function finalize(
  options: SetupOptions,
  steps: SetupJson["steps"],
  nextActions: SetupJson["nextActions"],
): SetupJson {
  const result = steps.some((step) => step.status === "failed")
    ? "failed"
    : steps.some((step) => step.status === "manual_action_required")
      ? "manual_action_required"
      : "complete";
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    obuVersion: options.obuVersion,
    extensionChannel: options.extensionChannel,
    extensionId: options.extensionId,
    extensionIdSource: options.extensionIdSource,
    dryRun: options.dryRun === true,
    result,
    steps,
    nextActions,
  };
}

function dedupeActions(actions: SetupJson["nextActions"]): SetupJson["nextActions"] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.kind}:${action.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
