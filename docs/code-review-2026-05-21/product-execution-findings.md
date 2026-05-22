# Product Execution Plan Code Review Findings - 2026-05-21

## Scope

This document reviews the current implementation against
`docs/codex-re-product-execution-plan.md`.

It separates current findings from findings fixed during this pass and
historical findings that were valid during an earlier review pass.

Review stance:

- Current branch: `codex/streamline-agent-install-prompt`.
- Review target: current working tree.
- This artifact now includes resolution evidence for implementation fixes made
  in this working tree.

## Current Findings Against Working Tree

No current findings remain from this review pass after the fixes in this working
tree.

## Resolved Findings In This Working Tree

### P1. Popup copied handoff still teaches the pre-fast-path setup flow

Status: fixed in working tree.

Evidence:

- `packages/extension/src/popup.ts:571-580` now keeps the popup wrapper minimal:
  prompt URL, browser, concrete channel/id, source-of-truth instruction, and the
  fast-path contract.
- The copied contract now says to always run the official installer first, run
  one-agent `setup --agents=<agent-id> --browser=chrome --channel=<channel>
  --extension-id=<id> --write-instructions --json`, then run `verify
  --agent=<agent-id> --browser=chrome --channel=<channel> --extension-id=<id>
  --json`, and stop on `result: ready`.
- `packages/extension/scripts/test-popup.mjs:71-85` asserts the positive
  fast-path contract and rejects the stale conditional-install / generic-MCP
  summary.

Previously violated contract:

P0.1 says the copied extension handoff should let the current agent complete
install/setup/verify with the fewest safe branches. The plan also makes
installer refresh on every handoff intentional because the prompt may be pasted
into stale environments.

Previous impact:

The most important user-facing copy action could send agents down the old
conditional-install path. In stale environments, the agent may skip the
idempotent installer refresh that the release plan depends on.

Previous root cause:

The popup carries a manually maintained summary of the prompt instead of
generating from, embedding, or testing against the prompt's executable fast-path
contract. Agent-facing prose is product API here, but it is tested like ordinary
documentation.

Fix direction:

Completed: the popup wrapper points to the prompt as source of truth and popup
tests now assert installer-first, one-agent setup, `--write-instructions`,
concrete browser/channel/id flags, `verify --agent`, no broad setup, and
stop-on-ready.

### P1. Dialog policy misses raw page JavaScript execution

Status: fixed in working tree.

Evidence:

- `crates/obu-host/src/backends/cdp/dialogs.rs:12-24` now treats
  `Runtime.evaluate` as dialog-sensitive.
- `crates/obu-host/src/backends/cdp/dialogs.rs:27-48` centralizes CDP command
  execution through `send_command_with_dialog_policy`.
- CDP raw execution, CDP navigation composition, Playwright injection, and
  Playwright runtime evaluation now call that wrapper:
  `crates/obu-host/src/backends/cdp/execute.rs:19-20`,
  `crates/obu-host/src/backends/cdp/compose/tab_goto.rs:19-27`,
  `crates/obu-host/src/backends/cdp/ensure_injected.rs:19-33` and `:44-58`,
  and `crates/obu-host/src/backends/cdp/playwright/mod.rs:57-70`.
- WebExtension raw execution uses the same dialog-sensitive method set at
  `crates/obu-host/src/backends/webext/mod.rs:292-304`, so raw
  `Runtime.evaluate` is now wrapped there too.
- SDK `tab.evaluate()` sends raw `Runtime.evaluate` at
  `packages/sdk/src/tab.ts:279-285`; that path now reaches the wrapped raw CDP
  execution.
- Regression coverage:
  `crates/obu-host/tests/cdp_backend_ops.rs:691-706` and
  `crates/obu-host/tests/webext_bridge.rs:1659-1794` cover
  `Runtime.evaluate` for `alert`, `beforeunload`, `confirm`, and `prompt`.

Previously violated contract:

P0.5 says browser dialogs are automation blockers. `alert` and `beforeunload`
should not hang automation, while `confirm` and `prompt` should surface
structured `dialog_requires_decision` errors instead of hanging or being
silently accepted.

