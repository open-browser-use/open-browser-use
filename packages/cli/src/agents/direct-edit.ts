import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import type { AgentId, McpServerInvocation } from "./registry.js";

export type DirectEditAgentId =
  | "cursor"
  | "cline"
  | "windsurf"
  | "claude-desktop"
  | "zed";

export const DIRECT_EDIT_AGENT_IDS: DirectEditAgentId[] = [
  "cursor",
  "cline",
  "windsurf",
  "claude-desktop",
  "zed",
];

export type DirectEditResult =
  | {
    status: "applied";
    path: string;
    backupPath?: string;
    deletedBackups: string[];
  }
  | {
    status: "skipped";
    path: string;
    reason: "unchanged";
  }
  | {
    status: "parse_error";
    path: string;
    errors: string[];
  };

export type DirectEditOptions = {
  homeDir?: string;
  platform?: NodeJS.Platform;
  now?: Date;
};

export type BackupEntry = {
  configPath: string;
  backupPath: string;
  timestamp: string;
};

const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

export function isDirectEditAgentId(agent: AgentId): agent is DirectEditAgentId {
  return ["cursor", "cline", "windsurf", "claude-desktop", "zed"].includes(agent);
}

export function directEditConfigPath(agent: DirectEditAgentId, options: DirectEditOptions = {}): string {
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  switch (agent) {
    case "cursor":
      return path.join(homeDir, ".cursor", "mcp.json");
    case "cline":
      return platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
        : path.join(homeDir, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
    case "windsurf":
      return path.join(homeDir, ".codeium", "windsurf", "mcp_config.json");
    case "claude-desktop":
      return platform === "darwin"
        ? path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : path.join(homeDir, ".config", "Claude", "claude_desktop_config.json");
    case "zed":
      return path.join(homeDir, ".config", "zed", "settings.json");
  }
}

export async function writeDirectEditAgentConfig(
  agent: DirectEditAgentId,
  server: McpServerInvocation,
  options: DirectEditOptions = {},
): Promise<DirectEditResult> {
  const targetPath = directEditConfigPath(agent, options);
  const existing = await readOptionalFile(targetPath);
  const raw = existing ?? "{\n}\n";
  const parseErrors = validateJsonc(raw);
  if (parseErrors.length > 0) {
    return { status: "parse_error", path: targetPath, errors: parseErrors };
  }

  const next = applyServerEdit(raw, agent, server);
  if (next === raw) {
    return { status: "skipped", path: targetPath, reason: "unchanged" };
  }

  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  let backupPath: string | undefined;
  if (existing !== undefined) {
    backupPath = backupPathFor(targetPath, options.now ?? new Date());
    await copyFile(targetPath, backupPath);
  }
  await writeFile(targetPath, next, { encoding: "utf8", mode: 0o600 });
  const deletedBackups = await retainOpenBrowserUseBackups(targetPath, 5);
  return {
    status: "applied",
    path: targetPath,
    ...(backupPath ? { backupPath } : {}),
    deletedBackups,
  };
}

export async function listOpenBrowserUseBackups(
  agents: DirectEditAgentId[],
  options: DirectEditOptions = {},
): Promise<BackupEntry[]> {
  const seen = new Set<string>();
  const all: BackupEntry[] = [];
  for (const agent of agents) {
    const configPath = directEditConfigPath(agent, options);
    if (seen.has(configPath)) continue;
    seen.add(configPath);
    all.push(...await listBackupsForConfig(configPath));
  }
  return all.sort((left, right) => left.backupPath.localeCompare(right.backupPath));
}

export async function cleanOpenBrowserUseBackups(
  agents: DirectEditAgentId[],
  options: DirectEditOptions = {},
): Promise<string[]> {
  const backups = await listOpenBrowserUseBackups(agents, options);
  const deleted: string[] = [];
  for (const backup of backups) {
    await rm(backup.backupPath, { force: true });
    deleted.push(backup.backupPath);
  }
  return deleted;
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

function validateJsonc(raw: string): string[] {
  const errors: ParseError[] = [];
  parse(raw, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.map((error) => `parse error ${error.error} at offset ${error.offset}`);
}

function applyServerEdit(raw: string, agent: DirectEditAgentId, server: McpServerInvocation): string {
  const pathAndValue = directEditPatch(agent, server);
  const edits = modify(raw, pathAndValue.path, pathAndValue.value, { formattingOptions });
  const next = applyEdits(raw, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
}

function directEditPatch(agent: DirectEditAgentId, server: McpServerInvocation): {
  path: Array<string>;
  value: unknown;
} {
  if (agent === "zed") {
    return {
      path: ["context_servers", server.name],
      value: { command: server.command, args: server.args },
    };
  }
  return {
    path: ["mcpServers", server.name],
    value: server,
  };
}

function backupPathFor(configPath: string, now: Date): string {
  return `${configPath}.bak-${utcBackupTimestamp(now)}`;
}

function utcBackupTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function retainOpenBrowserUseBackups(configPath: string, keep: number): Promise<string[]> {
  const backups = await listBackupsForConfig(configPath);
  backups.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const stale = backups.slice(keep);
  for (const entry of stale) {
    await rm(entry.backupPath, { force: true });
  }
  return stale.map((entry) => entry.backupPath);
}

async function listBackupsForConfig(configPath: string): Promise<BackupEntry[]> {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const pattern = new RegExp(`^${escapeRegExp(base)}\\.bak-(\\d{8}T\\d{6}Z)$`);
  const entries = await readdir(dir).catch((error) => {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return [];
    throw error;
  });
  const backups: BackupEntry[] = [];
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (!match) continue;
    const backupPath = path.join(dir, entry);
    if (!await access(backupPath, constants.F_OK).then(() => true).catch(() => false)) continue;
    backups.push({ configPath, backupPath, timestamp: match[1]! });
  }
  return backups;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
