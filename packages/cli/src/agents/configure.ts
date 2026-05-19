import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { renderAgentMcpConfig, type AgentId, type McpServerInvocation } from "./registry.js";
import { appendShellArgs } from "../command-line.js";
import {
  canAutoConfigureCodex,
  equivalentCodexServer,
  readCodexMcpServer,
  writeCodexMcpServer,
} from "./codex-config.js";
import {
  canAutoConfigureDirectEditAgent,
  isDirectEditAgentId,
  writeDirectEditAgentConfig,
  type DirectEditOptions,
} from "./direct-edit.js";
import { configureAgentInstructions } from "./instructions.js";

export type AgentConfigureStep = {
  id: string;
  status: "applied" | "skipped" | "would_apply" | "manual_action_required" | "failed";
  message: string;
  details?: Record<string, unknown>;
  nextActions?: Array<{ kind: "command" | "manual" | "docs"; value: string }>;
};

type AgentNextAction = NonNullable<AgentConfigureStep["nextActions"]>[number];

export type ConfigureAgentsOptions = {
  agents: AgentId[];
  server: McpServerInvocation;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  now?: Date;
  commandPrefix?: string;
  adapterTimeoutMs?: number;
  writeInstructions?: boolean;
  projectDir?: string;
};

export type DetectInstalledAgentsOptions = Pick<ConfigureAgentsOptions, "env" | "homeDir" | "platform">;

const AUTO_DETECT_AGENT_IDS: AgentId[] = [
  "codex-cli",
  "claude-code",
  "gemini-cli",
  "vscode",
  "cursor",
  "cline",
  "windsurf",
  "claude-desktop",
  "zed",
];
const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;

export async function detectInstalledAgents(options: DetectInstalledAgentsOptions = {}): Promise<AgentId[]> {
  const env = options.env ?? process.env;
  const directEditOptions: DirectEditOptions = {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  };
  const detected: AgentId[] = [];
  for (const agent of AUTO_DETECT_AGENT_IDS) {
    if (await isAgentInstalled(agent, env, directEditOptions)) detected.push(agent);
  }
  return detected;
}

