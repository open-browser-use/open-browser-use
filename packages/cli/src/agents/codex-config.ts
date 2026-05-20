import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { McpServerInvocation } from "./registry.js";

export type CodexConfigOptions = {
  homeDir?: string;
  now?: Date;
};

export type CodexMcpServerState =
  | { status: "missing"; path: string }
  | { status: "found"; path: string; server: { command?: string; args?: string[] } }
  | { status: "error"; path: string; message: string; code?: string };

export type CodexMcpWriteResult =
  | { status: "applied"; path: string; backupPath?: string }
  | { status: "skipped"; path: string; reason: "unchanged" }
  | { status: "parse_error"; path: string; message: string; code: "PARSE_ERROR" }
  | { status: "io_error"; path: string; message: string; code?: string };

export function codexConfigPath(options: CodexConfigOptions = {}): string {
  return path.join(options.homeDir ?? os.homedir(), ".codex", "config.toml");
}

export async function canAutoConfigureCodex(options: CodexConfigOptions = {}): Promise<boolean> {
  const configPath = codexConfigPath(options);
  if (await exists(configPath)) return true;
  return exists(path.dirname(configPath));
}

export async function readCodexMcpServer(
  serverName: string,
  options: CodexConfigOptions = {},
): Promise<CodexMcpServerState> {
  const configPath = codexConfigPath(options);
  const raw = await readOptionalFile(configPath).catch((error): CodexMcpServerState => ioState(configPath, error));
  if (raw === undefined) return { status: "missing", path: configPath };
  if (typeof raw !== "string") return raw;
  const parseIssue = validateCodexToml(raw);
  if (parseIssue) return codexParseState(configPath, parseIssue);
  const table = findMcpServerTable(raw, serverName);
  if (!table) return { status: "missing", path: configPath };
  return { status: "found", path: configPath, server: parseServerTable(table.body) };
}

export async function writeCodexMcpServer(
  server: McpServerInvocation,
  options: CodexConfigOptions = {},
): Promise<CodexMcpWriteResult> {
  const configPath = codexConfigPath(options);
  let existing: string | undefined;
  try {
    existing = await readOptionalFile(configPath);
  } catch (error) {
    return ioError(configPath, error);
  }

  const raw = existing ?? "";
  if (existing !== undefined) {
    const parseIssue = validateCodexToml(raw);
    if (parseIssue) return codexParseError(configPath, parseIssue);
  }
  const table = renderMcpServerTable(server);
  const current = findMcpServerTable(raw, server.name);
  const next = current
    ? `${raw.slice(0, current.start)}${table}${raw.slice(current.end).replace(/^\n+/, "\n")}`
    : appendTable(raw, table);

  if (next === raw) return { status: "skipped", path: configPath, reason: "unchanged" };

  try {
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    let backupPath: string | undefined;
    if (existing !== undefined) {
      backupPath = `${configPath}.bak-${utcBackupTimestamp(options.now ?? new Date())}`;
      await copyFile(configPath, backupPath);
    }
    await writeFile(configPath, next, { encoding: "utf8", mode: 0o600 });
    return { status: "applied", path: configPath, ...(backupPath ? { backupPath } : {}) };
  } catch (error) {
    return ioError(configPath, error);
  }
}

export function equivalentCodexServer(
  actual: { command?: string; args?: string[] },
  expected: McpServerInvocation,
): boolean {
  return (
    actual.command === expected.command &&
    Array.isArray(actual.args) &&
    actual.args.length === expected.args.length &&
    actual.args.every((arg, index) => arg === expected.args[index])
  );
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

const TOML_KEY_PATTERN = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+))*`;
const TOML_TABLE_HEADER_PATTERN = new RegExp(String.raw`^\s*\[\s*${TOML_KEY_PATTERN}\s*\]\s*$`);
const TOML_ARRAY_TABLE_HEADER_PATTERN = new RegExp(String.raw`^\s*\[\[\s*${TOML_KEY_PATTERN}\s*\]\]\s*$`);

type TomlStringState = {
  quote: `"` | "'";
  multiline: boolean;
  escaped: boolean;
  startedAtLine: number;
  startedAtColumn: number;
};

