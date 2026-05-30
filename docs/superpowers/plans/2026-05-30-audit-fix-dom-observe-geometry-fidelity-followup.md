# Plan 5 §1.4 Fidelity Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DOM-observe `meta` honesty (audit §1.4) actually hold end-to-end — surface `meta` through the SDK, flag dropped OOPIF frames, and fix the `text_truncated` byte/char false-negative — plus two test-rigor fixes, on the existing `fix/audit-dom-observe-geometry` branch.

**Architecture:** Six confirmed code-review findings (A SDK meta-strip, B OOPIF frame vanish, C `text_truncated` byte/char, E hint wording, G tautological test, H payload-lock) fixed as small, independent TDD tasks. Findings D (OOPIF viewport false-positive), F (unbounded `join_all` cap), I (revision-hash), J (RTT nit) are explicitly **deferred** to separate follow-ups. The emitted `nodes` list stays byte-identical except `text_truncated`, which C intentionally corrects.

**Tech Stack:** Rust (`crates/obu-host` — async-trait, serde_json, tokio tests; `crates/obu-node-repl` — insta snapshot), TypeScript (`packages/sdk` — vitest).

**Branch / worktree:** Implement on `fix/audit-dom-observe-geometry`, checked out at the worktree `/Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry`. **All edits, test runs, and commits happen in that worktree**, not the main checkout. Commits are unsigned (`--no-gpg-sign`); the user re-signs the whole branch later once 1Password is unlocked (the branch's existing 6 commits are already unsigned). Do **not** push.

**Commit conventions (this repo):** `fix(...)`, `perf(...)`, `feat(...)` prefixes; cite the review finding. **No generated-author trailers or generator footers** (public-repo directive).

---

## Execution Status

**Status (2026-05-30):** Implemented on `fix/audit-dom-observe-geometry` in six additional unsigned implementation commits after the original Plan 5 head `fe3f541`:

| Finding(s) | Commit | Result |
|---|---|---|
| C | `c0b4866` | `text_truncated` now reports byte-budget clipping, including multi-node and multibyte text cases. |
| B, E | `3088d11` | `meta.degraded` is emitted for unreadable OOPIF frames; `truncated` includes `degraded`; hint wording no longer claims every omission is off-screen/zero-area. |
| G | `3215079` | Tautological wrapper-equality predicate test replaced with behavioral predicate and snapshot-shape assertions. |
| H | `b607934` | Full visible-DOM payload golden test added, including bounds shape and OOPIF `session_id`. |
| A | `b9b5803` | SDK types `DomCuaMeta`, includes `text_truncated`, preserves JSON `meta`, and appends a text-path truncation marker. |
| A | `6bf09e0` | js tool description updated and insta snapshot regenerated. |

**Verification run on current branch after implementation:**

- `cargo test -p obu-host --lib ops::dom_cua` passed: 35 tests.
- `cargo test -p obu-host --lib ops::dom_cua_runtime` passed: 12 tests.
- `cargo test -p obu-node-repl` passed.
- `cargo fmt --check` passed.
- `cd packages/sdk && pnpm tsc --noEmit` passed after building the workspace dependency `@open-browser-use/browser-control-core`.
- `cd packages/sdk && pnpm vitest run` passed: 208 tests.

**Known verification gap:** `cargo clippy -p obu-host --all-targets -- -D warnings` fails on pre-existing warnings outside this follow-up diff (`crates/obu-host/src/backends/cdp/oopif.rs`, `crates/obu-host/src/backends/webext/mod.rs`, `crates/obu-host/src/dispatcher.rs`, `crates/obu-host/src/native_messaging.rs`, `crates/obu-host/src/ops/cua.rs`, `crates/obu-host/src/task_store.rs`, `crates/obu-host/src/registry_lifecycle.rs`). No clippy failure was reported in the files modified by this follow-up.

**Scope check:** follow-up implementation touched `crates/obu-host/src/ops/dom_cua.rs`, `crates/obu-host/src/ops/dom_cua_runtime.rs`, `packages/sdk/src/tab-dom-cua.ts`, `packages/sdk/tests/wire-shape.test.ts`, `crates/obu-node-repl/resources/js_tool_description.md`, and `crates/obu-node-repl/tests/snapshots/description_snapshot__js_tool_description.snap`. `crates/obu-host/src/policy.rs` and `crates/obu-host/src/methods.rs` were unchanged. Branch remains unpushed and commits remain unsigned pending user re-signing.

---

## File Structure

| File | Responsibility | Findings |
|------|----------------|----------|
| `crates/obu-host/src/ops/dom_cua.rs` | `append_text` clip-flag threading; predicate behavioral tests | C, G |
| `crates/obu-host/src/ops/dom_cua_runtime.rs` | `visible_dom` `degraded`+hint; meta + payload golden tests | B, E, H |
| `packages/sdk/src/tab-dom-cua.ts` | `DomCuaMeta`/`DomCuaSnapshot`/`DomCuaNode` types; text-path marker | A |
| `packages/sdk/tests/wire-shape.test.ts` | SDK meta-surfacing + marker test | A |
| `crates/obu-node-repl/resources/js_tool_description.md` (+ `.snap`) | agent-facing doc + regenerated insta snapshot | A |

**Task order & dependencies:** Task 1 (C) → Task 2 (B+E) → Task 3 (G) → Task 4 (H, depends on C's `text_truncated` values) → Task 5 (A-SDK, conceptually after B so the type includes `degraded`) → Task 6 (A-doc, after B) → Task 7 (full verification + re-review handoff).

**Verified grounding (do not re-discover):**
- `append_text`'s only caller is `aggregate_text_with_flag` (+ self-recursion) — threading a flag is fully contained.
- `is_interesting_node` / `snapshot_entry` / `aggregate_text` are test-only wrappers (`#[cfg_attr(not(test), allow(dead_code))]`); `is_hidden_subtree` is production (`point.rs:285`, `append_text`).
- The host **already** inserts `meta` into the wire response for **all** formats (`dom_cua_runtime.rs:210-224`); the SDK drops it on the text path (`tab-dom-cua.ts:71 return response.text ?? ""`).
- `futures-util` is a real workspace dep (compiles).
- OOPIF test-backend pattern exists at `dom_cua_runtime.rs:1376-1465` (`FakeDomCuaRouting`).

---

### Task 1: Fix C — `text_truncated` byte/char honesty (`dom_cua.rs`)

**Problem:** `append_text` stops on `out.len() >= max_len` (a **byte** budget) but `aggregate_text_with_flag` infers truncation from `normalized.chars().count() > max_len` (a **char** count). Multi-byte text (or content split across multiple `#text` nodes) hits the byte cap before the char count exceeds `max_len`, so `text_truncated` reports `false` while content was dropped.

**Files:**
- Modify: `crates/obu-host/src/ops/dom_cua.rs:620-633` (`aggregate_text_with_flag`, `aggregate_text`)
- Modify: `crates/obu-host/src/ops/dom_cua.rs:673-701` (`append_text`)
- Test: `crates/obu-host/src/ops/dom_cua.rs` (in-module `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `dom_cua.rs`:

```rust
#[test]
fn text_truncated_flags_multinode_byte_budget_clip() {
    // Two content #text children. The first fills the 240-byte budget; the
    // second is skipped by the byte-budget guard. Pre-clip CHAR count (~240) is
    // NOT > 240, so the old `chars().count() > max_len` heuristic returned false
    // even though real content (the second node) was dropped.
    let node = json!({
        "nodeName": "DIV",
        "children": [
            { "nodeName": "#text", "nodeValue": "a".repeat(240) },
            { "nodeName": "#text", "nodeValue": "b".repeat(50) },
        ]
    });
    let (_text, truncated) = aggregate_text_with_flag(&node, 240);
    assert!(truncated, "dropping the second text node must flag truncation");
}

#[test]
fn text_truncated_flags_multibyte_byte_cap() {
    // 100 CJK chars across two nodes = 300 bytes; the 240-byte budget trips after
    // ~80 chars, dropping the rest. chars().count() (~80) is NOT > 240, so only
    // the byte-budget `clipped` signal can catch this.
    let node = json!({
        "nodeName": "DIV",
        "children": [
            { "nodeName": "#text", "nodeValue": "中".repeat(80) },
            { "nodeName": "#text", "nodeValue": "文".repeat(20) },
        ]
    });
    let (_text, truncated) = aggregate_text_with_flag(&node, 240);
    assert!(truncated, "multi-byte text past the byte cap must flag truncation");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p obu-host --lib ops::dom_cua::tests::text_truncated_flags`
Expected: FAIL — both assertions fail (`truncated` is `false` on current code).

- [ ] **Step 3: Thread a `clipped` flag through `append_text`**

Replace `append_text` (`dom_cua.rs:673-701`) with:

```rust
fn append_text(node: &Value, out: &mut String, max_len: usize, clipped: &mut bool) {
    // Hidden / non-content subtrees contribute no text in either behavior;
    // checking them BEFORE the budget guard means a budget-exhausted skip is only
    // recorded for a node that would actually have added content.
    if is_hidden_subtree(node) || is_non_content_tag(node) {
        return;
    }
    if out.len() >= max_len {
        // Budget already full but there is still a content node to visit -> the
        // aggregate is genuinely clipped. `append_text` is byte-budgeted, so this
        // fires earlier than `chars().count() > max_len` for multi-byte text.
        *clipped = true;
        return;
    }
    if node
        .get("nodeName")
        .and_then(Value::as_str)
        .is_some_and(|name| name == "#text")
        && let Some(value) = node.get("nodeValue").and_then(Value::as_str)
    {
        out.push(' ');
        out.push_str(value);
    }
    for key in ["children", "shadowRoots", "contentDocument"] {
        if let Some(children) = node.get(key).and_then(Value::as_array) {
            for child in children {
                append_text(child, out, max_len, clipped);
            }
        } else if let Some(child) = node.get(key) {
            append_text(child, out, max_len, clipped);
        }
    }
}
```

Note: the appended text is byte-identical to before (both versions return without appending when budget-full or hidden); only the `clipped` signal is added. It can over-report in the rare case where the budget is exactly full and the next node is an empty container — that is the safe direction (over-flagging truncation, never under).

- [ ] **Step 4: Update `aggregate_text_with_flag` to use both signals**

Replace `aggregate_text_with_flag` (`dom_cua.rs:620-626`) with:

```rust
pub(crate) fn aggregate_text_with_flag(node: &Value, max_len: usize) -> (String, bool) {
    let mut out = String::new();
    let mut clipped = false;
    append_text(node, &mut out, max_len, &mut clipped);
    let normalized = normalize_ws(&out);
    // `clipped` catches the byte-budget early-return (incl. multi-byte text that
    // hits the byte cap well before `max_len` chars); the char-count comparison
    // catches a single node that overshoots the budget in one `push_str`.
    let truncated = clipped || normalized.chars().count() > max_len;
    (normalized.chars().take(max_len).collect(), truncated)
}
```

`aggregate_text` (`dom_cua.rs:632-633`) is unchanged — it still calls `aggregate_text_with_flag(node, max_len).0`.

- [ ] **Step 5: Run the new and existing text tests**

Run: `cargo test -p obu-host --lib ops::dom_cua`
Expected: PASS — the two new tests pass; `aggregate_text_with_flag_reports_clipping` and `snapshot_entry_reports_text_truncation` still pass (single-node overshoot still flagged via the char-count arm).

- [ ] **Step 6: Commit**

```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry
git add crates/obu-host/src/ops/dom_cua.rs
git commit --no-gpg-sign -m "fix(obu-host): text_truncated flags byte-budget clips, not just char overshoot (review C)"
```

---

### Task 2: Fix B + E — OOPIF dropped-frame `degraded` flag + unified hint (`dom_cua_runtime.rs`)

**Problem (B):** When a whole OOPIF frame is dropped (`DOM.getDocument` errors → `continue`, or returns no `root`), that session's candidates never reach `total`, so `truncated = shown < total` stays `false` and the agent is told (via the js doc) the list is complete when a site-isolated frame is silently missing. **(E):** the existing hint over-claims the drop reason ("off-screen/zero-area or clipped") even for transport errors / unmeasurable nodes.

**Files:**
- Modify: `crates/obu-host/src/ops/dom_cua_runtime.rs:141-178` (accumulation loop) and `:197-224` (meta block)
- Test: `crates/obu-host/src/ops/dom_cua_runtime.rs` (in-module `mod hoist_tests`)

- [ ] **Step 1: Write the failing test**

Add to `mod hoist_tests` in `dom_cua_runtime.rs` (model on the existing `MetaBackend`; repeats the five required no-op trait methods):

```rust
// Top-level page is clean (one in-viewport <button>), but the single OOPIF
// session's DOM.getDocument fails -> the frame's nodes are absent. shown==total,
// yet the snapshot is incomplete, so `degraded` and `truncated` must be true.
struct OopifDropBackend;
#[async_trait]
impl DomCuaRuntimeBackend for OopifDropBackend {
    async fn execute_dom_cdp(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        method: &str,
        _p: Value,
    ) -> Result<Value> {
        match method {
            "Page.getLayoutMetrics" => Ok(json!({
                "cssVisualViewport": { "pageX": 0, "pageY": 0, "clientWidth": 100, "clientHeight": 100 }
            })),
            "DOM.getDocument" => Ok(json!({
                "root": {
                    "nodeName": "DIV", "backendNodeId": 1,
                    "children": [
                        { "nodeName": "BUTTON", "backendNodeId": 2, "attributes": ["aria-label", "ok"] }
                    ]
                }
            })),
            "DOM.getBoxModel" => Ok(json!({ "model": { "content": [0, 0, 10, 0, 10, 10, 0, 10] } })),
            _ => Ok(json!({})),
        }
    }
    async fn execute_dom_cdp_on_session(
        &self,
        _c: &BackendRequestContext,
        _s: &str,
        _m: &str,
        _p: Value,
    ) -> Result<Value> {
        Err(HostError::Protocol("oopif getDocument failed".into()))
    }
    async fn oopif_sessions_for_tab(&self, _t: &str) -> Vec<String> {
        vec!["OOPIF-X".into()]
    }
    async fn dispatch_coordinate_cua(
        &self,
        _c: &BackendRequestContext,
        _m: &str,
        _p: Value,
    ) -> Result<Value> {
        Ok(Value::Null)
    }
    async fn remember_visible_dom_nodes(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        _o: Option<&str>,
        _n: &[Value],
    ) {
    }
    async fn validate_visible_dom_node(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        _o: Option<&str>,
        _n: &str,
    ) -> Result<()> {
        Ok(())
    }
    async fn forget_visible_dom_snapshot(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        _o: Option<&str>,
    ) {
    }
}

#[tokio::test]
async fn visible_dom_meta_degraded_when_oopif_frame_dropped() {
    let backend = OopifDropBackend;
    let params = json!({ "tab_id": "tab", "observation_id": "obs" });
    let response = visible_dom(&backend, &ctx(), params).await.unwrap();
    // Top-level is clean: one in-viewport button (shown == total == 1)...
    assert_eq!(response["meta"]["shown"], json!(1));
    assert_eq!(response["meta"]["total"], json!(1));
    // ...but the one OOPIF frame failed to read, so the snapshot is degraded and
    // therefore truncated, even though shown == total.
    assert_eq!(response["meta"]["degraded"], json!(true));
    assert_eq!(response["meta"]["truncated"], json!(true));
    assert!(
        response["meta"]["hint"].as_str().unwrap().contains("child frame")
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p obu-host --lib ops::dom_cua_runtime::hoist_tests::visible_dom_meta_degraded_when_oopif_frame_dropped`
Expected: FAIL — `response["meta"]["degraded"]` is `Null` (key absent) and `truncated` is `false`.

- [ ] **Step 3: Add the `degraded` accumulator and set it on both drop paths**

In `visible_dom`, after `let mut total: usize = 0;` (`dom_cua_runtime.rs:142`) insert:

```rust
    // `degraded` records that a child-frame subtree could NOT be read (CDP error
    // or a document with no root). Such a frame contributes 0 to `total`, so it
    // can never appear as `shown < total`; without this flag a whole missing
    // OOPIF frame would leave `truncated=false` and silently hide the gap.
    let mut degraded = false;
```

In the OOPIF loop (`dom_cua_runtime.rs:151-178`), add `degraded = true;` to the error arm and an `else` to the missing-root arm:

```rust
    for session_id in backend.oopif_sessions_for_tab(tab_id).await {
        let Ok(document) = backend
            .execute_dom_cdp_on_session(
                ctx,
                &session_id,
                "DOM.getDocument",
                json!({ "depth": -1, "pierce": true }),
            )
            .await
        else {
            degraded = true;
            tracing::debug!(session_id = %session_id, "OOPIF DOM.getDocument failed; its nodes are absent from this snapshot");
            continue;
        };
        if let Some(root) = document.get("root") {
            total += collect_visible_dom_nodes(
                backend,
                ctx,
                tab_id,
                Some(&session_id),
                root,
                viewport,
                &mut nodes,
            )
            .await?;
        } else {
            degraded = true;
            tracing::debug!(session_id = %session_id, "OOPIF DOM.getDocument returned no root; its nodes are absent from this snapshot");
        }
    }
```

- [ ] **Step 4: Fold `degraded` into `truncated`, add the meta key, and broaden the hint (Fix E)**

Replace the meta block (`dom_cua_runtime.rs:203-224`) with:

```rust
    let shown = nodes.len();
    let text_clipped = nodes.iter().any(|node| {
        node.get("text_truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let truncated = shown < total || text_clipped || degraded;
    if let Some(object) = response.as_object_mut() {
        let mut meta = serde_json::Map::new();
        meta.insert("shown".into(), json!(shown));
        meta.insert("total".into(), json!(total));
        meta.insert("truncated".into(), json!(truncated));
        meta.insert("degraded".into(), json!(degraded));
        if truncated {
            meta.insert(
                "hint".into(),
                json!(
                    "Some interesting elements may be off-screen, zero-area, unmeasurable, in a child frame that could not be read, or have labels clipped at 240 chars. Scroll the page, or read full-fidelity content with tab.evaluate(...) or tab.domSnapshot()."
                ),
            );
        }
        object.insert("meta".into(), Value::Object(meta));
    }
```

- [ ] **Step 5: Update the existing meta tests to assert `degraded`**

In `mod hoist_tests`, add a `degraded` assertion to each existing meta test:
- In `visible_dom_meta_counts_candidates_shown_and_total`, after the `truncated` assert add: `assert_eq!(response["meta"]["degraded"], json!(false));`
- In `visible_dom_meta_truncated_via_text_clip_when_nothing_dropped`, add: `assert_eq!(response["meta"]["degraded"], json!(false));`
- In `visible_dom_meta_clean_when_nothing_dropped_or_clipped`, add: `assert_eq!(response["meta"]["degraded"], json!(false));`

- [ ] **Step 6: Run the runtime tests**

Run: `cargo test -p obu-host --lib ops::dom_cua_runtime`
Expected: PASS — the new degraded test and all existing meta/hoist/hit_verify tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry
git add crates/obu-host/src/ops/dom_cua_runtime.rs
git commit --no-gpg-sign -m "fix(obu-host): flag dropped OOPIF frames via meta.degraded + truncated; broaden hint (review B, E)"
```

---

### Task 3: Fix G — replace the tautological predicate test (`dom_cua.rs`)

**Problem:** `with_variants_match_their_node_computing_wrappers` (`dom_cua.rs:1147-1177`) asserts `is_*_with(node_tag(n), attributes_object(n)) == is_*(n)`. Since each wrapper is **defined** as exactly `is_*_with(node_tag(n), attributes_object(n))`, the assertion is true by construction regardless of predicate logic — it pins nothing.

**Files:**
- Modify: `crates/obu-host/src/ops/dom_cua.rs` (delete the tautological test, add a behavioral one in `mod tests`)

- [ ] **Step 1: Delete the tautological test**

Remove `with_variants_match_their_node_computing_wrappers` entirely (`dom_cua.rs:1147-1177`, the `#[test] fn with_variants_match_their_node_computing_wrappers() { ... }` block). End-to-end agreement of the `_with` path is locked by Task 4's golden test instead.

- [ ] **Step 2: Add a behavioral predicate test that can actually fail**

Add to `mod tests`:

```rust
#[test]
fn predicates_classify_nodes_by_behavior() {
    // is_interesting_node: interactive tags and labelled/role/onclick nodes are
    // interesting; a plain container is not.
    assert!(is_interesting_node(&json!({ "nodeName": "BUTTON", "backendNodeId": 2 })));
    assert!(is_interesting_node(&json!({ "nodeName": "INPUT", "backendNodeId": 3 })));
    assert!(is_interesting_node(&json!({ "nodeName": "SPAN", "attributes": ["role", "button"] })));
    assert!(is_interesting_node(&json!({ "nodeName": "DIV", "attributes": ["aria-label", "Menu"] })));
    assert!(!is_interesting_node(&json!({ "nodeName": "DIV", "backendNodeId": 4 })));
    assert!(!is_interesting_node(&json!({ "nodeName": "SPAN" })));

    // is_hidden_subtree: hidden attr / aria-hidden="true" / input[type=hidden] /
    // display:none hide; a bare visible element does not.
    assert!(is_hidden_subtree(&json!({ "nodeName": "DIV", "attributes": ["hidden", ""] })));
    assert!(is_hidden_subtree(&json!({ "nodeName": "DIV", "attributes": ["aria-hidden", "true"] })));
    assert!(is_hidden_subtree(&json!({ "nodeName": "INPUT", "attributes": ["type", "hidden"] })));
    assert!(is_hidden_subtree(
        &json!({ "nodeName": "DIV", "attributes": ["style", "display: none"] })
    ));
    assert!(!is_hidden_subtree(&json!({ "nodeName": "DIV", "backendNodeId": 1 })));

    // snapshot_entry emits the documented field shape, and name falls back to
    // text when there is no aria-label/alt/title.
    let rect = Rect { x: 0.0, y: 0.0, width: 5.0, height: 5.0 };
    let entry = snapshot_entry(
        &json!({
            "nodeName": "BUTTON", "backendNodeId": 7,
            "children": [{ "nodeName": "#text", "nodeValue": "Buy" }]
        }),
        7,
        rect,
    )
    .expect("interesting node yields an entry");
    assert_eq!(entry["node_id"], json!("7"));
    assert_eq!(entry["tag"], json!("button"));
    assert_eq!(entry["name"], json!("Buy"));
    assert_eq!(entry["text"], json!("Buy"));
    assert_eq!(entry["text_truncated"], json!(false));
}
```

- [ ] **Step 3: Run the test**

Run: `cargo test -p obu-host --lib ops::dom_cua::tests::predicates_classify_nodes_by_behavior`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry
git add crates/obu-host/src/ops/dom_cua.rs
git commit --no-gpg-sign -m "test(obu-host): replace tautological predicate test with behavioral assertions (review G)"
```

---

### Task 4: Fix H — payload-lock golden test incl. OOPIF `session_id` (`dom_cua_runtime.rs`)

**Problem:** No test locks the **full** emitted `nodes` payload (`bounds` mapping, OOPIF `session_id` tagging, field shape). The order test only checks `node_id` order, so the output-identity guardrail is under-enforced.

**Files:**
- Test: `crates/obu-host/src/ops/dom_cua_runtime.rs` (in-module `mod hoist_tests`)

- [ ] **Step 1: Write the golden test (and its backend)**

Add to `mod hoist_tests`:

```rust
// One top-level <button> (id 2) and one OOPIF-session <button> (id 5), both
// in-viewport. Locks the EXACT emitted node shape: field set, bounds mapping
// from the box-model content quad, and the OOPIF `session_id` tag.
struct PayloadBackend;
#[async_trait]
impl DomCuaRuntimeBackend for PayloadBackend {
    async fn execute_dom_cdp(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        method: &str,
        _p: Value,
    ) -> Result<Value> {
        match method {
            "Page.getLayoutMetrics" => Ok(json!({
                "cssVisualViewport": { "pageX": 0, "pageY": 0, "clientWidth": 100, "clientHeight": 100 }
            })),
            "DOM.getDocument" => Ok(json!({
                "root": {
                    "nodeName": "DIV", "backendNodeId": 1,
                    "children": [
                        { "nodeName": "BUTTON", "backendNodeId": 2, "attributes": ["aria-label", "Top"] }
                    ]
                }
            })),
            "DOM.getBoxModel" => Ok(json!({ "model": { "content": [0, 0, 10, 0, 10, 10, 0, 10] } })),
            _ => Ok(json!({})),
        }
    }
    async fn execute_dom_cdp_on_session(
        &self,
        _c: &BackendRequestContext,
        _s: &str,
        method: &str,
        _p: Value,
    ) -> Result<Value> {
        match method {
            "DOM.getDocument" => Ok(json!({
                "root": {
                    "nodeName": "DIV", "backendNodeId": 4,
                    "children": [
                        { "nodeName": "BUTTON", "backendNodeId": 5, "attributes": ["aria-label", "Frame"] }
                    ]
                }
            })),
            "DOM.getBoxModel" => Ok(json!({ "model": { "content": [0, 0, 20, 0, 20, 20, 0, 20] } })),
            _ => Ok(json!({})),
        }
    }
    async fn oopif_sessions_for_tab(&self, _t: &str) -> Vec<String> {
        vec!["F1".into()]
    }
    async fn dispatch_coordinate_cua(
        &self,
        _c: &BackendRequestContext,
        _m: &str,
        _p: Value,
    ) -> Result<Value> {
        Ok(Value::Null)
    }
    async fn remember_visible_dom_nodes(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        _o: Option<&str>,
        _n: &[Value],
    ) {
    }
    async fn validate_visible_dom_node(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        _o: Option<&str>,
        _n: &str,
    ) -> Result<()> {
        Ok(())
    }
    async fn forget_visible_dom_snapshot(
        &self,
        _c: &BackendRequestContext,
        _t: &str,
        _o: Option<&str>,
    ) {
    }
}

#[tokio::test]
async fn visible_dom_payload_locks_full_node_shape_incl_oopif_session() {
    let backend = PayloadBackend;
    let params = json!({ "tab_id": "tab" });
    let response = visible_dom(&backend, &ctx(), params).await.unwrap();
    // Exact emitted payload: top-level node has NO session_id; the OOPIF node is
    // tagged with its owning session. bounds map from the box-model content quad.
    assert_eq!(
        response["nodes"],
        json!([
            {
                "node_id": "2", "tag": "button", "role": "", "name": "Top",
                "text": "", "text_truncated": false,
                "bounds": { "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0 },
                "attributes": { "aria-label": "Top" }
            },
            {
                "node_id": "5", "tag": "button", "role": "", "name": "Frame",
                "text": "", "text_truncated": false,
                "bounds": { "x": 0.0, "y": 0.0, "width": 20.0, "height": 20.0 },
                "attributes": { "aria-label": "Frame" },
                "session_id": "F1"
            }
        ])
    );
}
```

- [ ] **Step 2: Run the test**

Run: `cargo test -p obu-host --lib ops::dom_cua_runtime::hoist_tests::visible_dom_payload_locks_full_node_shape_incl_oopif_session`
Expected: PASS. (If it fails on a `bounds` numeric form, confirm `rect_from_box_model` yields `f64` `0.0/10.0/20.0` — `json!` integer-vs-float must match the emitted `Number`; the values above are floats to match `Rect`'s `f64` fields.)

- [ ] **Step 3: Commit**

```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry
git add crates/obu-host/src/ops/dom_cua_runtime.rs
git commit --no-gpg-sign -m "test(obu-host): lock full visible-DOM node payload incl. OOPIF session_id (review H)"
```

---

### Task 5: Fix A (SDK) — surface `meta` type + text-path truncation marker (`tab-dom-cua.ts`)

**Problem:** `tab.dom_cua.text()` and `format:"text"|"debug_text"|"compact_text"` return a bare `string` (`tab-dom-cua.ts:71`), dropping `meta`; and `DomCuaSnapshot` has no `meta` field, so it is untyped even on the json path. The js doc instructs the agent to branch on `meta.truncated` via `text()` — unreachable.

**Files:**
- Modify: `packages/sdk/src/tab-dom-cua.ts:7-21` (types), `:51-73` (`get_visible_dom`), `:138-140` (add helper)
- Test: `packages/sdk/tests/wire-shape.test.ts` (new `it(...)` in the `SDK wire-shape contracts` describe)

- [ ] **Step 1: Write the failing test**

Add this `it(...)` inside the `describe("SDK wire-shape contracts", ...)` block in `wire-shape.test.ts`:

```ts
  it("dom_cua surfaces meta on the json path and appends a truncation marker on the text path", async () => {
    const restoreMeta = setRequestMeta();
    const transport = new FakeTransport();
    const tab = new Tab(asTransport(transport), new Guards(), "tab-a");
    try {
      transport.responses.set(M.DOM_CUA_GET_VISIBLE_DOM, {
        nodes: [{ node_id: "1", text: "Save", text_truncated: false }],
        text: "[1] <button> Save",
        meta: {
          shown: 1,
          total: 3,
          truncated: true,
          degraded: false,
          hint: "Some interesting elements may be off-screen...",
        },
      });
      // json/default path: meta flows through (typed).
      const json = await tab.dom_cua.get_visible_dom();
      expect(json).toMatchObject({
        nodes: [{ node_id: "1", text_truncated: false }],
        meta: { shown: 1, total: 3, truncated: true, degraded: false },
      });
      // text path: the rendered text PLUS a one-line truncation marker.
      const text = await tab.dom_cua.text();
      expect(text.startsWith("[1] <button> Save")).toBe(true);
      expect(text).toContain("1 of 3 shown");

      // Not truncated -> bare string, no marker.
      transport.responses.set(M.DOM_CUA_GET_VISIBLE_DOM, {
        text: "[1] <button> Save",
        meta: { shown: 1, total: 1, truncated: false, degraded: false },
      });
      await expect(tab.dom_cua.text()).resolves.toBe("[1] <button> Save");
    } finally {
      restoreMeta();
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/sdk && npx vitest run tests/wire-shape.test.ts -t "surfaces meta"`
Expected: FAIL — `text` is `"[1] <button> Save"` with no marker, so `toContain("1 of 3 shown")` fails.

- [ ] **Step 3: Add the `DomCuaMeta` type and extend `DomCuaNode`/`DomCuaSnapshot`**

Replace `tab-dom-cua.ts:7-21` with:

```ts
export type DomCuaNode = {
  node_id: string;
  role?: string;
  name?: string;
  text?: string;
  text_truncated?: boolean;
  tag?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: DomCuaNode[];
};

/** Self-describing accounting for a visible-DOM read (mirrors the host `meta`). */
export type DomCuaMeta = {
  /** Entries actually emitted in `nodes`. */
  shown: number;
  /** Interesting, non-hidden candidates considered across the top-level + OOPIF frames. */
  total: number;
  /** True iff some candidate was dropped, a label was clipped, or a frame was unreadable. */
  truncated: boolean;
  /** True iff a child (OOPIF) frame could not be read, so the list is incomplete. */
  degraded: boolean;
  /** Present iff `truncated`: how to read the full / scoped DOM. */
  hint?: string;
};

export type DomCuaSnapshot = {
  nodes?: DomCuaNode[];
  root?: DomCuaNode;
  text?: string;
  meta?: DomCuaMeta;
};
```

- [ ] **Step 4: Append the marker on the text path and add the helper**

In `get_visible_dom`, replace the return line (`tab-dom-cua.ts:71`):

```ts
    if (opts.format === "text" || opts.format === "debug_text" || opts.format === "compact_text") {
      return appendDomCuaTruncationMarker(response.text ?? "", response.meta);
    }
    return response;
```

Add this helper next to `observationWireParam` (bottom of the file):

```ts
/** Append a one-line truncation marker so the text-format read self-describes —
 *  the structured `meta` is dropped on the text path. No marker when honest. */
function appendDomCuaTruncationMarker(text: string, meta?: DomCuaMeta): string {
  if (!meta?.truncated) return text;
  const marker = `[dom_cua: ${meta.shown} of ${meta.total} shown — some elements off-screen, clipped, or in unread child frames; scroll, or use tab.domSnapshot()/tab.evaluate() for full fidelity]`;
  return text.length > 0 ? `${text}\n${marker}` : marker;
}
```

- [ ] **Step 5: Run the new test and the full SDK suite**

Run: `cd packages/sdk && npx vitest run tests/wire-shape.test.ts`
Expected: PASS — the new test passes; existing dom_cua wire-shape tests (the `[1] <button> Save` cases, which use responses without `meta`, so `truncated` is undefined → no marker) still pass unchanged.

- [ ] **Step 6: Commit**

```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry
git add packages/sdk/src/tab-dom-cua.ts packages/sdk/tests/wire-shape.test.ts
git commit --no-gpg-sign -m "fix(sdk): surface dom_cua meta type + text-path truncation marker (review A)"
```

---

### Task 6: Fix A (doc) — update js tool description + regenerate snapshot (`obu-node-repl`)

**Problem:** The js tool description still tells the agent only about `meta.{shown,total,truncated}` and frames `text()` as the read path. It must mention `degraded` and that the default/json path carries `meta` while `text()` appends a marker.

**Files:**
- Modify: `crates/obu-node-repl/resources/js_tool_description.md` (the DOM-CUA bullet, ~lines 123-129)
- Regenerate: `crates/obu-node-repl/tests/snapshots/description_snapshot__js_tool_description.snap`

- [ ] **Step 1: Edit the description**

In `js_tool_description.md`, replace the three added lines from the §1.4 work:

```
   read the node list while keeping ids valid. The visible-DOM read self-describes via
   `meta.{shown,total,truncated}` (plus per-entry `text_truncated` for labels clipped at
   240 chars) — branch on `meta.truncated` to fall back to `domSnapshot()`/`evaluate()`
   rather than trusting the node list as complete.
```

with:

```
   read the node list while keeping ids valid. The default (json) read self-describes via
   `meta.{shown,total,truncated,degraded}` (plus per-entry `text_truncated` for labels
   clipped at 240 chars); `text()` appends a one-line truncation marker. Branch on
   `meta.truncated` / `meta.degraded` to fall back to `domSnapshot()`/`evaluate()` rather
   than trusting the node list as complete.
```

- [ ] **Step 2: Regenerate the insta snapshot**

The description is insta-snapshot-pinned. `cargo-insta` is not installed in this repo, so use the env var:

Run: `cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry && INSTA_UPDATE=always cargo test -p obu-node-repl --test description_snapshot`
Expected: PASS — the test rewrites `description_snapshot__js_tool_description.snap` to match the new doc.

- [ ] **Step 3: Verify the snapshot updated and the test is green without the env var**

Run: `cargo test -p obu-node-repl --test description_snapshot`
Expected: PASS (no pending snapshot). Confirm `git status` shows both the `.md` and the `.snap` modified.

- [ ] **Step 4: Commit**

```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry
git add crates/obu-node-repl/resources/js_tool_description.md crates/obu-node-repl/tests/snapshots/description_snapshot__js_tool_description.snap
git commit --no-gpg-sign -m "docs(prompt): document dom_cua meta.degraded + text() truncation marker; regen snapshot (review A)"
```

---

### Task 7: Full verification + re-review handoff

**Files:** none (verification only).

- [ ] **Step 1: Host crate — tests, format, clippy**

Run:
```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry
cargo test -p obu-host --lib ops::dom_cua ops::dom_cua_runtime
cargo test -p obu-node-repl
cargo fmt --check
cargo clippy -p obu-host --all-targets -- -D warnings
```
Expected: all PASS; `fmt --check` clean; clippy 0 warnings (no new `dead_code` — Task 3 removed a test, did not orphan a wrapper).

- [ ] **Step 2: SDK — type check + full vitest**

Run:
```bash
cd /Users/labrinyang/projects/open-browser-use-public-worktrees/dom-observe-geometry/packages/sdk
npx tsc --noEmit
npx vitest run
```
Expected: `tsc` clean (the new `DomCuaMeta` type and `text_truncated` resolve); full SDK suite green.

- [ ] **Step 3: Confirm scope guardrails held**

- `git diff main..fix/audit-dom-observe-geometry -- crates/obu-host/src/ops/dom_cua_runtime.rs` shows **no** change to `collect_visible_dom_nodes`' pass-1/2/3 emission logic (only the `degraded`/meta block changed) — the node list stays byte-identical except `text_truncated` (Fix C, intended).
- `policy.rs` and `methods.rs` are untouched: `git diff --name-only main..fix/audit-dom-observe-geometry | grep -E "policy.rs|methods.rs"` returns nothing.
- Confirm the deferred findings (D, F, I, J) are NOT in the diff.

- [ ] **Step 4: Re-review handoff**

Hand the branch to an independent review pass over **these six commits only** (e.g. the same multi-lens review used before, or `/code-review high` on `git diff <pre-followup>..HEAD`). Focus: the `clipped` over-report edge (Task 1), `degraded` honesty across mixed top-level+OOPIF cases (Task 2), and the SDK marker wording/format-path coverage (Task 5). Report confirmed findings before the user re-signs.

- [ ] **Step 5: Report to the user (do not push, do not sign)**

Summarize: 6 commits added (unsigned), full host + SDK suites green, scope guardrails verified, deferred findings listed. Remind the user the whole branch (now 12 commits) still needs re-signing once 1Password is unlocked, then push is their call.

---

## Self-Review

**Spec coverage:**
- A (SDK meta-strip) → Tasks 5 (type + marker) + 6 (doc). ✓
- B (OOPIF frame vanish) → Task 2 (`degraded` → `truncated`). ✓
- C (`text_truncated` byte/char) → Task 1. ✓
- E (hint wording) → Task 2 Step 4 (unified hint). ✓
- G (tautological test) → Task 3. ✓
- H (payload-lock) → Task 4. ✓
- Deferred D/F/I/J → called out in header + Task 7 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step has an expected result. ✓

**Type/name consistency:** `DomCuaMeta` fields (`shown/total/truncated/degraded/hint`) match the host `meta` keys inserted in Task 2 Step 4. `appendDomCuaTruncationMarker` defined and called in Task 5. `aggregate_text_with_flag` signature unchanged (only body); `append_text` gains `clipped: &mut bool` and all call sites (the single caller + 2 recursive) updated in Task 1. Test names referenced in run commands match the test fn names. ✓

**Known sensitivity:** Task 4's `bounds` assertion depends on `rect_from_box_model` emitting `f64`; the expected JSON uses floats (`0.0/10.0/20.0`) to match. Flagged inline in Task 4 Step 2.