export async function configureAgents(options: ConfigureAgentsOptions): Promise<AgentConfigureStep[]> {
  const steps: AgentConfigureStep[] = [];
  const env = options.env ?? process.env;
  const directEditOptions: DirectEditOptions = {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  for (const agent of options.agents) {
    const config = renderAgentMcpConfig(agent, options.server);
    const manualAction = {
      kind: "command" as const,
      value: appendShellArgs(options.commandPrefix ?? "obu", ["mcp-config", `--agent=${agent}`, "--print"]),
    };
    let step: AgentConfigureStep;
    if (agent === "codex-cli") {
      step = await configureCodex(options.server, options.dryRun === true, directEditOptions, manualAction);
      steps.push(step);
      steps.push(...await maybeConfigureInstructions(options, agent));
      continue;
    }
    if (config.mode !== "shell") {
      if (config.mode === "json" && isDirectEditAgentId(agent)) {
        step = await configureDirectEdit(agent, options.server, options.dryRun === true, directEditOptions, manualAction);
        steps.push(step);
        steps.push(...await maybeConfigureInstructions(options, agent));
        continue;
      }
      step = {
        id: `agent-${agent}`,
        status: "manual_action_required",
        message: `manual MCP configuration is required for ${agent}`,
        details: { mode: config.mode, config },
        nextActions: [manualAction],
      };
      steps.push(step);
      steps.push(...await maybeConfigureInstructions(options, agent));
      continue;
    }
    step = await configureShell(
      agent,
      config,
      env,
      options.dryRun === true,
      manualAction,
      undefined,
      options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
    );
    steps.push(step);
    steps.push(...await maybeConfigureInstructions(options, agent));
  }
  return steps;
}

async function maybeConfigureInstructions(options: ConfigureAgentsOptions, agent: AgentId): Promise<AgentConfigureStep[]> {
  if (!options.writeInstructions) return [];
  return [
    await configureAgentInstructions({
      agent,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
    }),
  ];
}

async function isAgentInstalled(agent: AgentId, env: NodeJS.ProcessEnv, directEditOptions: DirectEditOptions): Promise<boolean> {
  const config = renderAgentMcpConfig(agent, { name: "open-browser-use", command: "obu", args: ["mcp", "stdio"] });
  if (agent === "codex-cli") {
    return await findExecutable(config.mode === "shell" ? config.executable : "codex", env) !== undefined ||
      await canAutoConfigureCodex(directEditOptions);
  }
  if (agent === "cursor" && await findExecutable("cursor", env)) return true;
  if (config.mode === "shell" && await findExecutable(config.executable, env)) return true;
  if (isDirectEditAgentId(agent)) return canAutoConfigureDirectEditAgent(agent, directEditOptions);
  return false;
}

async function configureCodex(
  server: McpServerInvocation,
  dryRun: boolean,
  options: DirectEditOptions,
  manualAction: AgentNextAction,
): Promise<AgentConfigureStep> {
  if (dryRun) {
    return {
      id: "agent-codex-cli",
      status: "would_apply",
      message: "would update codex-cli MCP config",
      details: { dryRun: true },
    };
  }
  const current = await readCodexMcpServer(server.name, options);
  if (current.status === "found" && equivalentCodexServer(current.server, server)) {
    return {
      id: "agent-codex-cli",
      status: "skipped",
      message: "codex-cli already has an equivalent open-browser-use MCP server",
      details: { path: current.path },
    };
  }
  if (current.status === "found") {
    return {
      id: "agent-codex-cli",
      status: "manual_action_required",
      message: "codex-cli already has an open-browser-use MCP server with different settings",
      details: { path: current.path, expected: server, actual: current.server },
      nextActions: [manualAction],
    };
  }
  if (current.status === "error") {
    return {
      id: "agent-codex-cli",
      status: "manual_action_required",
      message: "codex-cli MCP config could not be read; configure it manually",
      details: { path: current.path, message: current.message, ...(current.code ? { code: current.code } : {}) },
      nextActions: [manualAction],
    };
  }
  const result = await writeCodexMcpServer(server, options);
  if (result.status === "skipped") {
    return {
      id: "agent-codex-cli",
      status: "skipped",
      message: "codex-cli MCP config is unchanged",
      details: { path: result.path },
    };
  }
  if (result.status === "io_error") {
    return {
      id: "agent-codex-cli",
      status: "manual_action_required",
      message: "codex-cli MCP config could not be written; configure it manually",
      details: { path: result.path, message: result.message, ...(result.code ? { code: result.code } : {}) },
      nextActions: [manualAction],
    };
  }
  return {
    id: "agent-codex-cli",
    status: "applied",
    message: "updated codex-cli MCP config",
    details: { path: result.path, ...(result.backupPath ? { backupPath: result.backupPath } : {}) },
  };
}

async function configureShell(
  agent: AgentId,
  config: Extract<ReturnType<typeof renderAgentMcpConfig>, { mode: "shell" }>,
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
  manualAction: AgentNextAction,
  resolvedExecutable?: string,
  adapterTimeoutMs = DEFAULT_ADAPTER_TIMEOUT_MS,
): Promise<AgentConfigureStep> {
  if (dryRun) {
    return {
      id: `agent-${agent}`,
      status: "would_apply",
      message: `would run ${config.executable} adapter for ${agent}`,
      details: { shellCommand: config.shellCommand, dryRun: true },
    };
  }
  const executable = resolvedExecutable ?? await findExecutable(config.executable, env);
  if (!executable) {
    return {
      id: `agent-${agent}`,
      status: "manual_action_required",
      message: `${config.executable} was not found on PATH; configure ${agent} manually`,
      details: { shellCommand: config.shellCommand },
      nextActions: [manualAction],
    };
  }

  const probeArgs = shellProbeArgs(agent);
  if (probeArgs) {
    const probe = await runAdapter(executable, probeArgs, env, adapterTimeoutMs);
    if (probe.timedOut) {
      return {
        id: `agent-${agent}`,
        status: "manual_action_required",
        message: `${config.executable} adapter probe timed out; configure ${agent} manually`,
        details: { executable, probe: [config.executable, ...probeArgs].join(" "), timeout_ms: adapterTimeoutMs },
        nextActions: [manualAction],
      };
    }
    const existing = existingShellServerState(`${probe.stdout}\n${probe.stderr}`, config.server);
    if (probe.code === 0 && existing === "equivalent") {
      return {
        id: `agent-${agent}`,
        status: "skipped",
        message: `${agent} already has an equivalent ${config.server.name} MCP server`,
        details: { executable, probe: [config.executable, ...probeArgs].join(" ") },
      };
    }
    if (probe.code === 0 && existing === "divergent") {
      return {
        id: `agent-${agent}`,
        status: "manual_action_required",
        message: `${agent} already has a ${config.server.name} MCP server with different settings`,
        details: { executable, probe: [config.executable, ...probeArgs].join(" ") },
        nextActions: [manualAction],
      };
    }
  }

  const result = await runAdapter(executable, config.args, env, adapterTimeoutMs);
  if (result.code === 0) {
    return {
      id: `agent-${agent}`,
      status: "applied",
      message: `configured ${agent} MCP server through ${config.executable}`,
      details: { executable, args: config.args },
    };
  }
  return {
    id: `agent-${agent}`,
    status: "manual_action_required",
    message: result.timedOut
      ? `${config.executable} adapter timed out; configure ${agent} manually`
      : `${config.executable} adapter did not complete; configure ${agent} manually`,
    details: {
      executable,
      args: config.args,
      code: result.code,
      stderr: result.stderr.trim(),
      ...(result.timedOut ? { timeout_ms: adapterTimeoutMs } : {}),
    },
    nextActions: [manualAction],
  };
}

async function configureDirectEdit(
  agent: Extract<AgentId, "cursor" | "cline" | "windsurf" | "claude-desktop" | "zed">,
  server: McpServerInvocation,
  dryRun: boolean,
  directEditOptions: DirectEditOptions,
  manualAction: AgentNextAction,
): Promise<AgentConfigureStep> {
  if (dryRun) {
    return {
      id: `agent-${agent}`,
      status: "would_apply",
      message: `would update ${agent} MCP config`,
      details: { dryRun: true },
    };
  }
  const result = await writeDirectEditAgentConfig(agent, server, directEditOptions);
  if (result.status === "skipped") {
    return {
      id: `agent-${agent}`,
      status: "skipped",
      message: `${agent} MCP config is unchanged`,
      details: { path: result.path },
    };
  }
  if (result.status === "parse_error") {
    return {
      id: `agent-${agent}`,
      status: "manual_action_required",
      message: `${agent} MCP config could not be parsed; configure it manually`,
      details: { path: result.path, errors: result.errors },
      nextActions: [manualAction],
    };
  }
  if (result.status === "io_error") {
    return {
      id: `agent-${agent}`,
      status: "manual_action_required",
      message: `${agent} MCP config could not be read or written; configure it manually`,
      details: {
        path: result.path,
        message: result.message,
        ...(result.code ? { code: result.code } : {}),
      },
      nextActions: [manualAction],
    };
  }
  return {
    id: `agent-${agent}`,
    status: "applied",
    message: `updated ${agent} MCP config`,
    details: {
      path: result.path,
      ...(result.backupPath ? { backupPath: result.backupPath } : {}),
      deletedBackups: result.deletedBackups,
    },
  };
}

async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathValue = env.PATH ?? "";
  const candidates = pathValue.split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, name));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true).catch(() => false)) return candidate;
  }
  return undefined;
}

function runAdapter(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, Math.max(1, timeoutMs));
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: error.message });
    });
    child.on("exit", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

function shellProbeArgs(agent: AgentId): string[] | undefined {
  switch (agent) {
    case "codex-cli":
    case "claude-code":
    case "gemini-cli":
      return ["mcp", "list"];
    default:
      return undefined;
  }
}

function existingShellServerState(output: string, server: McpServerInvocation): "missing" | "equivalent" | "divergent" {
  if (!output.includes(server.name)) return "missing";
  const expectedParts = [server.command, ...server.args];
  return expectedParts.every((part) => output.includes(part)) ? "equivalent" : "divergent";
}
