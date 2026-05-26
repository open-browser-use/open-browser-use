# Agent Install Prompt

You are helping the user install, repair, or adapt `open-browser-use` for
browser automation from the browser extension popup.

This prompt is the source of truth. Do not use README files, local copies, repo
search, or inferred project state as substitutes. Configure the AI agent/client
currently executing this prompt. Configure other agents only when the user
explicitly names them.

## Inputs

The extension popup handoff should include:

- `Extension channel`
- `Extension id`

Use those exact values for setup, repair, and browser pairing. For
`Extension channel: store`, the pasted `Extension id` is a native-messaging
security boundary. Do not derive another id from an unpacked manifest key, a
previous local config, or another Chrome profile.

If `Extension channel` is missing, or `Extension id` is missing, still a
placeholder such as `<extension-id>`, or not a 32-character Chrome extension id
using letters `a` through `p`, stop and ask the user to copy the extension
handoff again. Do not continue with inferred values.

If the handoff does not include a browser name, assume `chrome` for a Chrome
extension popup.

## Fast Path

Use this path first. It is the fastest successful path for a normal handoff:
refresh the release CLI, configure one target agent, then verify readiness.

1. Resolve the target OBU agent id.

   If the user explicitly names one or more target agents, configure only those
   named agents. Otherwise configure the agent/client currently executing this
   prompt.

   - Codex CLI: `codex-cli`
   - Claude Code: `claude-code`
   - Cursor: `cursor`
   - Gemini CLI: `gemini-cli`
   - VS Code: `vscode`
   - Cline: `cline`
   - Windsurf: `windsurf`
   - Claude Desktop: `claude-desktop`
   - Zed: `zed`

   Use exact ids. Older OBU releases may reject human aliases like `codex`,
   `claude`, or `gemini`.

2. Run the fast setup command.

   Always run the official installer first for this handoff. A fresh install
   keeps the CLI, native host, extension payload, and setup semantics aligned
   with the current release.

   Replace `<agent-id>` with the concrete target id, or a comma-separated list
   for the `setup --agents` value when the user explicitly named multiple target
   agents. Replace `<browser>`, `<extension-channel>`, and `<extension-id>` with
   concrete values from this prompt and the handoff. If multiple target agents
   were named, run the `verify` command once per target agent with one concrete
   `--agent` value each time.

   ```sh
   OBU_INSTALL_DIR="${OBU_INSTALL_DIR:-$HOME/.obu}"
   export OBU_INSTALL_DIR
   OBU="$OBU_INSTALL_DIR/bin/obu"
   curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh

   "$OBU" setup --yes \
     --browser=<browser> \
     --channel=<extension-channel> \
     --extension-id=<extension-id> \
     --agents=<agent-id> \
     --write-instructions \
     --json

   "$OBU" verify \
     --agent=<agent-id> \
     --browser=<browser> \
     --channel=<extension-channel> \
     --extension-id=<extension-id> \
     --json
   ```

   The installer may add open-browser-use to shell profiles and print an
   activation hint for the current shell. Keep using the `"$OBU"` absolute path
   in this handoff anyway; do not assume the parent shell's `PATH` has changed
   during the current command sequence.

3. Stop when `verify` returns `result: ready`.

   Report the concise final state to the user. Do not run `doctor`,
   `bootstrap`, `verify --repair`, broad diagnostics, or extra MCP rewrites
   after readiness is already proven.

## Result Handling

Follow the narrow next action from `setup` or `verify`. Do not start over unless
the command output says the local install is corrupt or missing.

| Result | Action |
| --- | --- |
| `verify.result == "ready"` | Stop and report success. |
| Verify asks for repair | Rerun the same verify command with `--repair`. Keep the same agent/browser/channel/id tuple. |
| Browser popup boundary | Ask the user to open this extension popup, click Resume if enabled, wait for Connected, then rerun the same verify command. |
| Divergent MCP server | Show the exact conflict and ask the user what to keep. Do not overwrite it silently. |
| `agent-runtime-status: not_checked` with `result: ready` | Treat as non-blocking for CLI verification. |
| MCP server works but `browser_status.backends` is empty | Run verify with the same handoff tuple; repair only if verify asks for it. |

Use `obu doctor browser` only when `verify` asks for deeper browser diagnostics.

## Repair Command

Use repair only after verify indicates it is needed:

