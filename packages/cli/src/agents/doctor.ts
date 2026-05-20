import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { parse, type ParseError } from "jsonc-parser";

import { directEditConfigPath, isDirectEditAgentId } from "./direct-edit.js";
import {
  findPrimaryInstruction,
  PRIMARY_BROWSER_INSTRUCTION,
  primaryInstructionTargets,
} from "./instructions.js";
import { equivalentCodexServer, readCodexMcpServer } from "./codex-config.js";
import { renderAgentMcpConfig, type AgentId, type McpServerInvocation } from "./registry.js";

export type AgentDoctorStatus = "pass" | "warn" | "fail";

export type AgentDoctorCheck = {
  id: string;
  label: string;
  status: AgentDoctorStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type AgentDoctorReport = {
  agent: AgentId;
  checks: AgentDoctorCheck[];
};

export type AgentDoctorOptions = {
  agent: AgentId;
  server: McpServerInvocation;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  projectDir?: string;
  adapterTimeoutMs?: number;
};

const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000;
const MCP_LIST_AGENT_IDS = new Set<AgentId>(["codex-cli", "claude-code", "gemini-cli"]);

export async function doctorAgent(options: AgentDoctorOptions): Promise<AgentDoctorReport> {
  const checks = [
    await checkMcpServer(options),
    await checkPrimaryInstruction(options),
  ];
  return { agent: options.agent, checks };
}

export function formatAgentDoctorReport(report: AgentDoctorReport): string {
  const counts = {
    pass: report.checks.filter((check) => check.status === "pass").length,
    warn: report.checks.filter((check) => check.status === "warn").length,
    fail: report.checks.filter((check) => check.status === "fail").length,
  };
  return [
    `open-browser-use agent doctor: ${report.agent}`,
    `${counts.pass} passed, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.fail} failed.`,
    "",
    ...report.checks.map((check) => `${check.status.toUpperCase().padEnd(4)} ${check.label}: ${check.message}`),
  ].join("\n");
}

export function hasAgentDoctorFailures(report: AgentDoctorReport): boolean {
  return report.checks.some((check) => check.status === "fail");
}

async function checkMcpServer(options: AgentDoctorOptions): Promise<AgentDoctorCheck> {
  const config = renderAgentMcpConfig(options.agent, options.server);
  if (options.agent === "codex-cli") {
    const configCheck = await checkCodexConfigMcpServer(options);
    if (configCheck) return configCheck;
  }
  if (isDirectEditAgentId(options.agent)) {
    return checkDirectEditMcpConfig(options);
  }
  if (!MCP_LIST_AGENT_IDS.has(options.agent)) {
    return warn("agent-mcp-server", "MCP server", `automatic MCP doctor is not implemented for ${options.agent}`, {
      mode: config.mode,
    });
  }
  if (config.mode !== "shell") {
    return warn("agent-mcp-server", "MCP server", `automatic MCP doctor is not implemented for ${options.agent}`, {
      mode: config.mode,
    });
  }
  const executable = await findExecutable(config.executable, options.env ?? process.env);
  if (!executable) {
    return fail("agent-mcp-server", "MCP server", `${config.executable} was not found on PATH`, {
      executable: config.executable,
    });
  }
  const probe = await runAdapter(executable, ["mcp", "list"], options.env ?? process.env, options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS);
  if (probe.timedOut) {
    return fail("agent-mcp-server", "MCP server", `${config.executable} mcp list timed out`, {
      executable,
      timeout_ms: options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
    });
  }
  if (probe.code !== 0) {
    return fail("agent-mcp-server", "MCP server", `${config.executable} mcp list did not complete`, {
      executable,
      code: probe.code,
      stderr: probe.stderr.trim(),
    });
  }
  const output = `${probe.stdout}\n${probe.stderr}`;
  if (!output.includes(options.server.name)) {
    return fail("agent-mcp-server", "MCP server", `${options.agent} does not list ${options.server.name}`, {
      executable,
    });
  }
  const expectedParts = [options.server.command, ...options.server.args];
  if (!expectedParts.every((part) => output.includes(part))) {
    return fail("agent-mcp-server", "MCP server", `${options.agent} lists ${options.server.name} with different settings`, {
      executable,
      expected: options.server,
    });
  }
  return pass("agent-mcp-server", "MCP server", `${options.agent} lists ${options.server.name}`, {
    executable,
  });
}

async function checkCodexConfigMcpServer(options: AgentDoctorOptions): Promise<AgentDoctorCheck | undefined> {
  const state = await readCodexMcpServer(options.server.name, {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  if (state.status === "error") {
    const parsed = state.code === "PARSE_ERROR";
    return fail("agent-mcp-server", "MCP server", parsed ? "codex-cli MCP config could not be parsed" : "codex-cli MCP config could not be read", {
      path: state.path,
      message: state.message,
      ...(state.code ? { code: state.code } : {}),
    });
  }
  if (state.status === "missing") {
    return undefined;
  }
  if (!equivalentCodexServer(state.server, options.server)) {
    return fail("agent-mcp-server", "MCP server", `Codex config lists ${options.server.name} with different settings`, {
      path: state.path,
      expected: options.server,
      actual: state.server,
    });
  }
  return pass("agent-mcp-server", "MCP server", `codex-cli configures ${options.server.name}`, {
    path: state.path,
  });
}

async function checkDirectEditMcpConfig(options: AgentDoctorOptions): Promise<AgentDoctorCheck> {
  const agent = options.agent;
  if (!isDirectEditAgentId(agent)) {
    return warn("agent-mcp-server", "MCP server", `automatic MCP doctor is not implemented for ${agent}`);
  }
  const configPath = directEditConfigPath(agent, {
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  const raw = await readOptionalFile(configPath).catch((error): ReadConfigResult => {
    const nodeError = error as NodeJS.ErrnoException;
    return {
      status: "error",
      error: nodeError.message ?? String(error),
      ...(nodeError.code ? { code: nodeError.code } : {}),
    };
  });
  if (raw.status === "missing") {
    return fail("agent-mcp-server", "MCP server", `${options.agent} MCP config not found at ${configPath}`, {
      path: configPath,
    });
  }
  if (raw.status === "error") {
    return fail("agent-mcp-server", "MCP server", `${options.agent} MCP config could not be read`, {
      path: configPath,
      ...raw,
    });
  }
  const errors: ParseError[] = [];
  const parsed = parse(raw.content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    return fail("agent-mcp-server", "MCP server", `${options.agent} MCP config could not be parsed`, {
      path: configPath,
      errors: errors.map((error) => `parse error ${error.error} at offset ${error.offset}`),
    });
  }
  const serverConfig = directEditServerConfig(parsed, options.agent, options.server.name);
  if (!isRecord(serverConfig)) {
    return fail("agent-mcp-server", "MCP server", `${options.agent} does not configure ${options.server.name}`, {
      path: configPath,
    });
  }
  if (!equivalentServerConfig(serverConfig, options.server, options.agent)) {
    return fail("agent-mcp-server", "MCP server", `${options.agent} configures ${options.server.name} with different settings`, {
      path: configPath,
      expected: options.server,
      actual: serverConfig,
    });
  }
  return pass("agent-mcp-server", "MCP server", `${options.agent} configures ${options.server.name}`, {
    path: configPath,
  });
}

type ReadConfigResult =
  | { status: "ok"; content: string }
  | { status: "missing" }
  | { status: "error"; error: string; code?: string };

async function readOptionalFile(file: string): Promise<ReadConfigResult> {
  try {
    return { status: "ok", content: await readFile(file, "utf8") };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return { status: "missing" };
    throw error;
  }
}

async function checkPrimaryInstruction(options: AgentDoctorOptions): Promise<AgentDoctorCheck> {
  const found = await findPrimaryInstruction({
    agent: options.agent,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
  });
  if (found) {
    return pass("agent-primary-instruction", "Primary browser instruction", `found in ${found.path}`, found);
  }
  const targets = primaryInstructionTargets({
    agent: options.agent,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
  });
  if (targets.length === 0) {
    return warn("agent-primary-instruction", "Primary browser instruction", `instruction check is not implemented for ${options.agent}`);
  }
  return fail("agent-primary-instruction", "Primary browser instruction", "open-browser-use primary instruction not found", {
    checked: targets.map((target) => target.path),
    remediation: PRIMARY_BROWSER_INSTRUCTION,
  });
}

function directEditServerConfig(config: unknown, agent: AgentId, serverName: string): unknown {
  if (!isRecord(config)) return undefined;
  if (agent === "zed") {
    return isRecord(config.context_servers) ? config.context_servers[serverName] : undefined;
  }
  return isRecord(config.mcpServers) ? config.mcpServers[serverName] : undefined;
}

function equivalentServerConfig(config: Record<string, unknown>, server: McpServerInvocation, agent: AgentId): boolean {
  const expectedName = agent === "zed" || config.name === undefined ? undefined : server.name;
  return (
    (expectedName === undefined || config.name === expectedName) &&
    config.command === server.command &&
    Array.isArray(config.args) &&
    config.args.length === server.args.length &&
    config.args.every((arg, index) => arg === server.args[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    timeout = setTimeout(() => {
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

function pass(id: string, label: string, message: string, details?: Record<string, unknown>): AgentDoctorCheck {
  return check(id, label, "pass", message, details);
}

function warn(id: string, label: string, message: string, details?: Record<string, unknown>): AgentDoctorCheck {
  return check(id, label, "warn", message, details);
}

function fail(id: string, label: string, message: string, details?: Record<string, unknown>): AgentDoctorCheck {
  return check(id, label, "fail", message, details);
}

function check(
  id: string,
  label: string,
  status: AgentDoctorStatus,
  message: string,
  details?: Record<string, unknown>,
): AgentDoctorCheck {
  return {
    id,
    label,
    status,
    message,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}
