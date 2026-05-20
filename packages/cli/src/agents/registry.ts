export type AgentId =
  | "codex-cli"
  | "claude-code"
  | "gemini-cli"
  | "vscode"
  | "cursor"
  | "cline"
  | "windsurf"
  | "claude-desktop"
  | "zed"
  | "continue";

export type McpServerInvocation = {
  name: "open-browser-use";
  command: string;
  args: string[];
};

export type AgentMcpConfig =
  | {
    agent: AgentId;
    mode: "shell";
    server: McpServerInvocation;
    executable: string;
    args: string[];
    shellCommand: string;
  }
  | {
    agent: AgentId;
    mode: "json";
    server: McpServerInvocation;
    config: Record<string, unknown>;
  }
  | {
    agent: AgentId;
    mode: "manual";
    server: McpServerInvocation;
    instructions: string;
    config?: Record<string, unknown>;
  };

const AGENT_IDS: AgentId[] = [
  "codex-cli",
  "claude-code",
  "gemini-cli",
  "vscode",
  "cursor",
  "cline",
  "windsurf",
  "claude-desktop",
  "zed",
  "continue",
];

const AGENT_ALIASES: Record<string, AgentId> = {
  codex: "codex-cli",
  claude: "claude-code",
  "claude-cli": "claude-code",
  gemini: "gemini-cli",
};

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as string[]).includes(value);
}

export function normalizeAgentId(value: string): AgentId | undefined {
  const normalized = value.toLowerCase();
  if (isAgentId(normalized)) return normalized;
  return AGENT_ALIASES[normalized];
}

export function supportedAgentIds(): AgentId[] {
  return [...AGENT_IDS];
}

export function supportedAgentAliasHelp(): string {
  return "Aliases: codex=codex-cli, claude=claude-code, gemini=gemini-cli.";
}

export function renderAgentMcpConfig(agent: AgentId, server: McpServerInvocation): AgentMcpConfig {
  switch (agent) {
    case "codex-cli":
      return shellConfig(agent, server, "codex", ["mcp", "add", server.name, "--", server.command, ...server.args]);
    case "claude-code":
      return shellConfig(agent, server, "claude", ["mcp", "add", "-s", "user", server.name, "--", server.command, ...server.args]);
    case "gemini-cli":
      return shellConfig(agent, server, "gemini", ["mcp", "add", "--scope", "user", server.name, server.command, ...server.args]);
    case "vscode":
      return shellConfig(agent, server, "code", ["--add-mcp", JSON.stringify(server)]);
    case "cursor":
      return jsonConfig(agent, server, { mcpServers: { [server.name]: jsonServerConfig(server) } });
    case "cline":
      return jsonConfig(agent, server, { mcpServers: { [server.name]: jsonServerConfig(server) } });
    case "windsurf":
      return jsonConfig(agent, server, { mcpServers: { [server.name]: jsonServerConfig(server) } });
    case "claude-desktop":
      return jsonConfig(agent, server, { mcpServers: { [server.name]: jsonServerConfig(server) } });
    case "zed":
      return jsonConfig(agent, server, { context_servers: { [server.name]: { command: server.command, args: server.args } } });
    case "continue":
      return {
        agent,
        mode: "manual",
        server,
        instructions: `Add an MCP server named ${server.name} using the command and args shown in server.`,
        config: { name: server.name, command: server.command, args: server.args },
      };
  }
}

function shellConfig(agent: AgentId, server: McpServerInvocation, executable: string, args: string[]): AgentMcpConfig {
  return {
    agent,
    mode: "shell",
    server,
    executable,
    args,
    shellCommand: [executable, ...args].map(shellQuote).join(" "),
  };
}

function jsonConfig(agent: AgentId, server: McpServerInvocation, config: Record<string, unknown>): AgentMcpConfig {
  return {
    agent,
    mode: "json",
    server,
    config,
  };
}

function jsonServerConfig(server: McpServerInvocation): { command: string; args: string[] } {
  return { command: server.command, args: server.args };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
