# Agent Setup State Closure

Date: 2026-05-19

## Product Goal

Productize the setup state loop so a user, an agent, and the extension all get
the same answer to one question:

> Is open-browser-use ready for this agent to control this browser now?

Today that answer is assembled from several partial surfaces: install output,
`obu setup`, `obu doctor browser`, `obu agent doctor`, MCP `browser_status`, and
the extension popup. Each surface is useful, but none owns the whole readiness
contract. That makes the product feel brittle even when most components are
working correctly.

The desired product boundary is a single high-level verification path that
returns one of four outcomes:

- `ready`: the agent can use a browser backend now.
- `needs_browser_popup`: local setup is correct, but Chrome has not activated
  the extension/native-host runtime descriptor yet.
- `needs_repair`: deterministic CLI repair is available and should be run.
- `needs_manual_action`: the remaining action is outside CLI control, such as
  installing the Store extension, resolving a divergent MCP config, restarting an
  agent client, or choosing a config conflict resolution.

## Why This Matters

The recent clean-install feedback exposed a product-level state mismatch rather
than one isolated bug:

- The extension handoff assumed `~/.obu/bin/obu` might be available, but a clean
  machine can start with no CLI at all.
- Agent names used by humans (`codex`, `claude`) did not always match OBU's
  adapter ids (`codex-cli`, `claude-code`).
- `setup --agents=auto` could report an agent as configured through one path,
  while `agent doctor` checked a different path.
- Browser setup could be repaired on disk while the WebExtension runtime
  descriptor was still absent because Chrome had not woken the extension.
- MCP server availability and browser backend availability were treated as a
  single status by agents, but they are separate layers.

These are exactly the failures a state-closure product surface should prevent.

## Current State Layers

Readiness currently spans seven layers:

1. **CLI install state**: `~/.obu/bin/obu` exists and reports the expected
   version.
2. **Native-host registration**: the browser manifest exists, points at an
   executable host, and includes the exact Store extension id in
   `allowed_origins`.
3. **Browser extension installation state**: the selected browser profile has
   the matching open-browser-use extension installed, enabled, and associated
   with the extension id being verified.
4. **Extension runtime state**: Chrome has activated the extension runtime and
   the extension has connected to the native host.
5. **Runtime descriptor state**: a valid WebExtension descriptor exists under
   the owner-only runtime directory and responds to `getInfo`.
6. **Agent MCP state**: the target agent is configured to launch
   `open-browser-use` with `obu mcp stdio`.
7. **Agent instruction state**: the agent has persistent guidance to prefer OBU
   as the primary browser automation tool.

The critical distinction is that layers 1, 2, 6, and 7 are mostly file/config
state. Layer 3 depends on the selected browser profile. Layers 4 and 5 depend on
Chrome extension runtime activation. The CLI can repair files, but it cannot
force Chrome to keep an MV3 service worker alive.

## Definition of Done

A connection has two verification levels.

CLI-level readiness means OBU can verify local setup and browser backend state
without relying on a specific agent process:

1. Browser doctor reports a live backend descriptor:

   ```text
   PASS Runtime descriptor probe: ... responded to getInfo
   resume required: no
   ```

2. Agent doctor reports that the target agent has an equivalent
   `open-browser-use` MCP configuration and, where supported, the primary-browser
   instruction.

Agent-runtime readiness is stronger. It means the target agent has reloaded its
MCP tools and its own `browser_status` reports:

   ```json
   {
     "sdk_bootstrap": "available",
     "backends": [{ "...": "..." }]
   }
   ```

An MCP server with `backends: []` is not ready for browser automation. It only
proves that the MCP process can start.

## Why Opening the Popup Is Sometimes Required

Opening the extension popup is not a workaround for bad configuration. It is the
browser UI boundary where Chrome activates the extension runtime.

`obu doctor browser --repair` can fix:

- native-host manifests;
- allowed extension origins;
- host binary paths;
- runtime directory permissions;
- stale or invalid descriptor files.

It cannot force Chrome to:

- wake the MV3 service worker immediately;
- reconnect the extension to native messaging from outside the browser;
- write a fresh WebExtension descriptor without extension runtime activity.

Opening the popup wakes the extension and gives it a chance to connect to the
native host. If the popup shows the host connected and the Resume button is
disabled, that can still be a good state: the popup has already refreshed the
connection. The correct next step is to rerun doctor and confirm
`resume required: no`.

## Proposed Product Surface

Add one high-level command:

```bash
obu verify --agent=codex-cli --browser=chrome --channel=store --extension-id=<id>
```

The command should compose existing checks instead of replacing them. It should
be read-only by default:

