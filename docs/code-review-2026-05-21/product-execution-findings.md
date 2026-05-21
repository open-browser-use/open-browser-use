# Product Execution Plan Code Review Findings - 2026-05-21

## Scope

This document consolidates all confirmed findings from the current review pass against `docs/codex-re-product-execution-plan.md`, including the additional findings supplied by a separate AI reviewer.

The review focused on whether the implementation preserves the plan's product contracts around tab lifecycle, dialog-aware automation, setup diagnostics, MCP output schemas, reload semantics, concurrency, and installer metadata. This is a documentation-only review artifact; no implementation fixes are included here.

## Findings

### P1. WebExtension `finalizeTabs` can create contradictory lifecycle state

- Evidence: `crates/obu-host/src/backends/webext/mod.rs:459-463` precloses omitted agent tabs with `Page.close` and stores `preclosed_agent_tab_ids`. The same function then processes `kept_tabs` and `deliverable_tabs` from the extension response at `crates/obu-host/src/backends/webext/mod.rs:483-496` without filtering out those preclosed ids, and records the rows again as active agent tabs.
- Violated contract: P0.4 turn closeout semantics and P1.3 event attribution / handle ownership require finalized or closed tabs to remain closed from the registry's point of view, with stale-handle tombstones preserved for explainable missing-handle errors.
- Impact: A tab can be both closed/finalized and then re-recorded as kept or deliverable. That breaks lifecycle ownership, resurrects stale handles, and can make later agents believe a closed tab is still actionable.
- Existing regression signal: `cargo test -q -p obu-host --tests` fails in `webext_backend_normalizes_user_tabs_history_and_finalize` at `crates/obu-host/tests/webext_bridge.rs:311`, where the stale download tombstone expectation no longer holds after deliverable re-recording.
- Fix direction: Make one layer own the close/finalize decision. If the host precloses omitted agent tabs, reject or filter extension `kept_tabs` / `deliverable_tabs` rows for those ids before recording state, and preserve stale tombstones for handles owned by finalized tabs.

### P1. Extension cleanup still raw-closes tabs outside dialog-aware policy

- Evidence: `packages/extension/src/background.ts:1219` calls `chrome.tabs.remove(tabId)` during `finalizeTabs`. `packages/extension/src/background.ts:1731` calls `chrome.tabs.remove(tabId)` during popup Stop/Cleanup handling.
- Violated contract: P0.5 requires tab close and finalize paths to be dialog-aware. Browser dialogs are automation blockers, not incidental UI.
- Impact: The host-side preclose path covers only host-known tabs. Service-worker restarts, host/extension desync, popup cleanup, or extension-only ownership paths can still raw-close dirty tabs. A dirty `beforeunload`, `confirm`, or `prompt` path can hang or mutate state before the close result is known.
- Fix direction: Route extension-side close/remove operations through a centralized dialog-aware close helper. If the extension cannot observe and handle the dialog policy for a tab, fail before mutating session state. Add a grep/lint test that bans naked `chrome.tabs.remove` in lifecycle paths.

### P2. Dispatcher same-tab locking misses session-wide lifecycle operations

- Evidence: `crates/obu-host/src/dispatcher.rs:274-279` only takes a per-tab lock when `tab_mutation_key` extracts a `tab_id`. `finalizeTabs` routes through `crates/obu-host/src/dispatcher.rs:342-347`, but `FINALIZE_TABS` is absent from the mutating method list at `crates/obu-host/src/dispatcher.rs:656-668`.
- Violated contract: P1.5 requires concurrency protection before exposing more parallelism. Session lifecycle operations mutate many tabs and cannot be protected only by per-tab request ids.
- Impact: `finalizeTabs` can interleave with same-tab navigation, clicks, CUA input, or CDP commands. That allows operations to run against a tab while another request is finalizing, releasing, closing, or reclassifying it.
- Fix direction: Introduce a session lifecycle lock or acquire an ordered lock set for all current session tabs before finalize/cleanup. Add a concurrency regression where `finalizeTabs` cannot interleave with same-tab `goto`, click, or CUA operations.

