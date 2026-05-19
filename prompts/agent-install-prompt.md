# Agent Install Prompt

You are helping the user install, repair, or adapt `open-browser-use` for
browser automation.

The user should paste a handoff block from the extension popup with:

- `Extension channel`
- `Extension id`

Use those exact values when native-host repair or browser pairing is needed. Do
not infer a different extension id.

For the Store channel, the pasted `Extension id` is part of the security
boundary. Native messaging only works when the browser-owned manifest contains
`chrome-extension://<that exact id>/` in `allowed_origins`. Do not derive an id
from the unpacked manifest key, a previous local config, or another Chrome
profile when the handoff includes a concrete Store id.

## Goal

Make `open-browser-use` work as the user's primary BrowserUse/browser automation
tool from this browser extension. Use the pasted extension channel/id exactly,
but adapt the install, MCP wiring, and persistent agent instructions to the
current project and the agent clients the user wants to use.

The user may already have one working agent, such as Codex, and now want to add
another one, such as Cursor or Claude Code. In that case, do not reinstall or
rewrite unrelated setup just because the native host is already connected.
Configure the additional agent and verify that the browser connection still
works.

## MCP Contract

Use this generic MCP server contract as the primary source of truth for every AI
client:

```json
{
  "name": "open-browser-use",
  "command": "/absolute/path/to/obu",
  "args": ["mcp", "stdio"]
}
```

On a standard release install, `/absolute/path/to/obu` resolves from:

```sh
~/.obu/bin/obu
```

Do not depend on `obu` being on `PATH`. Resolve `~/.obu/bin/obu` to a real
absolute path before writing JSON, such as `/Users/alex/.obu/bin/obu` or
`/home/alex/.obu/bin/obu`, unless the user explicitly installed somewhere else.
If `~/.obu/bin/obu` is missing, install or reinstall the latest release first;
a fresh new install is better than wiring MCP to a missing or half-installed
local CLI.

Most MCP clients store this in one of these shapes:

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

Prefer the current AI client's native MCP configuration method:

- If the client provides an MCP add command, use that.
- If the project already has an MCP config file, preserve its schema and add the
  `open-browser-use` server there.
- If the client uses a global config and the user is asking for global agent
  access, update the global config carefully.
- If the client is unknown, inspect existing config files and docs available in
  the project before choosing a schema. Do not invent a config shape when the
  client requires a different one.

Use OBU's built-in adapter commands as secondary helpers, not as the only path.
They are useful when they match the current client, but the generic server
contract above is enough to adapt other MCP-capable AI clients.

OBU adapter ids are exact. Use `codex-cli` for Codex, `claude-code` for Claude
Code, and `gemini-cli` for Gemini CLI. `codex`, `claude`, and `gemini` are
common human names, but older OBU releases may reject them as agent ids.

## Steps

1. Inspect the local state enough to choose the right path:

   - If `~/.obu/bin/obu` is missing, install the release CLI.
   - If it exists, prefer reusing it. Run install or repair commands only when
     native-host/browser repair is needed; otherwise configure the target
     agent's MCP settings directly.
   - If the user provided a local artifact or repo checkout, use that only when
     it is clearly intentional.

2. Run install or repair commands only when installation, native-host
   registration, browser pairing, or extension repair is needed. The extension
   handoff intentionally does not provide a one-size-fits-all shell command;
   choose the narrowest correct command for the current machine and agent.

   If release install is needed, install the CLI first:

   ```sh
   curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh
   ```

   If native-host/browser repair is needed, use the handoff channel/id and adapt
   the command to the local situation:

   ```sh
   ~/.obu/bin/obu bootstrap --yes --all --channel=<extension-channel> --extension-id=<extension-id> --agents=auto
   ```

   For `Extension channel: store`, preserving `--extension-id=<extension-id>` is
   important unless the Store id is already configured in OBU metadata, user
   config, or `OBU_STORE_EXTENSION_ID`. For `Extension channel: unpacked-dev`,
   OBU can usually derive the id from the bundled unpacked manifest key, but
   passing the handoff id is still fine when repairing the exact browser origin.

   If the native host is already connected and the task is only to connect
   another agent, do not run bootstrap and do not run `obu setup` just to add
   that agent. Configure the target agent's MCP settings directly with the
   generic MCP contract above.

