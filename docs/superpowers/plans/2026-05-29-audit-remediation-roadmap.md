# open-browser-use Audit Remediation — Roadmap (Plan-of-Plans)

> **For agentic workers:** This is the **index/sequencing** document for remediating the 30 confirmed findings in `artifacts/audit/REPORT.md`. It is NOT itself a task-by-task plan. Each numbered Plan below is (or will be) its own document under `docs/superpowers/plans/` with bite-sized TDD steps. Implement one Plan at a time via superpowers:subagent-driven-development or superpowers:executing-plans. **Read "Global Execution Guardrails" before touching any code — it encodes the verifier-confirmed "do NOT" traps that make several of these fixes regressions if done naively.**

**Goal:** Turn the audit's 30 independently-confirmed findings into shipped, test-backed product-code fixes, sequenced by the report's reconciled priority and by safety.

**Architecture:** The audit already grouped findings into **Cross-Lens Themes (§5, A–J)** — each Theme is a single fix-family that resolves several findings at once and maps cleanly to one independently-shippable, independently-testable Plan. We follow that decomposition rather than slicing per-subsystem, because the Themes are where the verification panels concentrated their "ship-this-first / do-NOT-do-X" guidance.

**Tech Stack:** Rust (`crates/obu-host`, `obu-node-repl`, `obu-wire`; `cargo test -p <crate> --lib --tests`), TypeScript monorepo (`packages/*`, pnpm 10 workspaces, `vitest run` per package), WebExtension MV3 (`packages/extension`, **a bespoke Node-based test runner** — `pnpm --filter @open-browser-use/extension test` runs `scripts/test-extension.mjs`, which orchestrates ~27 `.mjs` test modules; there is **no vitest**, so Plan 3 extends this Node suite rather than standing up new infra).

---

## Source of truth

- **Findings + evidence + severities:** `artifacts/audit/REPORT.md` (FINAL, confirmed-only). Section numbers below (`§4.1` etc.) refer to that file.
- **Navigation:** `artifacts/audit/INDEX.md`.
- The report's file:line citations were spot-checked against current source and are *mostly* accurate (`redact.ts`, `transport.rs:83`, `keyboard.rs:270/184`, `main.rs:68`), but a 2026-05-29 code-grounded re-analysis found several drifts (§4.3 is a **two**-site leak, §2.1 a **two**-site TTL fix, Plan 3's controller path is wrong, the §3.10 tables aren't in `dispatcher.rs`). **See "Consolidation & collision resolution → Citation corrections" below before relying on a cited line.**
- **Product north-star** the fidelity fixes must serve: `[[canonical-product-goal]]` — *max agent freedom; the lifecycle/state-machine must reinforce the Browser Environment, never burden the agent; enhancements must not diverge from reality and degrade general-case performance.* The fidelity findings (Themes B/D/I, §1.x) are openness/honesty fixes that **advance** this goal, but they change agent-facing surface and are therefore design-sensitive (flagged per-Theme).

---

## Global Execution Guardrails (read first)

### Verifier-confirmed traps — these turn a "fix" into a regression
Each was surfaced by an adversarial reviewer in the report. **Do not skip.**

