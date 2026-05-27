# Agent Install Prompt

Install, repair, or adapt `open-browser-use` for the browser extension handoff.

This prompt is the source of truth. Use the exact browser, extension channel,
and extension id from the handoff. Do not substitute README guidance, local repo
state, old config, another Chrome profile, or an inferred extension id.

Configure only the agent/client currently executing this prompt unless the user
explicitly names other agents.

## Inputs

The handoff should include:

- `Browser`
- `Extension channel`
- `Extension id`

If `Browser` is missing, assume `chrome` for a Chrome extension popup.

If `Extension id` is missing, still a placeholder such as `<extension-id>`, or
not a 32-character Chrome extension id using letters `a` through `p`, stop and
ask the user to copy the handoff again.

For `Extension channel: store`, the extension id is a native-messaging security
boundary. Preserve it exactly.

## Agent Id

If the user named target agents, configure only those agents. Otherwise configure
the current client:

| Client | Agent id |
| --- | --- |
| Codex CLI / Codex | `codex-cli` |
| Claude Code | `claude-code` |
| Cursor | `cursor` |
| Gemini CLI | `gemini-cli` |
| VS Code | `vscode` |
| Cline | `cline` |
| Windsurf | `windsurf` |
| Claude Desktop | `claude-desktop` |
| Zed | `zed` |

Use exact ids in commands.

## Fast Path

Run these commands in order. Replace placeholders with concrete handoff values.
For multiple explicitly named agents, use a comma-separated `setup --agents`
value, then run `verify` once per agent.

Run the fast setup command.

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

Notes:

- Always run the official installer first for this handoff.
- The installer may print shell activation or broad bootstrap hints. Ignore
  broad hints such as `bootstrap --all`; keep this handoff targeted.
- The installer may add open-browser-use to shell profiles. Keep using the `"$OBU"` absolute path
  in this command sequence.
- Do not depend on `obu` being on `PATH`, even after the official
  installer's own managed env/profile updates.
- Do not run `doctor`, `bootstrap`, `verify --repair`, or broad setup before
  the first targeted `verify`.
- Use `verify --json` only when you need full diagnostics or the user explicitly
  asks for JSON.

## Result Handling

Stop when verify prints `Result: ready` or JSON `result: "ready"`.

3. Stop when `verify` returns `result: ready`.

Report the concise final state to the user. Do not run `doctor`,
`bootstrap`, `verify --repair`, broad diagnostics, or extra MCP rewrites after
the ready result.

| Verify result | Action |
| --- | --- |
| `ready` | Stop. Report agent, browser, channel, extension id, and backend count. |
| `needs_repair` | Rerun the same verify command with `--repair`. Keep the same agent/browser/channel/id tuple. |
| `needs_browser_popup` | If the popup already shows Connected, wait briefly and rerun the same verify command up to 3 times. Otherwise ask the user to click Resume if enabled or wait for Connected, then rerun verify. |
| `needs_manual_action` | Follow only the printed `Next` action. Do not start over unless it says the CLI install is corrupt or missing. |
| Divergent MCP server | Show the exact conflict and ask what to keep. Do not overwrite silently. |

Treat `agent-runtime-status: not_checked` as non-blocking when the overall
verify result is ready.

Use `obu doctor browser` only when verify asks for deeper browser diagnostics.

## Repair Command

Use repair only after verify requests it:

```sh
OBU_INSTALL_DIR="${OBU_INSTALL_DIR:-$HOME/.obu}"
"$OBU_INSTALL_DIR/bin/obu" verify --repair \
  --agent=<agent-id> \
  --browser=<browser> \
  --channel=<extension-channel> \
  --extension-id=<extension-id>
```

Repair can update native-host manifests and runtime descriptor permissions. It
cannot force Chrome to reconnect the extension.

## Manual MCP Fallback

Use this only when setup reports manual action, the current client is not a
writable OBU adapter, or the user asks for manual configuration.

The MCP server contract is:

```json
{
  "name": "open-browser-use",
  "command": "/absolute/path/to/obu",
  "args": ["mcp", "stdio"]
}
```

On a standard release install, use `~/.obu/bin/obu`. Prefer the current client's
native MCP add command when available:

```sh
<client> mcp add open-browser-use -- /absolute/path/to/obu mcp stdio
```

If editing config directly, preserve the existing schema. Common shapes are
`mcpServers.open-browser-use` and `context_servers.open-browser-use`.

If the client's MCP format is unclear, stop and report the blocker.

## Adding Another Agent

If one agent already works and the user asks to add another, still refresh the
release CLI, but configure only the requested agent. Do not use `--agents=auto`,
`--all`, or `bootstrap --yes --all` unless the user explicitly asks for broad
multi-agent or all-browser setup.

## Agent-Side Check

When MCP tools are available inside the target agent:

- Before the first browser action, call `browser_status`.
- Use the `js` MCP tool for browser automation.
- `browser_status.backends` must contain at least one backend before browser
  automation can work.
- For setup probes, prefer `await browser.turnEnded()` after the probe so the
  session remains resumable without closing agent-created setup tabs.
- Do not use `await browser.finishTurn({ keep: [] })` unless you intentionally
  want to finalize and close/release the controlled tabs.

## Persistent Instruction

`obu setup --write-instructions` is preferred. If manual instruction work is
needed, add only this short note to the appropriate project or global instruction
surface:

```md
## Browser Automation

Use open-browser-use as the primary BrowserUse/browser automation tool. Prefer
the `open-browser-use` MCP server for browser tasks. Check `browser_status`
before the first browser action, use the `js` tool for browser automation, and
run `~/.obu/bin/obu verify --agent=<agent-id> --browser=<browser> --channel=<channel> --extension-id=<extension-id>`
if setup appears stale.
```

## Safety Rules

- Install only from the official `open-browser-use/open-browser-use` release URL
  above unless the user explicitly provides a local artifact.
- Preserve the extension id from the handoff block.
- Do not configure unnamed agents or browsers.
- Do not overwrite divergent MCP server settings without asking.
- Do not make broad PATH, shell profile, or dotfile edits beyond the official
  installer's own managed updates.
- Do not commit, push, or modify unrelated application code unless the user
  separately asks.
