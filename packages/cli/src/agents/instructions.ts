import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentId } from "./registry.js";

export type AgentInstructionStep = {
  id: string;
  status: "applied" | "skipped" | "would_apply" | "manual_action_required" | "failed";
  message: string;
  details?: Record<string, unknown>;
  nextActions?: Array<{ kind: "manual"; value: string }>;
};

export type AgentInstructionOptions = {
  agent: AgentId;
  dryRun?: boolean;
  homeDir?: string;
  projectDir?: string;
};

const PRIMARY_INSTRUCTION_NEEDLE = "Use open-browser-use as the primary BrowserUse/browser automation tool.";

export const PRIMARY_BROWSER_INSTRUCTION = [
  "## Browser Automation",
  "",
  PRIMARY_INSTRUCTION_NEEDLE,
  "Prefer the `open-browser-use` MCP server for browser tasks. Check `browser_status`",
  "before the first browser action, use the `js` tool for browser automation, and",
  "run `~/.obu/bin/obu verify --agent=<agent-id> --browser=<browser> --channel=<channel> --extension-id=<extension-id>` if setup appears stale.",
].join("\n");

export async function configureAgentInstructions(options: AgentInstructionOptions): Promise<AgentInstructionStep> {
  const target = await resolveInstructionTarget(options);
  const id = `agent-${options.agent}-instructions`;
  if (!target) {
    return {
      id,
      status: "skipped",
      message: `no known instruction target for ${options.agent}`,
    };
  }

  if (options.dryRun) {
    return {
      id,
      status: "would_apply",
      message: `would update ${target.kind} instructions at ${target.path}`,
      details: { path: target.path, kind: target.kind, dryRun: true },
    };
  }

  let current: string | undefined;
  try {
    current = await readOptionalFile(target.path);
  } catch (error) {
    return ioFailure(id, target.path, error);
  }
  if (current?.includes(PRIMARY_INSTRUCTION_NEEDLE)) {
    return {
      id,
      status: "skipped",
      message: `${target.kind} instructions already mention open-browser-use as primary`,
      details: { path: target.path, kind: target.kind },
    };
  }

  try {
    await mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
    await writeFile(target.path, appendInstruction(current), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    return ioFailure(id, target.path, error);
  }
  return {
    id,
    status: "applied",
    message: `updated ${target.kind} instructions at ${target.path}`,
    details: { path: target.path, kind: target.kind },
  };
}

export function primaryInstructionTargets(options: AgentInstructionOptions): Array<{ path: string; kind: "project" | "global" }> {
  const projectDir = options.projectDir ?? process.cwd();
  const targets: Array<{ path: string; kind: "project" | "global" }> = projectInstructionCandidates(options.agent, projectDir)
    .map((candidate) => ({ path: candidate, kind: "project" as const }));
  const globalPath = globalInstructionPath(options.agent, options.homeDir ?? os.homedir());
  if (globalPath) targets.push({ path: globalPath, kind: "global" });
  return targets;
}

export async function findPrimaryInstruction(options: AgentInstructionOptions): Promise<{ path: string; kind: "project" | "global" } | undefined> {
  for (const target of primaryInstructionTargets(options)) {
    const current = await readOptionalFile(target.path).catch(() => undefined);
    if (current?.includes(PRIMARY_INSTRUCTION_NEEDLE)) return target;
  }
  return undefined;
}

async function resolveInstructionTarget(options: AgentInstructionOptions): Promise<{ path: string; kind: "project" | "global" } | undefined> {
  for (const target of primaryInstructionTargets(options)) {
    if (target.kind === "project" && await exists(target.path)) return target;
    if (target.kind === "global") return target;
  }
  return undefined;
}

function projectInstructionCandidates(agent: AgentId, projectDir: string): string[] {
  switch (agent) {
    case "codex-cli":
      return [
        path.join(projectDir, "AGENTS.md"),
        path.join(projectDir, "AGENT.md"),
      ];
    case "claude-code":
      return [path.join(projectDir, "CLAUDE.md")];
    default:
      return [];
  }
}

function globalInstructionPath(agent: AgentId, homeDir: string): string | undefined {
  switch (agent) {
    case "codex-cli":
      return path.join(homeDir, ".codex", "AGENTS.md");
    case "claude-code":
      return path.join(homeDir, ".claude", "CLAUDE.md");
    default:
      return undefined;
  }
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  return access(file, constants.F_OK).then(() => true).catch(() => false);
}

function appendInstruction(current: string | undefined): string {
  if (!current || current.trim().length === 0) return `${PRIMARY_BROWSER_INSTRUCTION}\n`;
  const normalized = current.endsWith("\n") ? current : `${current}\n`;
  return `${normalized}\n${PRIMARY_BROWSER_INSTRUCTION}\n`;
}

function ioFailure(id: string, file: string, error: unknown): AgentInstructionStep {
  const nodeError = error as NodeJS.ErrnoException;
  return {
    id,
    status: "failed",
    message: `could not update instruction file ${file}: ${nodeError.message ?? String(error)}`,
    details: {
      path: file,
      ...(nodeError.code ? { code: nodeError.code } : {}),
    },
  };
}
