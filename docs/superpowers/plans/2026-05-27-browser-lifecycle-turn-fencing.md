# Browser Lifecycle Turn Fencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser-control lifecycle match the business model: takeover is per session/tab group, resume continues the same grouped tab, new agent work gets an independent group, old/unawaited turn work cannot leak into later tasks, and DB logs contain enough command result evidence to debug the system.

**Architecture:** Keep the extension as the source of browser session/group truth, keep the SDK as the per-browser-session scoping layer, and make the node-repl exec lifecycle drain SDK browser RPCs just like it already drains `nodeRepl.fetch`/image operations. Persist only actionable lifecycle diagnostics; successful turn completion belongs in the task DB, not as stale extension diagnostics.

**Tech Stack:** TypeScript SDK and extension, Node REPL embedded kernel JavaScript, Rust host dispatcher/task store, Vitest, extension script tests, Cargo tests.

---

## Business Lifecycle Model

1. A browser-control session owns a tab group. Agent-created tabs and user-claimed tabs stay in that group while active or yielded.
2. `yieldControl()` is not finalization. It changes commandability to false, hides control UI, and leaves the tab/group recoverable for `resumeControl()`.
3. `resumeControl()` is scoped to the same session. It repairs stale tab references if needed, then reactivates control on the same grouped tab when live.
4. A separate `agent.browsers.get("chrome")` call creates a separate scoped session id (`runtime:browser:N`). Human takeover in session A must not block session B from opening a new agent tab/group.
5. `finishTurn()` is cleanup. Agent tabs close unless kept, user tabs release or move to deliverable/handoff depending on keep policy.
6. A successful `turnEnded` is not an actionable diagnostic. The durable task DB records `turn_ended`; extension diagnostics should show only open/finalizing/yielded/failure/stale states.
7. Browser RPCs started during a JS exec must be drained before the exec result is returned. Otherwise an unawaited SDK operation can keep mutating the browser after the agent has moved on.

## Files

- Modify: `packages/extension/src/browser_session_controller.ts`
  - Make successful `markTurnEnded()` persist session state.
- Modify: `packages/extension/src/background.ts`
  - Await the now-async turn-ended controller method.
- Modify: `packages/extension/src/session_store.ts`
  - Avoid persisting successful ended-turn diagnostics as durable actionable state.
- Modify: `packages/extension/src/browser_session_repository.ts`
  - Hide successful ended-turn rows from lifecycle diagnostics.
- Modify: `packages/extension/scripts/test-browser-session-controller.mjs`
  - Add a red test for turn-ended persistence.
- Modify: `packages/extension/scripts/test-browser-session-repository.mjs`
  - Add red tests for successful ended-turn pruning/diagnostic filtering.
- Modify: `crates/obu-node-repl/embedded/kernel.js`
  - Expose `obuRepl.trackBackgroundOperation()` backed by existing exec background task tracking.
- Modify: `packages/sdk/src/wire/transport.ts`
  - Track each browser RPC response promise with `obuRepl.trackBackgroundOperation()` when available.
- Modify: `packages/sdk/tests/transport.test.ts`
  - Add red tests for SDK transport background tracking.
- Modify: `crates/obu-node-repl/tests/mcp_stdio.rs`
  - Add red tests proving `obuRepl.trackBackgroundOperation()` drains unawaited operations and surfaces unhandled failures.
- Modify: `crates/obu-host/src/dispatcher.rs`
  - Add safe browser-command result summaries to DB `browser_command` payloads.
- Modify: `crates/obu-host/tests/task_rpc.rs`
  - Add red tests for URL/title/finalize result summaries and redaction boundaries.

---

### Task 1: Turn-End Persistence And Diagnostics

**Files:**
- Modify: `packages/extension/src/browser_session_controller.ts`
- Modify: `packages/extension/src/background.ts`
- Modify: `packages/extension/src/session_store.ts`
- Modify: `packages/extension/src/browser_session_repository.ts`
- Test: `packages/extension/scripts/test-browser-session-controller.mjs`
- Test: `packages/extension/scripts/test-browser-session-repository.mjs`

- [ ] **Step 1: Write failing extension tests**

Add a controller test:

