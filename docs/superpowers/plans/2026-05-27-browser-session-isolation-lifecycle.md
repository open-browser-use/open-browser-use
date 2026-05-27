# Browser Session Isolation Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate user takeover state from unrelated future agent work while preserving resume semantics for the taken-over tab.

**Architecture:** Treat the Node REPL/MCP session as the agent runtime identity and each `agent.browsers.get()` Browser object as a distinct browser-control session. The extension keeps `human_takeover` as a per-browser-session lifecycle state; SDK-scoped session ids prevent a yielded session from blocking new agent-created tab groups.

**Tech Stack:** TypeScript SDK, Chromium MV3 extension controller tests, Rust WebExtension host normalization tests.

---

### Task 1: Lock In Extension Invariants

**Files:**
- Modify: `packages/extension/scripts/test-browser-session-controller.mjs`
- Modify: `packages/extension/scripts/test-background.mjs`

- [x] **Step 1: Write the failing tests**

Add assertions that `createSessionTab()` calls Chrome with `{ active: false }`, and that the `createTab` RPC response is immediately `owned: true`, `claimRequired: false`, `commandable: true`, and `logicalActive: true`.

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
node packages/extension/scripts/test-browser-session-controller.mjs
cargo test -p obu-host --test webext_bridge webext_backend_normalizes_extension_tab_dtos -- --nocapture
```

Expected: controller test fails on `active: true`; host DTO test fails because ownership fields are missing.

- [x] **Step 3: Implement minimal extension/host fix**

Change `BrowserSessionController.createSessionTab()` to create background tabs and return create DTOs from the registered session row.

- [x] **Step 4: Verify**

Run:

```bash
pnpm --filter @open-browser-use/extension test
cargo test -p obu-host
```

Expected: all tests pass.

### Task 2: Make Browser Objects Use Distinct Logical Sessions

**Files:**
- Modify: `packages/sdk/src/wire/transport.ts`
- Modify: `packages/sdk/src/browsers.ts`
- Test: `packages/sdk/tests/runtime.test.ts`

- [x] **Step 1: Write the failing SDK test**

Add a runtime test that installs request metadata with `session_id: "runtime-session"`, acquires two Browser objects with `agent.browsers.get("cdp")`, calls `browser.tabs.create()` on both, and asserts the two `createTab` calls use different `session_id` values that are not the raw runtime session id.

- [x] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- runtime.test.ts
```

Expected: the new test fails because both create calls use `"runtime-session"`.

- [x] **Step 3: Implement scoped session ids**

Add a `Transport.setSessionIdOverride(sessionId: string)` method that overrides `params.session_id` inside `sendRequest()`. In `Browsers.get()`, allocate deterministic ids like `${runtimeSessionId}:browser:${sequence}` and call the transport override before constructing `Browser`.

- [x] **Step 4: Verify SDK and integration tests**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- runtime.test.ts
pnpm --filter @open-browser-use/sdk test
pnpm --filter @open-browser-use/extension test
cargo test -p obu-host
```

Expected: all tests pass; existing direct `new Browser(...)` tests keep the raw request metadata behavior.

### Task 3: Install And Runtime-Check

**Files:**
- Build outputs only: `target/release/*`, `dist/payload/current`, `dist/curl-local`, `packages/extension/dist`

- [ ] **Step 1: Build release artifacts**

Run:

```bash
cargo build --release -p obu-host -p obu-node-repl
pnpm -r build
node scripts/assemble-payload.mjs --node-root /Users/labrinyang/.obu/payloads/current/node --out dist/payload/current
node scripts/make-curl-artifact.mjs --payload dist/payload/current --out dist/curl-local
```

- [ ] **Step 2: Install and refresh extension**

Run:

```bash
sh scripts/install.sh --artifact dist/curl-local/open-browser-use-0.1.10-darwin-arm64.tar.gz --install-dir /Users/labrinyang/.obu --no-modify-path
/Users/labrinyang/.obu/bin/obu update-extension --path /Users/labrinyang/projects/open-browser-use-public/packages/extension/dist --channel=unpacked-dev
/Users/labrinyang/.obu/bin/obu verify --agent=codex-cli --browser=chrome --channel=unpacked-dev --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj --repair
```

- [ ] **Step 3: Minimal OBU check**

Run `browser_status`, then one JS cell that creates a new Browser and tab. Expected: create succeeds even if `browser_status` still shows a different yielded session; the created tab metadata is commandable and the selected user tab is unchanged.

### Task 4: Preserve Host-Enriched Finalize Results

**Files:**
- Modify: `packages/sdk/src/browser.ts`
- Test: `packages/sdk/tests/wire-shape.test.ts`

- [x] **Step 1: Write the failing SDK test**

Add a finalize response with `closedTabIds: []` plus `closed_tab_ids: ["tab-preclosed"]` and assert the public `closedTabIds` includes `tab-preclosed`.

- [x] **Step 2: Run test to verify failure**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- wire-shape.test.ts
```

Expected: FAIL because `arrayFieldFromEither()` prefers the empty camelCase array.

- [x] **Step 3: Merge aliases in finalize id normalization**

Change `tabIdListField()` to merge camelCase and snake_case arrays with dedupe before normalizing ids.

- [x] **Step 4: Verify**

Run:

```bash
pnpm --filter @open-browser-use/sdk test -- wire-shape.test.ts
```

Expected: PASS.