Previous impact:

`tab.evaluate(() => alert("x"))`, `tab.evaluate(() => confirm("x"))`, or
`tab.evaluate(() => prompt("x"))` could still block or degrade into a generic
timeout instead of the planned structured dialog result. This leaves a major
programmable browser surface outside the product error matrix.

Nuance:

The extension event listener can auto-handle some `Page.javascriptDialogOpening`
events for attached tabs, but the host-side dialog-aware wrapper still does not
own raw page JavaScript execution. The fix should target the capability boundary,
not only a single CDP method string.

Previous root cause:

The implementation models dialog risk as a CDP method allowlist. It misses that
`Runtime.evaluate` is the core "execute page JavaScript" capability, and
arbitrary page JavaScript can open native dialogs.

Fix direction:

Completed: raw `Runtime.evaluate`, Playwright runtime evaluation, and
Playwright injection now go through the dialog-aware wrapper. CDP and
WebExtension regressions cover `alert`, `beforeunload`, `confirm`, and
`prompt`.

### P1. Failed keep/deliverable finalization can silently drop tab ownership

Status: fixed in working tree.

Evidence:

- `packages/extension/src/background.ts:1260-1308` no longer mutates the row
  before the keep/deliverable transition commits.
- Deliverable finalization builds a committed `finalizedRow` only after cleanup,
  deliverable grouping, and tab read succeed.
- Handoff finalization sets `row.status = "handoff"` only after cleanup,
  managed-tab status update, and tab read succeed.
- Generic transition failures now throw
  `finalizeTabs failed_to_finalize ... ownership is unchanged` via
  `packages/extension/src/background.ts:1671-1680`; only `isTabGoneError`
  terminal evidence removes ownership and records the closed bucket.
- `packages/extension/scripts/test-background.mjs:1040-1107` covers failed
  handoff and deliverable transitions and verifies the tab remains active and
  owned after failure.

Previously violated contract:

P0.3 and P0.4 require finalization to use the four-bucket lifecycle model:
handoff, deliverable, closed, or released. A live tab should not become unowned
because a Chrome grouping or metadata operation failed.

Previous impact:

A transient `chrome.tabs.group`, `chrome.tabGroups.update`, or `chrome.tabs.get`
failure could leave a real browser tab alive but invisible to OBU's lifecycle
state. Later cleanup, resume, and product status surfaces can no longer explain
or recover the tab deterministically.

Previous root cause:

The keep path stages state mutation before the transition commits, then treats
every failure as if the tab disappeared. That is only safe after terminal
evidence such as "tab not found"; it is not safe for generic Chrome API errors.

Fix direction:

Completed: keep/deliverable transitions now commit only after the transition
succeeds; generic failures preserve active ownership and return a structured
failure message, while tab-gone evidence is the only catch path that deletes
ownership.

### P2. Installer staged-payload validation omits the MCP runtime binary

Status: fixed in working tree.

Evidence:

- `scripts/payload-contract.mjs:1-9` defines the shared runtime-critical
  payload file contract.
- `scripts/assemble-payload.mjs:9` and `:78` write that contract into release
  metadata as `release.requiredFiles`.
- `scripts/payload-self-check.mjs:8`, `:33`, and `:47-49` validate payload
  metadata and required files against the same shared contract.
- `scripts/install.sh:39-112` now validates bundled Node, `bin/obu-host`,
  `bin/obu-node-repl`, `cli/dist/index.js`, the SDK bundle
  `node_modules/@open-browser-use/sdk/dist/index.mjs`,
  `extension/dist/manifest.json`, and `metadata.json`; when
  `release.requiredFiles` is present, it validates the staged payload from that
  metadata.
- `scripts/assemble-payload.mjs:119-128` stages `bin/obu-node-repl`.
- `scripts/payload-self-check.mjs:44-45` requires `bin/obu-node-repl`.
- `packages/cli/src/index.ts:482-486` requires that executable for
  `obu mcp stdio`.