```javascript
{
  const session = sessionWithTabs([[12, { tabId: 12, origin: "agent", status: "active" }]], {
    activeTabId: 12,
  });
  const harness = createHarness({ session, tabsById: new Map([[12, tabForId(12)]]) });

  await harness.controller.markTurnEnded(sessionParams());

  assert.equal(session.turnLifecycle.kind, "ended");
  assert.equal(harness.calls.persist, 1);
}
```

Add repository tests:

```javascript
const endedOnly = repository.sessionFor("ended-only");
endedOnly.turnLifecycle = { kind: "ended", sessionId: "ended-only", turnId: "turn-ok", finalization: "ok" };
repository.pruneEmptySessions();
assert.equal(repository.get("ended-only"), undefined);

const endedWithTab = repository.sessionFor("ended-with-tab");
endedWithTab.tabs.set(9, { tabId: 9, origin: "agent", status: "active" });
endedWithTab.turnLifecycle = { kind: "ended", sessionId: "ended-with-tab", turnId: "turn-ok", finalization: "ok" };
assert.deepEqual(repository.lifecycleDiagnostics().filter((row) => row.session_id === "ended-with-tab"), []);
```

- [ ] **Step 2: Run tests and verify red**

Run: `pnpm --filter @open-browser-use/extension test`

Expected: controller test fails because `markTurnEnded()` is sync and does not persist; repository tests fail because ended-turn diagnostics still prevent pruning and appear in diagnostics.

- [ ] **Step 3: Implement turn-end persistence and successful-ended filtering**

Change `markTurnEnded()` to `async` and persist after setting turn lifecycle. Add helper logic so `shouldPruneBrowserSession()` treats successful `ended` as non-actionable, `serializeBrowserSessions()` persists successful ended turns as `idle`, and `lifecycleDiagnostics()` filters successful ended turns.

- [ ] **Step 4: Run extension tests and verify green**

Run: `pnpm --filter @open-browser-use/extension test`

Expected: all extension script tests pass.

### Task 2: Drain SDK Browser RPCs During Node REPL Exec

**Files:**
- Modify: `crates/obu-node-repl/embedded/kernel.js`
- Modify: `packages/sdk/src/wire/transport.ts`
- Test: `packages/sdk/tests/transport.test.ts`
- Test: `crates/obu-node-repl/tests/mcp_stdio.rs`

- [ ] **Step 1: Write failing SDK transport test**

Add a test that installs:

```typescript
(globalThis as { obuRepl?: unknown }).obuRepl = {
  trackBackgroundOperation(operation: Promise<unknown>) {
    tracked.push(operation);
    return operation;
  },
};
```

Then call `transport.sendRequest("tab_url", {}, 1000)` and assert exactly one tracked operation was registered before resolving the fake connection response.

- [ ] **Step 2: Write failing node-repl MCP tests**

Add one exec that calls `globalThis.obuRepl.trackBackgroundOperation(new Promise((resolve) => setTimeout(resolve, 25))); "done";` and assert the result is `"done"` only after the tracked promise drains.

Add one exec that calls `globalThis.obuRepl.trackBackgroundOperation(Promise.reject(new Error("tracked boom"))); "done";` and assert the exec returns an error containing `tracked boom`.

- [ ] **Step 3: Run tests and verify red**

Run: `pnpm --filter @open-browser-use/sdk test -- transport.test.ts`

Run: `cargo test -p obu-node-repl mcp_stdio`

Expected: SDK test fails because no tracker is called; node-repl test fails because `obuRepl.trackBackgroundOperation` is missing.

- [ ] **Step 4: Implement background operation tracking**

Expose `trackBackgroundOperation(operation)` on `obuRepl` using the existing `trackExecBackgroundOperation()` and active exec state. In SDK `Transport.sendRequest`, wrap the response promise with this tracker when it exists.

- [ ] **Step 5: Run SDK and node-repl tests and verify green**

Run: `pnpm --filter @open-browser-use/sdk test -- transport.test.ts`

Run: `cargo test -p obu-node-repl mcp_stdio`

Expected: tests pass; unawaited browser RPC promises are now drained by the exec lifecycle.

### Task 3: Browser Command Result Summaries In DB Logs

**Files:**
- Modify: `crates/obu-host/src/dispatcher.rs`
- Test: `crates/obu-host/tests/task_rpc.rs`

- [ ] **Step 1: Write failing host logging tests**