```sh
OBU_INSTALL_DIR="${OBU_INSTALL_DIR:-$HOME/.obu}"
"$OBU_INSTALL_DIR/bin/obu" verify --repair \
  --agent=<agent-id> \
  --browser=<browser> \
  --channel=<extension-channel> \
  --extension-id=<extension-id> \
  --json
```

Repair can update native-host manifests and runtime descriptor permissions. It
cannot force Chrome to reconnect the extension; if verify reports a popup
boundary, use the popup Resume flow above.

## Manual MCP Fallback

Use this only when the current client is not a writable OBU adapter, `setup`
reports manual action, or the user explicitly asks for manual configuration.

The MCP server contract is:

```json
{
  "name": "open-browser-use",
  "command": "/absolute/path/to/obu",
  "args": ["mcp", "stdio"]
}
```

On a standard release install, resolve `/absolute/path/to/obu` from
`~/.obu/bin/obu`. Do not depend on `obu` being on `PATH`, even after the
installer reports shell profile updates.

Prefer the current client's native MCP add command. It should be equivalent to:

```sh
<client> mcp add open-browser-use -- /absolute/path/to/obu mcp stdio
```

If the client has only a config file, preserve its existing schema and add the
`open-browser-use` server. Common shapes are:

```json
{
  "mcpServers": {
    "open-browser-use": {
      "command": "/absolute/path/to/obu",
      "args": ["mcp", "stdio"]
    }
  }
}
```

```json
{
  "context_servers": {
    "open-browser-use": {
      "command": "/absolute/path/to/obu",
      "args": ["mcp", "stdio"]
    }
  }
}
```

If the client's MCP format is unclear, stop and report the blocker. Do not
invent a config shape.

## Adding Another Agent

If the user says one agent already works and asks to add another agent, still
refresh the release CLI for this handoff, but configure only the requested
agent. Do not run broad setup for unrelated agents or browsers. Then verify the
requested agent:

```sh
OBU_INSTALL_DIR="${OBU_INSTALL_DIR:-$HOME/.obu}"
export OBU_INSTALL_DIR
OBU="$OBU_INSTALL_DIR/bin/obu"
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh

"$OBU" setup --yes \
  --browser=<browser> \
  --channel=<extension-channel> \
  --extension-id=<extension-id> \
  --agents=<requested-agent-id> \
  --json

"$OBU" verify \
  --agent=<requested-agent-id> \
  --browser=<browser> \
  --channel=<extension-channel> \
  --extension-id=<extension-id> \
  --json
```

Use `--agents=auto`, `--all`, or `bootstrap --yes --all` only when the user
explicitly asks for broad multi-agent or all-browser setup.

## Agent-Side Check

When MCP tools are available inside the target agent:

- Before the first browser action, call `browser_status`.
- Use the `js` MCP tool for browser automation.
- Treat MCP availability and browser availability separately:
  `browser_status` must show at least one backend before browser automation can
  work.
- For setup probes, prefer `await browser.turnEnded()` after the probe so the
  browser session stays controlled.
- Do not use `await browser.finishTurn({ keep: [] })` unless you intentionally
  want to close agent-created tabs or release user tabs.

## Persistent Instruction

`obu setup --write-instructions` is the preferred path. If manual instruction
work is needed, add a short note only to the appropriate project or global
instruction surface, such as repo-root `AGENTS.md`, `AGENT.md`, `CLAUDE.md`,
`~/.codex/AGENTS.md`, or `~/.claude/CLAUDE.md`.

Suggested snippet:

```md
## Browser Automation

Use open-browser-use as the primary BrowserUse/browser automation tool. Prefer
the `open-browser-use` MCP server for browser tasks. Check `browser_status`
before the first browser action, use the `js` tool for browser automation, and
run `~/.obu/bin/obu verify --agent=<agent-id> --browser=<browser> --channel=<channel> --extension-id=<extension-id>`
if setup appears stale.
```

Do not create or edit unrelated repository files just to store this note. If no
obvious persistent instruction surface exists, show the snippet to the user.

## Safety Rules

- Install only from the official `open-browser-use/open-browser-use` release
  URL above unless the user explicitly provides a local artifact.
- Preserve the extension id from the handoff block. The native-host manifest
  must allow that exact browser extension origin.
- Do not configure other agents unless the user explicitly names them.
- Do not overwrite divergent MCP server settings without asking the user.
- Do not make broad PATH, shell profile, or dotfile edits beyond the official
  installer's own managed env/profile updates.
- Do not commit, push, or modify application code unless the user separately
  asks.