1. Resolve install/runtime layout.
2. Verify native-host browser setup and report any repair command.
3. Verify extension installed/enabled/profile state.
4. Probe browser descriptor state.
5. Verify target agent MCP config.
6. Verify target agent instruction state when implemented.
7. Optionally run an MCP-level status probe when the target agent supports it or
   when the current process can safely simulate it.
8. Return one stable result and one next action.

If mutation is needed, use an explicit flag or a different command path:

```bash
obu verify --repair --agent=codex-cli --browser=chrome --channel=store --extension-id=<id>
```

Example human outputs:

```text
open-browser-use is ready.
Agent: codex-cli
Browser: chrome Store extension fblnfcjnjklpgnmfnngcihbcgojnpadj
Backend: webextension descriptor chrome.json responded to getInfo
```

```text
Browser popup required.
Local setup appears correct, but no active WebExtension descriptor exists yet.
Open the open-browser-use extension popup. If Resume is enabled, click it.
If it already shows Connected, wait briefly and rerun:
  obu verify --agent=codex-cli --browser=chrome --channel=store --extension-id=...
```

```text
Agent configuration required.
Codex MCP config is missing open-browser-use.
Run:
  obu setup --yes --agents=codex-cli --write-instructions
```

## JSON Contract

The verification JSON should be stable enough for agents:

```json
{
  "schemaVersion": 1,
  "command": "verify",
  "result": "ready",
  "agent": {
    "id": "codex-cli",
    "mcpConfig": "pass",
    "instructions": "pass",
    "runtimeStatus": "not_checked"
  },
  "browser": {
    "kind": "chrome",
    "channel": "store",
    "extensionId": "fblnfcjnjklpgnmfnngcihbcgojnpadj",
    "extensionInstalled": "pass",
    "nativeHost": "pass",
    "runtimeDescriptor": "pass",
    "resumeRequired": false
  },
  "mcpRuntime": {
    "sdkBootstrap": "available",
    "backendCount": 1
  },
  "nextAction": null
}
```

For non-ready states, `nextAction` should be a single object:

```json
{
  "kind": "open_popup",
  "message": "Open the extension popup; click Resume if enabled, otherwise wait for Connected and rerun verify."
}
```

## Systemic Fix Cut Points

### 1. One Source of Truth per Agent

For each first-class agent, setup and doctor must read/write the same config
surface.

Current direction:

- Codex: `~/.codex/config.toml` for MCP, `~/.codex/AGENTS.md` for global
  instructions.
- Cursor: `~/.cursor/mcp.json` for MCP.
- Claude Code: `claude mcp` for MCP, `~/.claude/CLAUDE.md` for global
  instructions.

Avoid reporting "configured" when the doctor cannot verify the same state.

### 2. Normalize Human Agent Names

Accept common names as aliases:

- `codex` -> `codex-cli`
- `claude` -> `claude-code`
- `gemini` -> `gemini-cli`

Output should still show canonical ids so logs and docs remain precise.

### 3. Separate MCP Availability from Browser Availability

The MCP server can be healthy while browser backends are unavailable. Product
output should make this explicit:

- MCP configured: yes/no.
- MCP starts: yes/no.
- SDK bootstrap: available/missing/untrusted.
- Browser backend count: `0` means not ready.

### 4. Make Popup State Machine-Readable

The popup should eventually expose or display a direct readiness state:

- `Native host: connected`
- `Descriptor: active`
- `Resume required: yes/no`
- `Last descriptor refresh: timestamp`

This would let users and agents understand whether opening the popup already
fixed the descriptor activation boundary.

### 5. Keep Prompts as Fallback, Not the State Machine

The agent install prompt should guide unusual environments, but it should not be
the main state engine. The CLI should produce the canonical machine-readable
diagnosis and the prompt should tell agents to trust that diagnosis.

### 6. Preserve Exact Store Extension IDs

Store extension id is security-sensitive native messaging state. Every repair,
doctor, setup, verify, and follow-up command must preserve the exact handoff id
unless OBU can prove the same id is already configured.

## Short-Term Implementation Plan

1. Keep these first-class setup invariants in place:
   - agent alias normalization;
   - Codex config read/write/doctor support;
   - Cursor setup and doctor using the same `mcp.json`;
   - longer Claude Code doctor timeout;
   - clearer popup/doctor Resume wording.
2. Add `obu verify` as a thin composition layer over existing setup, browser
   doctor, agent doctor, and MCP status primitives.
3. Add a release smoke that runs verify in a clean temporary home for Codex and
   Cursor config paths.
4. Extend popup status to distinguish host connection from active descriptor
   readiness.
5. Update the extension handoff prompt to prefer `obu verify` as the final
   readiness gate.

## Product Principle

No user or agent should need to infer readiness by stitching together partial
success messages. The product should own the state closure and return one
truthful next action.