- `scripts/install-refresh-safety-smoke.mjs:27-34` and `:85-128` cover missing
  node, host, CLI, SDK bundle, extension manifest, missing `bin/obu-node-repl`,
  and non-executable `bin/obu-node-repl` artifacts, and assert the previous
  payload remains active.

Previously violated contract:

P0.7 makes repeated popup handoff installs a release prerequisite. A staged
payload should not be activated unless the runtime needed by the copied handoff
is present and executable.

Previous impact:

A corrupt artifact missing `obu-node-repl` could pass installer validation, switch
`payloads/current`, and then fail only when an agent tries to start MCP. That
converts an install-time integrity problem into a runtime setup failure.

Previous root cause:

The installer keeps its own minimal required-file list that is narrower than the
assembler, payload self-check, doctor, and CLI runtime expectations. Payload
shape is not schema-owned.

Fix direction:

Completed for the runtime-critical gap: installer validation now rejects missing
node, host, node-repl, CLI, SDK bundle, extension manifest, and metadata inputs;
it also rejects non-executable `bin/obu-node-repl`, and install-refresh safety
smoke coverage proves the previous payload/current symlink is preserved. The
release payload contract is now shared through `payload-contract.mjs` and
`release.requiredFiles`.

## Superseded Historical Findings

These findings were valid in an earlier review pass, but current source and
targeted tests show they are fixed or no longer accurate. Keep them only as
historical context.

### WebExtension `finalizeTabs` resurrected preclosed tabs

Status: fixed in current HEAD.

Earlier finding:

The host preclosed omitted agent tabs, then processed extension `kept_tabs` and
`deliverable_tabs` rows for the same ids, potentially re-recording closed tabs.

Current evidence:

- `crates/obu-host/src/backends/webext/mod.rs:470-473` adds preclosed ids to
  `closed_tab_ids`, collects terminal ids, and prunes terminal rows.
- `crates/obu-host/src/backends/webext/mod.rs:2618-2640` removes terminal ids
  from `kept_tabs` and `deliverable_tabs`.
- Targeted validation:
  `cargo test -q -p obu-host --test webext_bridge webext_backend_normalizes_user_tabs_history_and_finalize`
  passed.

### Extension cleanup raw-closed tabs outside dialog-aware policy

Status: fixed in current HEAD.

Earlier finding:

Extension lifecycle paths used naked `chrome.tabs.remove`, bypassing the
dialog-aware close policy.

Current evidence:

- `rg "chrome\\.tabs\\.remove" packages/extension/src/background.ts` returns no
  current source matches.
- `packages/extension/src/background.ts:1264` routes omitted agent finalization
  through `closeAgentTabWithDialogPolicy`.
- `packages/extension/src/background.ts:1591-1645` implements the dialog-aware
  close helper around `Page.enable` and `Page.close`.

### Dispatcher same-tab locking missed session-wide lifecycle operations

Status: fixed in current HEAD.

Earlier finding:

`finalizeTabs` lacked session-wide lifecycle locking and could interleave with
same-session tab mutations.

Current evidence:

- `crates/obu-host/src/dispatcher.rs:277-284` takes a session operation lock
  before tab-level mutation locking.
- `crates/obu-host/src/dispatcher.rs:682-686` classifies `CREATE_TAB`,
  `FINALIZE_TABS`, and tab-mutating methods as session-mutating.
- Targeted validation:
  `cargo test -q -p obu-host --test dispatcher_concurrency session_lifecycle_waits_for_in_flight_same_session_tab_mutation`
  passed.

### `selectProductError` classified setup failures as popup-boundary failures

Status: fixed in current HEAD.

Earlier finding:

`descriptor_missing` was classified as `browser_popup_boundary` before setup
action kinds were checked.

Current evidence:

- `packages/cli/src/verify.ts:2030-2032` now classifies setup action kinds
  (`install_cli`, `configure_agent`, `select_profile`, `install_extension`,
  `enable_extension`) as `setup_missing` before the descriptor-missing popup
  boundary branch at `packages/cli/src/verify.ts:2033-2035`.