3. Configure MCP for the current agent and for any other agent the user wants
   connected.

   Primary method: add this server to the client's MCP configuration using the
   client's own mechanism:

   ```json
   {
     "name": "open-browser-use",
     "command": "/absolute/path/to/obu",
     "args": ["mcp", "stdio"]
   }
   ```

   If the client supports an MCP add command, the command should be equivalent
   to:

   ```sh
   <client> mcp add open-browser-use -- /absolute/path/to/obu mcp stdio
   ```

   Adapt the exact command syntax to the client.

   Secondary helper: when broader setup is acceptable and the requested client
   is one of OBU's known writable adapter ids, you may use the built-in adapter.
   These helpers may also refresh runtime/native-host/browser setup; they are
   not the narrowest way to add one more agent. Add `--write-instructions` only
   when the user wants OBU to update Codex/Claude instruction files for them:

   ```sh
   ~/.obu/bin/obu setup --yes --agents=codex-cli --write-instructions
   ~/.obu/bin/obu setup --yes --agents=claude-code --write-instructions
   ~/.obu/bin/obu setup --yes --agents=gemini-cli
   ~/.obu/bin/obu setup --yes --agents=vscode
   ~/.obu/bin/obu setup --yes --agents=cursor
   ~/.obu/bin/obu setup --yes --agents=cline
   ~/.obu/bin/obu setup --yes --agents=windsurf
   ~/.obu/bin/obu setup --yes --agents=claude-desktop
   ~/.obu/bin/obu setup --yes --agents=zed
   ```

   You may pass a comma-separated list when that is the cleanest fit:

   ```sh
   ~/.obu/bin/obu setup --yes --agents=codex-cli,cursor,claude-code --write-instructions
   ```

   If client detection is ambiguous, use auto mode, but inspect the result. Auto
   mode only configures agents it can detect confidently; it may skip a working
   agent if only that agent's global config file exists or its executable is not
   on `PATH`.

   ```sh
   ~/.obu/bin/obu setup --yes --agents=auto
   ```

   When you need a machine-checkable status for an already configured agent,
   run:

   ```sh
   ~/.obu/bin/obu agent doctor --agent=<agent-id>
   ```

   To get OBU's reference shape for a known adapter, use
   `~/.obu/bin/obu mcp-config --agent=<agent-id> --print` for the matching agent
   id and adapt that JSON to the client's MCP config format.

   `continue` is currently reference/manual only. Use
   `~/.obu/bin/obu mcp-config --agent=continue --print` and adapt the result to
   Continue's MCP configuration format.

   Do not overwrite divergent existing MCP server settings without explaining
   the conflict and asking the user what to keep. If an existing
   `open-browser-use` server already points to the same command and args, leave
   it alone.

4. Run browser verification when browser/native-host state may have changed:

   ```sh
   ~/.obu/bin/obu doctor browser --channel=<extension-channel> --extension-id=<extension-id>
   ```

   For the Store channel, include the exact Store extension id from the handoff
   unless it is already configured. If `browser_status` says the SDK is
   available but `backends` is empty, the MCP server is reachable but the
   browser backend is not. Run the doctor command above; for Store repair, use
   the exact handoff id:

   ```sh
   ~/.obu/bin/obu doctor browser --repair --channel=store --extension-id=<extension-id>
   ```

   Repair can fix the native-host manifest and runtime descriptor directory, but
   it cannot force Chrome to reconnect the extension. If doctor still reports
   no active WebExtension runtime descriptor after repair, tell the user to open
   the open-browser-use extension popup. Click Resume if it is enabled; if
   Resume is disabled but the popup says the local host is connected, leave the
   popup open briefly and rerun doctor with the same channel/id, then retry
   `browser_status`.

5. Verify MCP from inside the target agent when possible:

   - Restart or reload the client if its MCP config is only read at startup.
   - Confirm the `open-browser-use` MCP server appears in the client's MCP tool
     list.
   - If the OBU MCP tools are not visible in a client that supports deferred tool
     discovery, search/load the `open-browser-use` MCP tools before concluding
     setup failed.
   - Prefer a read-only first call such as `browser_status`.
   - Before the first browser action, call `browser_status`; use the `js` MCP
     tool for browser automation.
   - Treat MCP availability and browser availability as separate checks:
     `browser_status` must show at least one backend before browser automation
     can work.
   - If the MCP server starts but browser state is stale, run
     `~/.obu/bin/obu doctor browser` with the handoff channel/id when needed.
   - For setup probes, prefer `await browser.turnEnded()` after the probe so the
     browser session stays controlled. Do not use
     `await browser.finishTurn({ keep: [] })` unless you intentionally want to
     close agent-created tabs or release user tabs.

6. Add a short persistent instruction when the project or agent has an
   appropriate core instruction file. Check both project and global instruction
   locations before falling back to a snippet. Prefer an existing repo-root
   `AGENTS.md`, `AGENT.md`, or `CLAUDE.md` when it governs this project. If the
   project has no instruction file, check the current agent's global
   instruction surface, especially `~/.codex/AGENTS.md` for Codex and
   `~/.claude/CLAUDE.md` or the configured `~/.claude/` memory surface for
   Claude Code. Inspect `~/.claude.json` only as configuration context; do not
   append Markdown instructions to JSON config.

   ```md
   ## Browser Automation

   Use open-browser-use as the primary BrowserUse/browser automation tool.
   Prefer the `open-browser-use` MCP server for browser tasks. Check
   `browser_status` before the first browser action, use the `js` tool for
   browser automation, and run `~/.obu/bin/obu doctor browser` if setup appears
   stale.
   ```

   Adapt the wording and location to the agent. For example, update
   `AGENTS.md` or `AGENT.md` for Codex-style project instructions, `CLAUDE.md`
   for Claude Code, or the equivalent project instruction surface for Cursor.
   Do not create or edit unrelated repository files just to store this note. If
   no project instruction file exists but the agent has a known global
   instruction file, use that global file. If there is no obvious persistent
   instruction surface, show the snippet to the user and state which project and
   global locations were checked.

## Safety Rules

- Install only from the official `open-browser-use/open-browser-use` release URL
  above unless the user explicitly provides a local artifact.
- Do not overwrite divergent MCP server settings. If `obu setup` reports manual
  action or a divergent server, show the user the exact next action.
- Do not make broad PATH, shell profile, or dotfile edits beyond the explicit
  `obu shellenv` instructions printed by the installer.
- Modify `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, Cursor/Claude/Codex project or
  global instructions, or agent memory only when it is clearly the right
  instruction surface.
- Do not commit, push, or modify application code unless the user separately asks.
- Preserve the extension id from the handoff block. The native host manifest
  must allow that exact browser extension origin.
