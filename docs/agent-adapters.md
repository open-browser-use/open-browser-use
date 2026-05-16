# open-browser-use Agent Adapters

`obu setup --agents=<list>` configures MCP clients to run:

```json
{ "name": "open-browser-use", "command": "/absolute/path/to/obu", "args": ["mcp", "stdio"] }
```

The exact stanza for any supported client is available with:

```bash
obu mcp-config --agent=<id> --print
```

Supported IDs:

- `codex-cli`
- `claude-code`
- `gemini-cli`
- `vscode`
- `cursor`
- `cline`
- `windsurf`
- `claude-desktop`
- `zed`
- `continue`

## Shell Adapters

When the target CLI is on `PATH`, setup shells out to the client's own MCP
configuration command:

```bash
codex mcp add open-browser-use -- /absolute/path/to/obu mcp stdio
claude mcp add -s user open-browser-use -- /absolute/path/to/obu mcp stdio
gemini mcp add --scope user open-browser-use /absolute/path/to/obu mcp stdio
code --add-mcp '{"name":"open-browser-use","command":"/absolute/path/to/obu","args":["mcp","stdio"]}'
cursor --add-mcp '{"name":"open-browser-use","command":"/absolute/path/to/obu","args":["mcp","stdio"]}'
```

Codex CLI, Claude Code, and Gemini CLI are probed with `mcp list` first. If an
equivalent `open-browser-use` server already exists, setup skips the write. If
a different `open-browser-use` server exists, setup stops at a manual action
instead of guessing how to rewrite the user's config.

Cursor uses the shell adapter only when `cursor --help` exposes `--add-mcp`.
Older Cursor builds fall back to the JSON direct-edit adapter.

## JSON / JSONC Direct Edit

Setup directly edits JSON or JSONC config files for:

- Cursor fallback: `~/.cursor/mcp.json`
- Cline: VS Code global storage `saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json`
- Claude Desktop: `claude_desktop_config.json`
- Zed: `~/.config/zed/settings.json`

Direct edits use `jsonc-parser` so comments are preserved. If a file cannot be
parsed, setup skips that adapter and prints a manual action. It does not fail
the whole setup run.

Backup policy:

- No backup is created when the generated content is unchanged.
- Existing files are backed up as `<file>.bak-<UTC timestamp>` before writes.
- Only the newest five open-browser-use-generated backups are retained per file.
- User-named backup files are never deleted.

Run this to remove open-browser-use-generated adapter backups:

```bash
obu doctor --clean-backups
```

## Manual Adapter

Continue uses YAML config and remains manual in P4. Use:

```bash
obu mcp-config --agent=continue --print
```
