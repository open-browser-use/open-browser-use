# Product Context

## Product

open-browser-use is a local browser automation stack for agents. It gives coding
agents and other computer-use systems a reliable way to operate an installed
Chromium browser profile through a local host, a browser extension, an MCP
JavaScript runtime, and the `@open-browser-use/sdk`.

The public promise is terse:

- agent browser tool.
- agentic RL ready.
- local browser automation for agents.

The product is infrastructure, not a SaaS app. It should feel technical,
inspectable, and close to the machine.

## Register

`register: product`

Most surfaces serve an active task: installing, verifying, pairing Chrome,
copying agent instructions, controlling browser sessions, inspecting diagnostics,
and debugging automation. Brand moments can be cinematic and stark, but product
UI must remain quiet, legible, and trustworthy.

## Users

- Agent builders who need a browser tool that works from local coding agents.
- Developers installing or repairing a Chrome extension plus native host bridge.
- Researchers and automation engineers evaluating browser-use and agentic RL
  workflows.
- Security-conscious users who prefer local, inspectable browser control instead
  of a remote automation service.

## Core Jobs

- Install the host, extension, and agent wiring without guessing what changed.
- Verify whether a selected agent/browser/profile pair is ready.
- Repair stale native-host, extension, runtime descriptor, or MCP setup state.
- Let an agent operate a real browser profile while the user can see what is
  happening.
- Preserve enough session, tab, pointer, and diagnostic state for the agent to
  recover from stale or interrupted work.
- Provide SDK and MCP primitives that are explicit about capability, lifecycle,
  and failure state.

## Product Principles

1. Local first. The default mental model is local host plus local browser plus
   local agent. Do not imply a cloud control plane unless one exists.
2. Visible automation. Agent control should be observable and explainable. The
   user should know when the agent owns input, when human input is blocked, and
   when control is released.
3. Browser-native. The product works with the user's browser profile and
   extension runtime. Avoid fake browser metaphors when the real browser state is
   the source of truth.
4. Recoverable by design. Stale setup, lost descriptor state, broken pairing, and
   long-running task interruption are normal states to diagnose, not edge cases
   to hide.
5. Explicit contracts. SDK, CLI, extension, and host boundaries should name
   lifecycle states, ownership, tab ids, turn ids, and stale reasons directly.
6. Agent-facing clarity. Outputs should be copyable into an agent and precise
   enough for that agent to act without extra interpretation.
7. Minimal spectacle in task UI. The product can have a strong visual identity,
   but active tools should not distract from install, verification, and browser
   control.

## Voice

The brand voice is lowercase, spare, and direct. It can be slightly poetic on
marketing surfaces, but product surfaces should be procedural and exact.

Use:

- "open browser use"
- "agent browser tool"
- "agentic RL ready"
- "copy for agent"
- "verify"
- "repair"
- "resume"
- "native host"
- "browser bridge"
- "local runtime"

Avoid:

- Generic SaaS claims such as "unlock productivity" or "supercharge workflows".
- Cute assistant language.
- Vague safety language that hides concrete state.
- Explaining obvious UI behavior in visible product copy.
- Title case for brand labels unless a platform requires it.

## Surfaces

- Website and social previews: high-contrast monochrome brand, cinematic image,
  oversized lowercase wordmark, concise installation promise.
- Extension popup: dense product control surface for connection status, setup
  handoff, debug logging, stop/resume, and copy actions.
- Extension options: restrained settings surface for persistent configuration.
- CLI: explicit state reporting and next action guidance.
- SDK/MCP: agent-facing API with typed lifecycle and observation contracts.
- Browser overlay and pointer: visible proof of agent control, not decoration.

## Experience Goals

- A developer can tell whether open-browser-use is installed, connected, stale,
  repairing, or blocked within a few seconds.
- Agent handoff text is exact enough to paste into Codex, Claude Code, Cursor,
  or another supported agent.
- Browser control feels deliberate. The agent pointer should communicate
  ownership, location, click intent, and release without feeling like a toy.
- Diagnostics should preserve concrete evidence: ids, state names, timestamps,
  stale reasons, and suggested commands.
- Documentation should bias toward commandable examples over conceptual prose.

## Non-Goals

- Do not make the product feel like a remote browser farm.
- Do not hide local setup complexity behind vague "magic" messaging.
- Do not turn the extension popup into a marketing panel.
- Do not add decorative color systems, gradients, or mascot-like personality to
  core product UI.
- Do not use rounded, soft, card-heavy SaaS patterns as the default aesthetic.

## Source Notes

This context is derived from:

- `/Users/labrinyang/projects/open-browser-use-web/index.html`
- `/Users/labrinyang/projects/open-browser-use-web/styles.css`
- `/Users/labrinyang/projects/open-browser-use-web/image.png`
- current extension popup/options styling in this repository
- current repository README, install docs, and lifecycle plans