### `browser_status` schema omitted `advisories`

Status: fixed in current HEAD.

Earlier finding:

The implementation emitted `advisories`, but the MCP output schema forbade it.

Current evidence:

- `crates/obu-node-repl/src/mcp_server.rs:141` includes `advisories` in the
  required field list.
- `crates/obu-node-repl/src/mcp_server.rs:171-173` declares the `advisories`
  property as an array.
- `crates/obu-node-repl/src/mcp_server.rs:904-912` has a schema test for this.

### CDP `tab_reload` used approximate navigation instead of browser reload

Status: fixed in current HEAD.

Earlier finding:

CDP reload read `location.href` and called `goto` / `Page.navigate`, losing
native browser reload semantics.

Current evidence:

- `crates/obu-host/src/backends/cdp/compose/tab_goto.rs:60-62` delegates reload
  to `tab_navigation::reload`.
- `crates/obu-host/src/ops/tab_navigation.rs:47-53` sends `Page.reload`.
- `crates/obu-host/tests/cdp_backend_ops.rs:526-563` covers the dialog-aware
  `Page.reload` path.

### Installer migration hook validation was broader than payload metadata

Status: fixed in current HEAD.

Earlier finding:

The installer accepted broader migration names than the release metadata pattern.

Current evidence:

- `scripts/install.sh:147-156` accepts `NNN-*.sh`, strips the suffix, and rejects
  empty slugs or characters outside lowercase `a-z`, digits, and hyphen.
- This matches the release metadata intent of
  `^[0-9]{3}-[a-z0-9-]+\\.sh$`.

## Current Cross-Cutting Patterns

### Agent-facing prose is executable API

The popup handoff showed the drift pattern: copyable text, prompt text, CLI
setup behavior, and tests must agree. For this product, text pasted into an
agent is part of the runtime contract.

General rule: copied handoffs must be generated from one source of truth or
covered by positive contract tests. It is not enough to assert that old commands
are absent.

### Policies should attach to capabilities, not implementation strings

The dialog gap existed because policy was keyed to a list of CDP method names.
That list can miss a capability such as "execute page JavaScript" even though
the user-visible product state is identical.

General rule: dialog, timeout, guard, and cleanup policy should be enforced at
the capability boundary: page JavaScript execution, input, navigation, reload,
close, and finalization.

### Lifecycle transitions must be atomic

The extension keep/deliverable path previously mutated the tab's lifecycle row
before the transition committed, then deleted ownership on a generic failure.

General rule: active -> handoff/deliverable/closed/released transitions should
commit only after the target state has been proven. Failed transitions should
preserve the previous state unless terminal evidence proves the tab is gone.

### Payload shape needs a shared contract

Installer validation, payload assembly, payload self-check, doctor, and runtime
layout all encode required files. The runtime-critical payload shape is now
owned by `scripts/payload-contract.mjs` and copied into release metadata for
installer validation.

General rule: installer validation must be at least as strict as the
runtime-critical portion of payload self-check, or both should be generated from
shared metadata.

## Remaining Sibling Checks

- Add a `chrome.tabGroups.update` failure variant for keep/deliverable
  finalization. `chrome.tabs.get` and `chrome.tabs.group` failure variants are
  now covered.
- Add a small stale-finding guard to this document workflow: every finding should
  carry `Status`, `Evidence`, and either current validation or superseded
  evidence.

## Validation Performed

Current revalidation:

- `pnpm --filter @open-browser-use/extension test`: passed.
- `node scripts/install-refresh-safety-smoke.mjs`: passed.
- `node --check scripts/assemble-payload.mjs`: passed.
- `node --check scripts/payload-self-check.mjs`: passed.
- `node --check scripts/payload-contract.mjs`: passed.
- `cargo test -q -p obu-host --test cdp_backend_ops`: passed.
- `cargo test -q -p obu-host --test webext_bridge`: passed.
- `git diff --check`: passed.

Earlier validation from the original review pass is not repeated here. It should
not be used as current evidence unless rerun against the current worktree.