### P2. `selectProductError` can classify setup failures as popup-boundary failures

- Evidence: `packages/cli/src/verify.ts:2030-2031` returns `browser_popup_boundary` for any `descriptor_missing` before checking setup action kinds. Setup action classification for `install_cli`, `configure_agent`, `select_profile`, `install_extension`, and `enable_extension` happens later at `packages/cli/src/verify.ts:2054-2055`.
- Violated contract: Product diagnostics must choose the currently actionable dependency layer. A low-level missing descriptor does not prove the next user action is opening the popup.
- Impact: If the extension is missing, disabled, or the user still needs to select a browser profile, `nextAction.kind` can correctly say `install_extension`, `enable_extension`, or `select_profile`, while `productError.code` incorrectly says `browser_popup_boundary`.
- Fix direction: Derive `productError.code` from the selected `nextAction.kind`, or move setup-action classification before descriptor-missing popup classification. Add table tests for each setup action and descriptor state combination.

### P2. `browser_status` schema omits `advisories`

- Evidence: `crates/obu-node-repl/src/mcp_server.rs:141-142` defines the `browser_status` output schema with `additionalProperties: false` and no `advisories` property. The implementation emits `"advisories"` at `crates/obu-node-repl/src/repl_manager/mod.rs:227-237`.
- Violated contract: MCP structured output schemas must match actual structured output, especially when schema-validating clients are expected.
- Impact: Clients that validate MCP structured output can reject a valid `browser_status` response because the implementation returns a field that the schema forbids.
- Fix direction: Add `advisories` to the schema, likely as a required array because the implementation always emits it. Add a schema-validation test that validates the real `browser_status` output against the declared MCP schema.

### P2. CDP `tab_reload` no longer uses browser reload semantics

- Evidence: `crates/obu-host/src/backends/cdp/compose/tab_goto.rs:60-64` implements reload by reading `location.href` and calling `goto` / `Page.navigate`. The shared reload path still uses `Page.reload` at `crates/obu-host/src/ops/tab_navigation.rs:47-53`.
- Violated contract: Browser primitives should retain their browser-level semantics unless the product contract explicitly defines a compatibility exception.
- Impact: The new path depends on JavaScript evaluation to recover the URL and changes reload behavior into a same-URL navigation. If JS evaluation is broken, the page could fail to reload even though `Page.reload` could still recover it. It can also differ from native reload semantics around POST reloads, cache behavior, history, and lifecycle events.
- Fix direction: Keep `tab_navigation::reload` for CDP reload. If live Chrome has a `Page.reload` hang that motivated this change, document the exception explicitly and pin it with live-browser tests.

### P3. Installer migration hook validation is broader than payload metadata

- Evidence: Release metadata declares migration hook names must match `^[0-9]{3}-[a-z0-9-]+\\.sh$` in `scripts/assemble-payload.mjs:66-69`. The installer accepts any `[0-9][0-9][0-9]-*.sh` at `scripts/install.sh:147-149`.
- Violated contract: Installer acceptance criteria and payload metadata should describe the same executable contract.
- Impact: A payload can contain a migration hook name that the installer will execute even though the metadata says that name is invalid. This weakens release self-checks and creates avoidable drift between generated metadata and runtime behavior.
- Fix direction: Enforce the same lowercase slug pattern in `install.sh`, and add an invalid-name smoke test.

## Cross-Cutting Failure Patterns

### Lifecycle state must have one owner

The strongest issue is not a single bad branch; it is split ownership. Host preclose, extension finalize, registry recording, and stale-handle tombstones all mutate the same lifecycle model. When two layers can independently decide that a tab is closed, kept, released, or deliverable, contradictory states become possible.

General rule: every lifecycle transition needs a single owner and a monotonic state machine. Once a tab is closed, released, or finalized, later lower-trust reports must not resurrect it without an explicit recovery transition.

### Dialog-safe wrappers must be the only lifecycle primitives

The plan treats dialogs as blocking product states, but the code still has raw close primitives in extension cleanup paths. Dialog policy cannot be guaranteed if important lifecycle paths can bypass the wrapper.