function validateCodexToml(raw: string): string | undefined {
  let stringState: TomlStringState | undefined;
  let inComment = false;
  let bracketDepth = 0;
  const lines = raw.match(/^.*(?:\r?\n|$)/gm) ?? [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const lineNumber = lineIndex + 1;
    if (!stringState && bracketDepth === 0 && line.trimStart().startsWith("[")) {
      const header = stripTomlLineComment(line).trim();
      if (!TOML_TABLE_HEADER_PATTERN.test(header) && !TOML_ARRAY_TABLE_HEADER_PATTERN.test(header)) {
        return `malformed table header at line ${lineNumber}`;
      }
    }

    for (let column = 0; column < line.length; column += 1) {
      const char = line[column]!;
      const columnNumber = column + 1;
      if (char === "\r" || char === "\n") {
        if (stringState && !stringState.multiline) {
          return `unterminated string starting at line ${stringState.startedAtLine}, column ${stringState.startedAtColumn}`;
        }
        inComment = false;
        continue;
      }
      if (inComment) continue;
      if (stringState) {
        if (stringState.quote === `"` && stringState.escaped) {
          stringState.escaped = false;
          continue;
        }
        if (stringState.quote === `"` && char === "\\") {
          stringState.escaped = true;
          continue;
        }
        if (char === stringState.quote) {
          if (stringState.multiline) {
            if (line[column + 1] === char && line[column + 2] === char) {
              stringState = undefined;
              column += 2;
            }
          } else {
            stringState = undefined;
          }
        }
        continue;
      }
      if (char === "#") {
        inComment = true;
        continue;
      }
      if (char === `"` || char === "'") {
        const multiline = line[column + 1] === char && line[column + 2] === char;
        stringState = {
          quote: char,
          multiline,
          escaped: false,
          startedAtLine: lineNumber,
          startedAtColumn: columnNumber,
        };
        if (multiline) column += 2;
        continue;
      }
      if (char === "[") {
        bracketDepth += 1;
        continue;
      }
      if (char === "]") {
        bracketDepth -= 1;
        if (bracketDepth < 0) return `unexpected closing bracket at line ${lineNumber}, column ${columnNumber}`;
      }
    }
  }

  if (stringState) {
    return `unterminated string starting at line ${stringState.startedAtLine}, column ${stringState.startedAtColumn}`;
  }
  if (bracketDepth > 0) return "unterminated bracketed expression";
  return undefined;
}

function stripTomlLineComment(line: string): string {
  let inString: `"` | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (inString) {
      if (inString === `"` && escaped) {
        escaped = false;
      } else if (inString === `"` && char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = undefined;
      }
      continue;
    }
    if (char === `"` || char === "'") {
      inString = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function findMcpServerTable(raw: string, serverName: string): { start: number; end: number; body: string } | undefined {
  const tablePattern = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\.${tomlKeyPattern(serverName)}\\s*\\]\\s*(?:#.*)?$`,
  );
  const lines = raw.match(/^.*(?:\r?\n|$)/gm) ?? [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const content = line.replace(/\r?\n$/, "");
    if (!tablePattern.test(content)) {
      offset += line.length;
      continue;
    }
    const start = offset;
    let end = offset + line.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]!;
      if (/^\s*\[/.test(next)) break;
      end += next.length;
    }
    return { start, end, body: raw.slice(start, end) };
  }
  return undefined;
}

function parseServerTable(body: string): { command?: string; args?: string[] } {
  const command = parseTomlStringAssignment(body, "command");
  const args = parseTomlStringArrayAssignment(body, "args");
  return { ...(command !== undefined ? { command } : {}), ...(args !== undefined ? { args } : {}) };
}