| Theme / Finding | DO | DO **NOT** |
|---|---|---|
| **B** §3.1 box-model RTT | Ship only the **safe tier**: hoist `is_interesting_node`/`is_hidden_subtree` above the `box_model_rect` await (2a), then optional `join_all` batch (2b). | Do **not** ship the `DOMSnapshot.captureSnapshot` rewrite (tier 1) blind — it returns **document-relative** bounds, a different basis than the frame-local `getBoxModel` quads the validated OOPIF composition (branch 4c) depends on. Re-validate against `tests/oopif_e2e.rs` before any tier-1 work. |
| **B** §3.3 attributes recompute | Compute `attributes_object`+`node_tag` once per node, thread `&Map`/`&str`. Also update callers in `point.rs`/`append_text`. | Do **not** "reuse the map in `render_visible_dom_text`" — that path filters to string-valued attrs only; reuse changes output. |
| **B** §3.5 per-click viewport RTT | Cache viewport **with scroll-aware invalidation** (recompute when a scroll occurred / element wasn't fully in view). | Do **not** carry the observe's viewport forward keyed by `observation_id` — the `Rect` carries `pageX/pageY` scroll origin; `scrollIntoViewIfNeeded` runs *before* the read precisely because scroll moves the origin. Naive reuse lands clicks on the wrong pixel. |
| **C** §3.2 RpcMessage double-parse | Use `serde_json::RawValue` + a tiny `{id: Option<IgnoredAny>, method: Option<IgnoredAny>}` peek, then `from_slice` once. Benchmark before/after. | Do **not** use a "classify on the first `id`/`method` key seen" streaming visitor — JSON key order is unspecified and a Request carries **both** keys → misclassification. |
| **C** §3.7 base64 rewrap | Drop `to_value`; serialize the typed `KernelIn` struct straight to bytes. | Key order shifts to alphabetical — confirmed **benign** (kernel does order-independent `JSON.parse`; no test pins key order). Don't add `preserve_order` "to be safe". |
| **C** §3.9 sortRecord hash | Hash `JSON.stringify(value)` directly; apply to the **shared** `domCuaRevisionFromSnapshot` so both call sites stay lockstep. | Don't fix only one call site — the drift check (`:1625`) and the observe hash (`:484`) must match. |
| **A** §3.6/§4.6 lock maps | **Lifecycle-tied eviction** (drop entries on session/tab teardown via `ServiceRegistry`). Sharded `DashMap` is an optional safe drop-in. | Do **not** GC by `Arc::strong_count==1` — TOCTOU: a live holder can be mid-`entry().or_insert` while you evict, creating a fresh mutex for a key still guarded → silently breaks mutual exclusion. |
| **dispatch** §3.10 method tables | If optimizing, use `phf`/`once_cell` per table; bonus: hoist `guard_mode_disabled()`'s per-request `env::var` to a `OnceCell`. | Do **not** merge the three tables — `classify_method` defaults absent methods to the **strictest** `CurrentOrigin`; collapsing that is a **security regression**. |
| **G** §4.1 CDP reconnect | On reconnect, **re-arm `Target.setAutoAttach`** on known sessions and resolve `pending` with a *retryable* error. | Don't just retry the socket and leave sessions un-re-attached. |
| **D** §4.3/§1.3 display | Bound at **push time** (ring-buffer recent N, or count surplus *without* retaining image `Value`s). §1.3 (payload `{shown,total}`) and §4.3 (host-memory leak) are the **same edit moved from serialize-time to push-time**. | Don't "fix" §1.3 alone at serialize-time — that leaves the host-RSS leak (§4.3) live. |

### Product-design-sensitive findings (need a human design nod, not just code)
- **Theme I** §1.1 (`keypress` finite table) and §1.2 (dialog accept/answer): these **open the action space** — aligned with `[[canonical-product-goal]]`, but they add agent-facing verbs/behavior. Keep the safe default (dismiss/reject-unknown) **overridable**, not removed.
- **Theme B/D** §1.3–§1.6, §1.4: add honesty meta (`{shown,total}`, recovery hints). These change observation payload/return contracts.
- **`js` tool description is insta-snapshot-pinned** (`[[obu-js-tool-description-snapshot]]`): if any fix edits the agent-facing js playbook / `help.ts`, you **must** rerun `INSTA_UPDATE=always cargo test -p obu-node-repl --test description_snapshot` in the same change or the snapshot test goes red.

### Process
- **Human review gate:** the audit deliberately left product code unfixed for human review (`[[obu-deep-audit-2026-05-29]]`, `[[obu-audit-4lens-2026-05-29]]`). Every Plan's output is a PR for human review before merge — do not self-merge to `main`.
- **Branch per Plan** off `main` (`git switch -c fix/audit-<theme>-<slug>`). Do not commit remediation directly to `main`.
- **Commits:** Conventional style matching the repo (`fix(sdk): … (audit §4.4)`). **Omit generated-author trailers and generator footers** (public-repo directive).
- **Signing under the sandbox** (`[[signing-noninteractive-shells]]`): subagents (always sandboxed) commit `--no-gpg-sign`; the controller re-signs `HEAD~N` at the end with `dangerouslyDisableSandbox`. Push is user-initiated.
- **Public-docs hygiene:** no internal-only project labels or product-comparison shorthand in committed comments/docs.
- **Test commands:** TS → `pnpm --filter <pkg-name> test` (e.g. `@open-browser-use/sdk`, `@open-browser-use/browser-control-core`) or `cd packages/<pkg> && pnpm vitest run <file>`. Rust → `cargo test -p <crate> --lib --tests`. Whole-CI mirror: `cargo test -p obu-wire -p obu-node-repl -p obu-host --lib --tests --no-fail-fast`.

---

## Reconciled priority (from the report's Top Risks)

1. §4.1 CDP read-pump fatal teardown — **HIGH**, highest blast radius (Theme G)
2. §4.5 accept-loop fatal-on-transient — MEDIUM, blast: total (Theme G)
3. §4.2 overlay `hide()` lost-update race — **HIGH** (Theme F)
4. §4.3 display-frame unbounded host memory — **HIGH** (Theme D / vuln)
5. §4.4 card/CVC/PIN redaction gap — MEDIUM, one-line, leaks by default (Theme J)
6. §3.1+§1.4 DOM-observe geometry — **CRITICAL/HIGH**, highest leverage two-birds (Theme B)
7. §4.7 step()/observe() staleness disagreement — MEDIUM (Theme E)
8. §4.8 `parseFinalizeKeep` destructive default — MEDIUM (Theme F)
9. §2.1 resume-token TTL never enforced — MEDIUM (Theme H)

---

## Theme catalog → Plan mapping

> Severity is the report's **post-verification consensus**. "Risk" = implementation risk for the fix itself (see Guardrails).

### Theme G — Fatal-on-transient event loops *(vuln, HIGH)* → **Plan 1 (partial) + Plan 2**
| Finding | Sev | File | Fix |
|---|---|---|---|
| §4.5 accept loop dies on transient `accept()` err | MED | `crates/obu-host/src/main.rs:67-89` | classify err kind, continue/backoff on recoverable, fatal only on dead listener |
| §4.1 CDP read-pump tears down all sessions, no reconnect | HIGH | `crates/obu-host/src/backends/cdp/transport.rs:78-146` | classify fatal vs transient; reconnect-with-backoff; **re-arm `Target.setAutoAttach`**; resolve pending retryable |
§4.5 is mechanical/unit-testable → **Plan 1**. §4.1 is a reconnect state machine (needs a mock-WS harness) → its own **Plan 2**.

### Theme F — Destructive lifecycle/overlay invert errors into silent success / lost updates *(vuln, HIGH)* → **Plan 1 (partial) + Plan 3**
| Finding | Sev | File | Fix |
|---|---|---|---|
| §4.8 `parseFinalizeKeep` coerces malformed `keep`→`[]` → destructive default | MED | `packages/browser-control-core/src/finalize.ts:51-65` | distinguish absent (ok) vs present-but-non-array (throw) |
| §4.10 keep entries for unknown tabIds silently dropped | LOW | `finalize.ts:67-83` | return `unknownKeepTabIds`; surface as `not_attempted` in controller result |
| §4.2 `OverlayCoordinator.hide()` clobbers concurrently re-activated overlay | HIGH | `packages/extension/src/overlay_coordinator.ts:269-286` | re-read state **after** the await; never overwrite/delete an entry now `active` |
§4.8 + §4.10's pure `planFinalizeTabs` change are unit-testable now → **Plan 1**. §4.2 (extend the existing `test-overlay-coordinator.mjs` coverage) + §4.10's controller-result wiring → **Plan 3**.

### Theme J — Financial-secret redaction gap *(vuln × security, MEDIUM)* → **Plan 1**
| §4.4 redaction misses card/cvc/pin/account | MED | `packages/sdk/src/redact.ts:10-17` | extend `SECRET_FIELD_PATTERN` (one line) |

### Theme D — Observation/display silently degrades on truncation, in payload **and** host memory *(fidelity × vuln, MEDIUM)* → **Plan 4**
| Finding | Sev | File | Fix |
|---|---|---|---|
| §4.3 display frames accumulate unbounded in host RSS | HIGH | `crates/obu-node-repl/src/repl_manager/mod.rs:1015-1024` | bound at **push** time (cap/ring-buffer; count surplus w/o retaining image `Value`s) |
| §1.3 `display()` drops >50 in returned payload, true count discarded | MED | `crates/obu-node-repl/src/result_budget.rs:59-99` | surface `displays_total`/`displays_shown` in payload + summary |
| §1.5 `extractTable` skips truncation guard → `rows: undefined` | LOW | `packages/sdk/src/tab-read.ts:49-57` | branch on `kind==="truncated"`, throw/flag; fix `string[][]` type hole |
| §1.6 `evaluate()` truncation summary has no recovery hint | LOW | `packages/sdk/src/tab.ts:1143-1146` | add `hint` like `snapshotText`; document the sentinel |
§4.3 + §1.3 are the **same edit** at push-time vs serialize-time. §1.6 is shared with Theme E.

### Theme B — DOM-observe geometry: dominant latency lever AND dishonest finite projection *(perf × fidelity, CRITICAL)* → **Plan 5**
| Finding | Sev | File | Fix |
|---|---|---|---|
| §3.1 one `DOM.getBoxModel` RTT per node, before filters | CRIT↔HIGH | `crates/obu-host/src/ops/dom_cua_runtime.rs:369-413` | hoist predicates above the await (safe tier only) |
| §3.3 `attributes_object`/`node_tag` recomputed 4×/node | MED/LOW | `crates/obu-host/src/ops/dom_cua.rs:403-508` | compute once, thread refs |
| §3.5 per-click viewport re-fetch | MED | `dom_cua_runtime.rs:415-455` | scroll-aware viewport cache |
| §1.4 `get_visible_dom` finite projection, no honesty meta | LOW–MED | `dom_cua.rs:457-508` | emit `{shown,total}` + `textTruncated` + breadcrumb |
**Highest leverage:** the §3.1 perf fix and the §1.4 honesty fix are the same refactor. **Ship safe predicate-hoist + honesty-meta first; defer captureSnapshot rewrite.**

### Theme E — Incoherent staleness/degradation contracts across step/observe/evaluate *(vuln × fidelity, MEDIUM)* → **Plan 6**
| §4.7 `step()` dispatches against a stale runtime `observe()` calls "lost" | MED | `packages/sdk/src/tab.ts:1154-1237` | in `#preflightAction`, compare `#metadataEpoch` vs `#runtimeEpoch()` before the no-observationId fall-through; block with `ownership_lost` |
| §1.6 `evaluate()` truncation (shared w/ Theme D) | LOW | `tab.ts:1143-1146` | mirror `snapshotText` honesty |

### Theme H — Durable task-store has no lifecycle bounds *(security × vuln, MEDIUM)* → **Plan 7**
| Finding | Sev | File | Fix |
|---|---|---|---|
| §2.1 resume-token TTL never enforced at redemption | MED | `crates/obu-host/src/task_store.rs:1457-1500` | add `AND expires_at > ?now`; lazy sweep → `status='expired'` (also reclaims the one pending slot) |
| §2.2 no retention/prune/VACUUM | LOW–MED | `task_store.rs:578-746` | configurable retention DELETE (cascades via FKs); cap events/segments; `PRAGMA auto_vacuum=INCREMENTAL` |
| §4.9 unbounded task-store actor channel | LOW | `crates/obu-host/src/task_store_actor.rs:136-162` | bounded channel + `try_send`/drop-count on best-effort writes |

### Theme C — Large-payload IPC/serialization copies every observe byte multiple times *(perf, HIGH worst-case)* → **Plan 8**
| Finding | Sev | File | Fix |
|---|---|---|---|
| §3.4 `FrameDecoder.feed` O(n²) realloc per chunk | HIGH→MED | `packages/sdk/src/wire/frames.ts:16-37` | cursor offset + grow buffer, compact-after-drain |
| §3.2 `RpcMessage::deserialize` parses twice | HIGH→low/med | `crates/obu-wire/src/envelope.rs:159-179` | `RawValue` + `IgnoredAny` peek |
| §3.7 base64 rewrap struct→Value→bytes | MED | `crates/obu-node-repl/src/native_pipe/broker.rs:213-228` | serialize `KernelIn` directly |
| §3.8 64KiB zeroed buffer per read | MED | `crates/obu-node-repl/src/native_pipe/connection.rs:44-58` | `read_buf` into reused `BytesMut` |
| §3.9 `sortRecord` deep-clone + double-serialize hash | MED | `packages/sdk/src/tab.ts:1906-1926` | hash `JSON.stringify(value)` directly (shared fn) |
Sequence safe pieces first: FrameDecoder cursor → direct struct→writer → buffer reuse → drop `sortRecord` → (benchmark) RawValue.

### Theme A — Operation-lock maps: scalability choke + memory leak *(vuln × perf, MEDIUM)* → **Plan 9**
| §4.6/§3.6 per-session/tab lock maps never evicted | MED | `crates/obu-host/src/dispatcher.rs:73-74, 511-521, 1306-1320` | lifecycle-tied eviction; gate behind tab-existence check |
| §3.11 redundant String clones per dispatch | LOW | `dispatcher.rs:388-390, 434-435, 449, 618-623` | defer `cancel_method`; move (not clone) ids into the command event |
The contention half was refuted; the **leak/eviction half is the real fix**.

### Theme I — Discrete action verbs are hard-coded finite menus *(fidelity, MEDIUM)* → **Plan 10** *(design-sensitive)*
| §1.1 `keypress` finite descriptor table | MED | `crates/obu-host/src/ops/keyboard.rs:270-307` | synthesize generic `dispatchKeyEvent` for any Unicode scalar / named key; fix byte-vs-char (`chars().count()==1`); add F1-F12/lock/media |
| §1.2 confirm/prompt force-dismissed, no accept/answer | MED | `crates/obu-host/src/ops/dialogs.rs:111-117` | thread `accept`+`promptText`; add `tab.respondDialog(...)`; keep dismiss default overridable |
Touches the `js` tool description → snapshot update required.

### Optional — Perf micro-cleanups *(low/info)* → **Plan 11 (optional)**
§3.10 method-table scans (keep tables separate!), §3.12 `rewrite_artifacts` identity rebuild. Noise-floor; do only if touching those files anyway.

---

## Plan sequence

Plan *numbers* remain the per-Theme finding map; for **execution** the plans were re-grouped (2026-05-29, code-grounded — see "Consolidation & collision resolution" below). The table is ordered by execution readiness.

| Plan | Title | Themes / Findings | Bundle (execution) | Status |
|---|---|---|---|---|
| **1** | Integrity quick-wins | J §4.4 · F §4.8 + §4.10(pure) · G §4.5 | — | **✅ LANDED** (2026-05-29) — merged FF to local `main`, 4 signed commits `4dc2e40`/`283b3f0`/`6c04bf6`/`885a237`, NOT pushed; full CI-mirror green. Plan: `2026-05-29-audit-fix-integrity-quickwins.md` |
| **7 + 9** | Resource & lifecycle bounds | H §2.1 + §2.2 + §4.9 · A §4.6/§3.6 + §3.11 | **Group A** — cargo; no agent-facing contract change | **✅ EXECUTED + REVIEW-HARDENED** (2026-05-29) — branch `fix/audit-resource-bounds`, **8 signed commits** (5 fixes + 3 review-follow-ups), 461 host tests green, `policy.rs`/`methods.rs` verified untouched; PR-ready, NOT pushed. Plan: `2026-05-29-audit-fix-resource-bounds.md` |
| **3** | Overlay + finalize belief-integrity | F §4.2 + §4.10(controller) | **Group B** — node-runner; needs Plan 1 ✅ | **✅ EXECUTED + REVIEW-HARDENED** (2026-05-29) — branch `fix/audit-overlay-finalize-integrity`, **4 signed commits** (2 fixes + 2 review-follow-ups, incl. a **§4.10 SDK turn-end behavior change** — see Execution status); SDK 208 + extension + bcc green; PR-ready, NOT pushed. Plan: `2026-05-29-audit-fix-overlay-finalize-integrity.md` |
| 2 | CDP transport resilience | G §4.1 | **isolated** — lone HIGH; reconnect state machine, needs mock-WS harness | **✅ EXECUTED + REVIEW-HARDENED** (2026-05-29) — branch `fix/audit-cdp-transport-resilience`, **4 signed commits** (Reconnecting variant · OopifSessionMap::clear · supervised bounded-reconnect loop + FakeCdpServer mock-WS harness · backend session re-establish); `obu-host` 260 lib tests green (22 CDP-module), siblings build, fmt/clippy clean; per-task spec+quality + adversarial + whole-branch reviews all APPROVE; PR-ready, NOT pushed. Plan: `2026-05-29-audit-fix-cdp-transport-resilience.md` |
| 8 | IPC/serialization copy elimination | C §3.4 + §3.2 + §3.7 + §3.8 + §3.9 | **isolated** — benchmark-gated; 2 regression traps | ✅ **EXECUTED + REVIEW-HARDENED** (2026-05-29) — branch `fix/audit-ipc-serialization`, **6 commits**: §3.4 cursor FrameDecoder (7.1× A/B) · §3.7 direct `KernelIn`→bytes · §3.8 reused `BytesMut` read buf · §3.9 drop `sortRecord` (2.58× A/B) **landed**; §3.2 RawValue measured **5.6–9.6% < 15% gate → REVERTED** (4 parity tests + `#[ignore]` A/B kept). obu-wire+obu-node-repl **139** tests + SDK **212** green, `fmt --all` clean, **0 new clippy**, no agent-facing/policy/methods/js-desc/snapshot change; per-task spec+quality + whole-branch reviews all SHIP. All **6 commits signed** (`G`). PR-ready, NOT pushed. Plan: `2026-05-29-audit-fix-ipc-serialization.md` |
| 4 | Display honesty & host-memory bound | D §4.3 + §1.3 + §1.5 (~~§1.6~~→Plan 6) + **§3.12 folded in** | **was HOLD; design nod given 2026-05-30** | ✅ **EXECUTED + REVIEW-HARDENED** (2026-05-30) — branch `fix/audit-display-honesty`, **4 signed commits**: §4.3 push-time display bound + true-total counter (`ExecRegistry::push_display`, head-keeping) · §1.3 honest `displays_total`/`displays_shown` in payload+summary+**js-description** (snapshot regenerated) · §3.12 in-place `&mut` `rewrite_artifacts` (no identity rebuild) · §1.5 `extractTable` throws on `{kind:"truncated"}` instead of `rows: undefined`. 116 node-repl + 208 SDK tests green, fmt/clippy clean (0 new), `policy.rs`/`methods.rs` untouched; per-task spec+quality + whole-branch (SHIP) reviews. ⚠️ agent-facing additions (user design-nodded): `displays_total`/`displays_shown` result fields + js-desc doc + `extractTable` now throws. PR-ready, NOT pushed. Plan: `2026-05-29-audit-fix-display-honesty.md` |
| 5 | DOM-observe geometry (two-birds, safe tier) | B §3.1 + §3.3 + §3.5 + §1.4 | **was HOLD; design nod given 2026-05-30** | **EXECUTED + FOLLOW-UP IMPLEMENTED** (2026-05-30) — branch `fix/audit-dom-observe-geometry`, **12 signed implementation commits + 1 signed status-doc commit**: original 6 safe-tier commits plus 6 §1.4 fidelity follow-up commits for review A/B/C/E/G/H. Follow-up changes: SDK `DomCuaMeta` + text marker, OOPIF `meta.degraded`, byte-budget `text_truncated`, behavioral predicate test, full payload golden test, js-description snapshot. Verification: `cargo test -p obu-host --lib ops::dom_cua` passed (35 tests), `cargo test -p obu-host --lib ops::dom_cua_runtime` passed (12 tests), `cargo test -p obu-node-repl` passed, `cargo fmt --check` passed, SDK `tsc --noEmit` passed, SDK Vitest passed (208 tests). `cargo clippy -p obu-host --all-targets -- -D warnings` currently fails on pre-existing warnings outside the Plan 5/follow-up diff. `policy.rs`/`methods.rs` untouched. All branch commits signed (`G`); branch not pushed. Plans: `2026-05-30-audit-fix-dom-observe-geometry.md`, `2026-05-30-audit-fix-dom-observe-geometry-fidelity-followup.md` |
| 6 | Tab API staleness coherence | E §4.7 + **§1.6 (sole owner)** | **HOLD** — human design nod | to write |
| 10 | Open action verbs *(design nod first)* | I §1.1 + §1.2 | **HOLD** — human design nod | to write |
| 11 | Perf micro-cleanups *(optional)* | §3.10 + §3.12 | **folded** — §3.12→Plan 4, §3.10→after Plan 9 | deferred |

Each individual Plan remains independently shippable and produces working, tested software on its own. **Group A** (Plans 7+9) and **Group B** (Plan 3) are now **EXECUTED + review-hardened** on their branches (PR-ready, not pushed — see "Execution status & adversarial review" below); **Plans 2 and 8** ship isolated so their validation risk (reconnect harness / benchmarks) never gates the mechanical fixes; **Plan 4** is now **EXECUTED + signed** (branch `fix/audit-display-honesty`, design nod given 2026-05-30); **Plan 5** is now **EXECUTED + FOLLOW-UP IMPLEMENTED + signed** (branch `fix/audit-dom-observe-geometry`, design nod given 2026-05-30; clippy currently blocked by unrelated pre-existing warnings); **Plans 6/10** remain HELD pending a human design nod — and each stays its **own** PR even after the nod (do *not* merge them into one branch); **Plan 11** is folded into the file-owners it collides with.

## Consolidation & collision resolution (2026-05-29 — verified against current source)

The remaining work was re-grouped by **risk class + review-coherence + file-locality** (every plan's files reopened and re-verified). The original "one Plan per Theme" decomposition stands as the *finding* map; for *execution* the plans group as:

- **Group A — `2026-05-29-audit-fix-resource-bounds.md` (Plans 7 + 9):** pure-Rust "bound the unbounded state" (task-store TTL/retention/bounded-actor + operation-lock eviction). One cargo PR, one invariant, no agent-facing contract change. **✅ EXECUTED + review-hardened** (branch `fix/audit-resource-bounds`, 8 signed commits).
- **Group B — `2026-05-29-audit-fix-overlay-finalize-integrity.md` (Plan 3):** extension belief-integrity (overlay `hide()` race + finalize `not_attempted` controller wiring). Node-runner PR; depends on the now-landed Plan 1. **✅ EXECUTED + review-hardened** (branch `fix/audit-overlay-finalize-integrity`, 4 signed commits). **NOTE:** unlike Group A, Group B now carries a small **agent-facing SDK behavior change** (the §4.10 turn-end follow-up below) — flag it in the PR.
- **Isolated — Plan 2** (the program's lone HIGH; reconnect state machine needing a mock-WS drop-then-reconnect harness) and **Plan 8** (perf; its own guardrail *mandates* before/after benchmarks; carries the RawValue first-key-misclassification trap and the §3.9 two-call-site lockstep). Each its own PR. **Plan 2 is now ✅ EXECUTED + review-hardened** (branch `fix/audit-cdp-transport-resilience`, 4 signed commits; see "Execution status" below) — design landed as: supervised in-transport bounded-reconnect loop (interior mutability, `Arc<CdpTransport>` identity stable), retryable `CdpError::Reconnecting` for in-flight requests, terminal fallback after the attempt budget, and a backend consumer that re-establishes sessions by **re-attaching via `target_id`** (flatten session ids are connection-scoped — the old `cdp_session_id`s are dead) + re-arming `setAutoAttach` so the existing OOPIF consumer rebuilds children. Deliberate scope boundary (flag in PR): **no new host→SDK CDP-reconnect staleness channel** — relies on the SDK's existing per-observe page-state drift check. **Plan 8 is now ✅ EXECUTED + review-hardened** (branch `fix/audit-ipc-serialization`, 6 commits; plan `2026-05-29-audit-fix-ipc-serialization.md`): the four safe fixes landed (§3.4 cursor FrameDecoder, §3.7 direct `KernelIn`→bytes, §3.8 reused read buffer, §3.9 drop `sortRecord` deep-clone) and the **benchmark-gated §3.2 RawValue rewrite was measured at 5.6–9.6% (< the 15% guardrail) and REVERTED** — `envelope.rs`/`Cargo.toml` byte-identical to main, but 4 behavior-pinning parity tests (key-order independence + the `id:null`→present trap + neither-case + large-payload fidelity) + a runnable `#[ignore]` A/B were kept so any future rewrite is gated. No agent-facing/wire-contract change (§3.7 key-order delta confirmed benign: internally-tagged enum, kernel parses by named field, no `preserve_order`). All 6 commits **signed** (controller re-signed via `git rebase --exec 'git commit --amend --no-edit -S' main`, sandbox off; trees unchanged, SHAs churned). PR-ready, NOT pushed.
- **EXECUTED (design nod given 2026-05-30) — Plan 4** (`2026-05-29-audit-fix-display-honesty.md`, branch `fix/audit-display-honesty`, 4 signed commits): the display-honesty + host-memory-bound theme. §4.3 host-RSS leak and §1.3 payload count-loss were fixed as **the same edit moved to push time** (`ExecRegistry::push_display` bounds the live `displays` Vec head-keeping at `MAX_DISPLAY_COUNT` and counts a `displays_total` that survives the cap; `prepare_js_result` surfaces `displays_total`/`displays_shown` + a `displays (50 of N shown; head)` summary token + a js-description doc line, snapshot regenerated). §1.5 `extractTable` now throws on the `{kind:"truncated"}` evaluate sentinel (mirroring `snapshotText`) instead of yielding `rows: undefined` — closing the `string[][]` type hole; new exported `EvaluateTruncationSummary` type. §3.12 folded in: `rewrite_artifacts` rewritten to in-place `&mut Value` (no identity tree rebuild). Head-keeping was a deliberate **user decision** (not a ring/tail); §1.6 stayed with Plan 6 (collision). 116 node-repl + 208 SDK green, fmt/clippy clean, `policy.rs`/`methods.rs` untouched. **Agent-facing contract changes to flag in the PR:** `displays_total`/`displays_shown` result fields + js-desc doc; `extractTable` throws on truncation. All 4 commits signed (`G`). PR-ready, NOT pushed.
- **EXECUTED + FOLLOW-UP IMPLEMENTED + signed (design nod given 2026-05-30) — Plan 5** (`2026-05-30-audit-fix-dom-observe-geometry.md` + `2026-05-30-audit-fix-dom-observe-geometry-fidelity-followup.md`, branch `fix/audit-dom-observe-geometry`, **12 signed implementation commits + 1 signed status-doc commit**): Theme B DOM-observe geometry, perf × fidelity two-birds. The original safe-tier six commits shipped predicate hoist before box-model RTT, concurrent `join_all` box-model fetch, precomputed attrs/tag helpers, `meta{shown,total,truncated,hint?}`, per-entry `text_truncated`, and post-scroll `getLayoutMetrics`/`getContentQuads` overlap without viewport caching. The follow-up six commits implemented review A/B/C/E/G/H: SDK `DomCuaMeta` + text-path marker, `meta.degraded` for unreadable OOPIF frames, byte-budget `text_truncated` honesty, behavioral predicate test, full payload golden test including OOPIF `session_id`, and js-description snapshot update. **Safe tier ONLY** remains true: no `DOMSnapshot.captureSnapshot` rewrite; frame-local `getBoxModel`/`getContentQuads` basis preserved. Verification after follow-up: `cargo test -p obu-host --lib ops::dom_cua` passed (35 tests), `cargo test -p obu-host --lib ops::dom_cua_runtime` passed (12 tests), `cargo test -p obu-node-repl` passed, `cargo fmt --check` passed, SDK `tsc --noEmit` passed after building `@open-browser-use/browser-control-core`, and SDK Vitest passed (208 tests). `cargo clippy -p obu-host --all-targets -- -D warnings` currently fails on pre-existing warnings outside the Plan 5/follow-up diff (`oopif.rs`, `webext/mod.rs`, `dispatcher.rs`, `native_messaging.rs`, `ops/cua.rs`, `task_store.rs`, `registry_lifecycle.rs`). `policy.rs`/`methods.rs` untouched. **Agent-facing contract changes to flag in the PR:** host `get_visible_dom` returns `meta.degraded`, SDK JSON path exposes `meta`, text path appends a truncation marker, and the js tool description documents both. All branch commits signed (`G`); branch not pushed.
- **HOLD until a human design nod — Plans 6, 10:** all change the agent-facing contract and/or the insta-snapshot-pinned `js` tool description. **Do NOT merge them into one branch even after the nod** — each is its own contract + its own snapshot/oopif/vitest gate. They also carry the two real collisions below.
- **Plan 11 (optional) — folded, not standalone:** §3.12 → into **Plan 4** (its `rewrite_artifacts` call site lives inside Plan 4's `result_budget.rs:59-78` edit window); §3.10 → sequenced **after Plan 9** in `dispatcher.rs` (call-site only; the tables live in `policy.rs`/`methods.rs` — keep them separate, security boundary).

### Execution status & adversarial review (2026-05-29)

**Group A and Group B are EXECUTED**, twice-reviewed (per-task spec+quality during subagent-driven-development, then an independent multi-lens Workflow), all findings + review-confirmed nits fixed, every commit signed, PR-ready — **NOT pushed/merged** (the human-review gate holds; push/PR is user-initiated).

- **Group A** `fix/audit-resource-bounds` — 8 signed commits: 5 fixes (§2.1/§2.2/§4.9/§4.6/§3.11) + 3 review-follow-ups (§4.9 observable-shed, §4.6 route-level eviction test, §2.2 vacuum/migration tests). 461 host tests pass; `policy.rs`/`methods.rs` verified untouched. (Commit SHAs churn on each re-sign — reference the branch, not a SHA.)
- **Group B** `fix/audit-overlay-finalize-integrity` — 4 signed commits: §4.2, §4.10 + 2 review-follow-ups (§4.10 SDK turn-neutral, §4.2 test-discrimination reset). SDK 208 + extension (27 modules) + browser-control-core green.

**Plan-bug caught & corrected during execution (CRITICAL — was a wrong premise in the Plan 7+9 doc):** the §2.2 retention DELETE listed terminal states as `cancelled/blocked/completed`. A code-grounded review against `task_lifecycle.rs:160/162` found `blocked` is **recoverable** (`Blocked => &[Resuming, WaitingForHuman, Cancelling, Failed]`) — pruning it would destroy live work — while `failed` (truly terminal, empty transition slice) was **omitted** so it never pruned. Corrected to `('completed','cancelled','failed')` + keep-Blocked / prune-Failed regression tests; the Plan 7+9 doc was corrected in lockstep.

**Adversarial Workflow review** (`obu-ab-implementation-review`: 7 lenses × 3 perspective-diverse skeptics, 56 agents): **16 findings raised → 5 confirmed** (≥2/3 "real & material"), both branches **ship-with-nits** — no product-code defect blocked merge (a scary "working-tree reverts the §4.2 guard" was *refuted*). All 5 confirmed nits fixed as the review-follow-up commits above: §4.9 silent shed made observable (rate-limited `tracing::warn!` at the 3 Full arms; surfacing the counter in `get_info` was deliberately **skipped** — it's an agent-facing wire surface), §4.6 route-level success/method-gating test, §2.2 vacuum/auto_vacuum-migration tests, §4.2 test-discrimination reset.

**⚠️ §4.10 NEW agent-facing behavior (user-approved 2026-05-29):** an unowned/stale finalize `keep` tabId still flips status `ok→partial` (honest signal preserved), **AND** the SDK `shouldEndTurnAfterFinalize` (`packages/sdk/src/browser.ts`) now **ends the turn for a `not_attempted`-only partial** — a no-op (nothing attempted, nothing half-done) must not strand the turn; a genuine `failed` partial still respects `endTurnOnPartial`. Safe because the unowned-keep no-op is the **sole producer of `not_attempted`** in the whole codebase (grep-verified across TS/mjs/Rust). This is the one place Group B touches the agent-facing contract — call it out in the PR description.

**Plan 2 (§4.1 CDP transport resilience) — EXECUTED 2026-05-29 (subagent-driven-development).** Branch `fix/audit-cdp-transport-resilience` (4 signed commits, PR-ready, NOT pushed). Plan doc `2026-05-29-audit-fix-cdp-transport-resilience.md` written first (the report's "needs a mock-WS reconnect harness" was the crux deliverable — built as `FakeCdpServer` in a `#[cfg(test)]` `test_support.rs`, an accept-loop fake CDP browser with drop-on-cue + scriptable auto-responses, shared by transport + reconnect tests). Tasks 1–2 (retryable `CdpError::Reconnecting`; `OopifSessionMap::clear`) ran as one implementer+review; Task 3 (supervised reconnect loop) and Task 4 (backend re-establish) each fresh implementer + spec + quality review; the two meaty tasks also got an adversarial deep review (deadlock / pending-race / terminal-ordering / budget analysis + a 12-run flake loop on the timing-sensitive reconnect tests — 12/12 green), then a whole-branch coherence + guardrail audit (all APPROVE). **Key design decision (engineering call, not design-nod-gated):** recover the *socket* in-transport (bounded backoff, interior mutability keeping `Arc<CdpTransport>` identity stable, `events` broadcast preserved) and recover *sessions* in the backend by **re-attaching via `target_id`** — because `flatten` session ids are connection-scoped, naive "re-arm setAutoAttach on known sessions" (REPORT §4.1's wording) would target dead ids; the correct reading is *re-attach then re-arm*. Re-arming top-level sessions makes Chrome re-fire `attachedToTarget`, so the existing OOPIF consumer rebuilds children for free. ⚠️ **Scope boundary to flag in the PR:** no new host→SDK staleness signal for a CDP reconnect (that's the native-pipe transport's job + design-sensitive); relies on the SDK's existing per-observe page-state drift check to invalidate pre-blip observationIds. Reconnect policy is env-tunable (`OBU_CDP_RECONNECT_MAX_ATTEMPTS`=6, `OBU_CDP_RECONNECT_BACKOFF_MS`=250, 5s cap) — release-note line. `obu-host` 260 lib tests green; `policy.rs`/`methods.rs` untouched.

### Two real cross-plan collisions (resolve before coding)
1. **`packages/sdk/src/tab.ts` §1.6 (1143–1146)** was claimed by BOTH Plan 4 and Plan 6 — the identical `__obu_evaluate_summary` return branch = a real same-line conflict. **Assigned to Plan 6** (Theme E). Plan 4 drops §1.6.
2. **`crates/obu-node-repl/src/result_budget.rs:59–78`** — Plan 11's §3.12 `rewrite_artifacts` is *called* inside the very display loop Plan 4 §1.3 rewrites. **§3.12 folded into Plan 4** (single owner of that loop). *(This collision was not in the original per-Theme framing.)*

### Citation corrections (the report/roadmap line:line spot-check was only partly accurate)
- **§4.3 has TWO uncapped push sites**, not one: `repl_manager/mod.rs:1019` (`handle_display_frame`) **and `:1063`** (`handle_emit_image_frame`). The real unbounded struct is `ExecRegistry.displays` in **`kernel_state.rs:80-103`**, not `mod.rs`. Plan 4 must cap both push sites.
- **§2.1 TTL is a TWO-site fix:** `task_store.rs:1457` (`attempt_by_token_for_attach`) **and `:1302`** (`pending_resume_attempt`) both read `expires_at` without enforcing it. *(Encoded in the Plan 7+9 doc.)*
- **Plan 3 controller path:** the controller is `packages/extension/src/finalize_tabs_controller.ts`, **not** `browser-control-core` as the Theme F table implies. *(Corrected in the Plan 3 doc.)*
- **§3.10 tables** (`classify_method`, `METHOD_POLICY_CLASSIFICATIONS`, `ALL_INBOUND_METHODS`) live in **`policy.rs`/`methods.rs`**, not `dispatcher.rs`; `dispatcher.rs` only holds the call sites (`:501-507`, `:1327-1330`). So the "dispatcher.rs by Plans 9 and 11" overlap is call-site coordination, not a same-line conflict.
- **Operation-lock maps are PROCESS-GLOBAL:** `main.rs` builds `DispatcherInner` once and Arc-clones it into every `serve_peer` task, so Plan 9 eviction must be lifecycle-driven, never connection/peer-scoped. *(Encoded in the Plan 7+9 doc.)*

---

## Out of scope (noted, not addressed here)

The report itself carries **minor residual accounting bugs** (the doc-fix path the user did *not* choose): the §6 Coverage-Map vuln cells sum to **11** vs the stated **10** (the §4.3/§4.9 node-REPL pair is double-counted across two rows; grand total prints 31 not 30), and the dismissed appendix lists **27** while claiming **28** (the Performance section lists 5, should be 6 — one coordinate/geometry dismissal missing). These are a separate ~20-minute doc-consistency pass; they do not affect any code fix above.
