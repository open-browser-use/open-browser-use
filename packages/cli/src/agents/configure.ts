import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { renderAgentMcpConfig, type AgentId, type McpServerInvocation } from "./registry.js";
import { appendShellArgs } from "../command-line.js";
import {
  canAutoConfigureDirectEditAgent,
  isDirectEditAgentId,
  writeDirectEditAgentConfig,
  type DirectEditOptions,
} from "./direct-edit.js";

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
    if (agent === "cursor") {
      steps.push(await configureCursor(
        config,
        options.server,
        env,
        options.dryRun === true,
        directEditOptions,
        manualAction,
        options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
      ));
      continue;
    }
    if (config.mode !== "shell") {
      if (config.mode === "json" && isDirectEditAgentId(agent)) {
        steps.push(await configureDirectEdit(agent, options.server, options.dryRun === true, directEditOptions, manualAction));
        continue;
      }
      steps.push({
        id: `agent-${agent}`,
        status: "manual_action_required",
        message: `manual MCP configuration is required for ${agent}`,
        details: { mode: config.mode, config },
        nextActions: [manualAction],
      });
      continue;
    }
    steps.push(await configureShell(
      agent,
      config,
      env,
      options.dryRun === true,
      manualAction,
      undefined,
      options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
    ));
  }
  return steps;
}

async function isAgentInstalled(agent: AgentId, env: NodeJS.ProcessEnv, directEditOptions: DirectEditOptions): Promise<boolean> {
  const config = renderAgentMcpConfig(agent, { name: "open-browser-use", command: "obu", args: ["mcp", "stdio"] });
  if (config.mode === "shell" && await findExecutable(config.executable, env)) return true;
  if (isDirectEditAgentId(agent)) return canAutoConfigureDirectEditAgent(agent, directEditOptions);
  return false;
}

async function configureCursor(
  config: ReturnType<typeof renderAgentMcpConfig>,
  server: McpServerInvocation,
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
  directEditOptions: DirectEditOptions,
  manualAction: AgentNextAction,
  adapterTimeoutMs: number,
): Promise<AgentConfigureStep> {
  if (config.mode !== "shell") {
    return configureDirectEdit("cursor", server, dryRun, directEditOptions, manualAction);
  }
  const executable = await findExecutable(config.executable, env);
  if (executable) {
    const help = await runAdapter(executable, ["--help"], env, adapterTimeoutMs);
    if (help.code === 0 && /--add-mcp\b/.test(`${help.stdout}\n${help.stderr}`)) {
      return configureShell("cursor", config, env, dryRun, manualAction, executable, adapterTimeoutMs);
    }
  }
  return configureDirectEdit("cursor", server, dryRun, directEditOptions, manualAction);
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
