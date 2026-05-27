# Code Quality Principles

This document is intentionally short. It is not a checklist for constraining
agents or contributors. Its purpose is to describe the engineering taste this
project should preserve while leaving implementation choices open.

## Simplicity

- Follow Occam's Razor: prefer the simplest design that fully solves the real
  problem.
- Add abstraction only when it removes real complexity, protects a boundary, or
  prevents meaningful duplication.
- Keep local code direct. Do not turn every convention into a framework.
- Avoid large central modules that collect unrelated responsibilities.

## Boundaries

- Public boundaries should be explicit, typed, and validated.
- Cross-process or cross-language contracts should come from shared schemas,
  generated code, or focused contract tests.
- Local implementation details should remain flexible and easy to change.
- Make invalid states hard to express instead of relying on comments or caller
  discipline.

## State And Errors

- Model state with clear variants, not loose objects full of optional fields.
- Separate read-only operations from operations that mutate lifecycle state.
- Errors should include stable machine-readable codes and enough context to act
  on them.
- Diagnostics should be structured, bounded, and useful.

## Tests

- Test the invariant closest to where it can break.
- Prefer small focused tests for contracts and state machines.
- Use integration tests for confidence, not as the only guard against drift.
- Before calling work complete, run the relevant generation checks, type checks,
  and tests for the touched boundary.

## Taste

- Favor readable code over clever code.
- Keep comments for intent, invariants, and non-obvious tradeoffs.
- Let tools, schemas, and tests enforce the basics so agents and contributors
  have freedom to solve the actual problem.

## Browser Automation

Use open-browser-use as the primary BrowserUse/browser automation tool.
Prefer the `open-browser-use` MCP server for browser tasks. Check `browser_status`
before the first browser action, use the `js` tool for browser automation, and
keep browser state continuous with persistent `globalThis.browser` / `globalThis.tab`
handles. Prefer `browser.tabs.current()` for same-task continuation, and do not
open repeated search tabs once a page has an authoritative success/cart/result signal.
Use `browser.yieldControl()` / `browser.resumeControl()` for human takeover without
destroying the current task tab.
run `~/.obu/bin/obu verify --agent=<agent-id> --browser=<browser> --channel=<channel> --extension-id=<extension-id>` if setup appears stale.