Add tests proving `browser_command` events include safe `result` summaries for:

```text
tab_url -> { "type": "string", "value": "https://example.test/" }
tab_title -> { "type": "string", "value": "Example" }
finalizeTabs -> { "type": "finalizeTabs", "status": "ok", "closedTabIds": [...] }
```

Also assert `tab_evaluate` does not store full raw evaluated text, only a bounded summary.

- [ ] **Step 2: Run host tests and verify red**

Run: `cargo test -p obu-host task_rpc`

Expected: tests fail because `browser_command` only records method/status/duration/params/error.

- [ ] **Step 3: Implement safe result summaries**

Add `command_result_summary(method, result)` in `dispatcher.rs`. Store only bounded strings and selected tab/finalize fields; never store full screenshots, evaluate payloads, clipboard contents, file paths, or arbitrary JSON blobs.

- [ ] **Step 4: Run host tests and verify green**

Run: `cargo test -p obu-host task_rpc`

Expected: host tests pass and DB browser-command logs are more useful without unbounded sensitive payloads.

### Task 4: End-To-End Verification, Install, And Resume Autoresearch

**Files:**
- Build artifacts and installed payload under `/Users/labrinyang/.obu`
- Extension dist under `packages/extension/dist`

- [ ] **Step 1: Run full focused verification**

Run:

```bash
pnpm --filter @open-browser-use/sdk test
pnpm --filter @open-browser-use/extension test
cargo test -p obu-node-repl
cargo test -p obu-host
cargo build --release -p obu-host -p obu-node-repl
pnpm -r build
```

- [ ] **Step 2: Commit**

Run:

```bash
git add packages/extension/src/browser_session_controller.ts packages/extension/src/background.ts packages/extension/src/session_store.ts packages/extension/src/browser_session_repository.ts packages/extension/scripts/test-browser-session-controller.mjs packages/extension/scripts/test-browser-session-repository.mjs crates/obu-node-repl/embedded/kernel.js packages/sdk/src/wire/transport.ts packages/sdk/tests/transport.test.ts crates/obu-node-repl/tests/mcp_stdio.rs crates/obu-host/src/dispatcher.rs crates/obu-host/tests/task_rpc.rs docs/superpowers/plans/2026-05-27-browser-lifecycle-turn-fencing.md
git commit -m "fix: fence browser turn lifecycle"
```

- [ ] **Step 3: Install updated payload and extension**

Run:

```bash
node scripts/assemble-payload.mjs --node-root /Users/labrinyang/.obu/payloads/current/node --out dist/payload/current
node scripts/make-curl-artifact.mjs --payload dist/payload/current --out dist/curl-local
sh scripts/install.sh --artifact dist/curl-local/open-browser-use-0.1.10-darwin-arm64.tar.gz --install-dir /Users/labrinyang/.obu --no-modify-path
/Users/labrinyang/.obu/bin/obu update-extension --path /Users/labrinyang/projects/open-browser-use-public/packages/extension/dist --channel=unpacked-dev
/Users/labrinyang/.obu/bin/obu verify --agent=codex-cli --browser=chrome --channel=unpacked-dev --extension-id=fblnfcjnjklpgnmfnngcihbcgojnpadj --repair
```

- [ ] **Step 4: Resume autoresearch batches**

Run the remaining website workflows in batches, backing up `/tmp/obu-501/tasks/tasks.db` after each batch and checking that:

```sql
select kind,count(*) from task_events group by kind order by kind;
select json_extract(payload,'$.method'), json_extract(payload,'$.result') from task_events where kind='browser_command' order by at desc limit 20;
```

Expected: no old session commands interleave after `js` completion; successful ended turns do not linger in `browser_status` diagnostics; command logs include result summaries.

---

## Self-Review

**Spec coverage:** The plan covers tab-group takeover/resume semantics, separate agent sessions, stale/late work, DB logging gaps, tests, commit, install, and returning to autoresearch.

**Placeholder scan:** No task contains TBD/TODO/fill-later placeholders. Each implementation task names exact files and commands.

**Type consistency:** The plan uses existing names: `markTurnEnded`, `turnLifecycle`, `BrowserSessionRepository.lifecycleDiagnostics`, `Transport.sendRequest`, `obuRepl.requestMeta`, `browser_command`, `tabs_finalized`, and `turn_ended`.