function parseTomlStringAssignment(body: string, key: string): string | undefined {
  const stringPattern = `"(?:(?:\\\\.)|[^"\\\\])*"|'[^']*'`;
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(${stringPattern})`, "m").exec(body);
  if (!match) return undefined;
  return parseTomlString(match[1]!.trim());
}

function parseTomlStringArrayAssignment(body: string, key: string): string[] | undefined {
  const raw = extractTomlArrayAssignment(body, key);
  if (!raw) return undefined;
  return parseTomlStringArray(raw);
}

function parseTomlString(raw: string): string | undefined {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return undefined;
}

function extractTomlArrayAssignment(body: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[`, "m").exec(body);
  if (!match) return undefined;
  const start = body.indexOf("[", match.index);
  if (start < 0) return undefined;
  let inString: `"` | "'" | undefined;
  let escaped = false;
  let inComment = false;
  let depth = 0;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index]!;
    if (inComment) {
      if (char === "\n" || char === "\r") inComment = false;
      continue;
    }
    if (inString) {
      if (inString === `"` && escaped) {
        escaped = false;
      } else if (inString === `"` && char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = undefined;
      }
      continue;
    }
    if (char === "#") {
      inComment = true;
      continue;
    }
    if (char === `"` || char === "'") {
      inString = char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  return undefined;
}

function parseTomlStringArray(raw: string): string[] | undefined {
  const values: string[] = [];
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index]!;
    if (/\s|,/.test(char)) continue;
    if (char === "#") {
      while (index < raw.length - 1 && raw[index] !== "\n" && raw[index] !== "\r") index += 1;
      continue;
    }
    if (char === `"`) {
      const start = index;
      let escaped = false;
      for (index += 1; index < raw.length - 1; index += 1) {
        const inner = raw[index]!;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (inner === "\\") {
          escaped = true;
          continue;
        }
        if (inner === `"`) break;
      }
      if (raw[index] !== `"`) return undefined;
      const value = parseTomlString(raw.slice(start, index + 1));
      if (value === undefined) return undefined;
      values.push(value);
      continue;
    }
    if (char === "'") {
      const start = index;
      index += 1;
      while (index < raw.length - 1 && raw[index] !== "'") index += 1;
      if (raw[index] !== "'") return undefined;
      const value = parseTomlString(raw.slice(start, index + 1));
      if (value === undefined) return undefined;
      values.push(value);
      continue;
    }
    return undefined;
  }
  return values;
}

function renderMcpServerTable(server: McpServerInvocation): string {
  return [
    `[mcp_servers.${tomlBareOrQuotedKey(server.name)}]`,
    `command = ${JSON.stringify(server.command)}`,
    `args = [${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "",
  ].join("\n");
}

function appendTable(raw: string, table: string): string {
  if (raw.trim().length === 0) return table;
  const normalized = raw.endsWith("\n") ? raw : `${raw}\n`;
  return `${normalized}\n${table}`;
}

function tomlBareOrQuotedKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlKeyPattern(key: string): string {
  const escaped = escapeRegExp(key);
  return `(?:${escaped}|"${escaped}"|'${escaped}')`;
}

function utcBackupTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ioState(file: string, error: unknown): CodexMcpServerState {
  const nodeError = error as NodeJS.ErrnoException;
  return {
    status: "error",
    path: file,
    message: nodeError.message ?? String(error),
    ...(nodeError.code ? { code: nodeError.code } : {}),
  };
}

function codexParseState(file: string, issue: string): CodexMcpServerState {
  return {
    status: "error",
    path: file,
    message: `codex-cli MCP config could not be parsed: ${issue}`,
    code: "PARSE_ERROR",
  };
}

function codexParseError(file: string, issue: string): CodexMcpWriteResult {
  return {
    status: "parse_error",
    path: file,
    message: `codex-cli MCP config could not be parsed: ${issue}`,
    code: "PARSE_ERROR",
  };
}

function ioError(file: string, error: unknown): CodexMcpWriteResult {
  const nodeError = error as NodeJS.ErrnoException;
  return {
    status: "io_error",
    path: file,
    message: nodeError.message ?? String(error),
    ...(nodeError.code ? { code: nodeError.code } : {}),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