General rule: direct browser primitives such as `chrome.tabs.remove`, `Page.close`, `Page.reload`, and `Page.navigate` should be wrapped at the boundary where product policy is enforced. Tests or lint checks should ban raw primitives in lifecycle paths except inside the approved wrapper.

### Actionable product errors must be selected from the active dependency layer

`descriptor_missing` is evidence, not a complete diagnosis. The actionable layer may be CLI setup, profile selection, extension installation, extension enablement, native-host repair, popup resume, or backend runtime readiness.

General rule: product error selection should follow the selected next action, not whichever low-level diagnostic happens to be checked first. A single diagnostic can support multiple product errors depending on higher-level readiness.

### Schemas with `additionalProperties: false` require actual-output validation

The `browser_status` drift shows the risk of maintaining result builders and MCP schemas separately. Once `additionalProperties: false` is present, new fields are breaking unless the schema changes with them.

General rule: every MCP tool with a declared structured schema should have a test that validates representative real output against that exact schema.

### Browser primitives should not be replaced by approximate compositions

Replacing reload with `location.href` plus navigate looks small, but it crosses a semantic boundary. A browser-native operation has behavior around dialogs, cache, history, form resubmission, and broken JS contexts that composed operations may not preserve.

General rule: keep native browser primitives for product-level operations unless a documented compatibility exception explains the substitute and tests the important differences.

### Per-tab locks do not protect session-wide transitions

The dispatcher currently locks operations that name one tab. `finalizeTabs` mutates a session's tab set and can affect many tabs without naming any one target tab.

General rule: operations that mutate a set need a set-level or session-level lock. Locking only the target tab is insufficient for lifecycle transitions, cleanup, release, and finalization.

### Duplicated contracts drift unless generated or cross-validated

Installer migration patterns, payload metadata, SDK product-error matrices, CLI product-error descriptions, and MCP output schemas all duplicate parts of the product contract.

General rule: duplicate contract fragments should either be generated from one source of truth or covered by cross-validation tests that fail on drift.

## Sibling Risks To Check

- `crates/obu-node-repl/src/repl_manager/mod.rs:962-972`: `browser_status_product_error()` checks stale descriptors before SDK bootstrap availability. This may repeat the same "low-level evidence beats setup layer" bug seen in `selectProductError`.
- `packages/sdk/src/errors.ts:78` and `packages/cli/src/verify.ts:2073`: SDK `PRODUCT_ERROR_MATRIX` and CLI `PRODUCT_ERROR_DESCRIPTIONS` duplicate product-error titles, summaries, and next actions. Add a parity test or generate both from shared metadata.
- MCP schemas/result builders beyond `browser_status`: any tool schema using `additionalProperties: false` should be checked against actual emitted output.
- Extension lifecycle cleanup paths beyond the two cited `chrome.tabs.remove` calls: search for direct tab close/remove/reload primitives and decide whether each is inside a policy wrapper or should be moved behind one.
- Host/extension finalization tests: add negative cases where the extension reports a preclosed id in `kept_tabs` or `deliverable_tabs`, and assert the registry keeps the closed/finalized tombstone.
- Dispatcher concurrency tests: add session-wide lifecycle interleaving tests, not only per-tab mutation tests.
- Installer/release metadata: add a smoke that invalid migration hook names are rejected by both payload assembly/self-check and the installer.

## Validation Performed

Previously run validation from this review loop:

- `pnpm typecheck`: passed.
- `pnpm --filter @open-browser-use/sdk test -- --runInBand`: passed.
- `pnpm --filter @open-browser-use/extension test`: passed.
- `pnpm --filter @open-browser-use/cli test`: passed.
- `cargo test -q -p obu-node-repl --tests`: passed.
- `pnpm test:oracles`: passed.
- `git diff --check`: passed.
- `cargo test -q -p obu-host --tests`: failed in `webext_backend_normalizes_user_tabs_history_and_finalize` at `crates/obu-host/tests/webext_bridge.rs:311`, consistent with the P1 lifecycle/tombstone finding.

After adding this document, `git diff --check` passed again.
