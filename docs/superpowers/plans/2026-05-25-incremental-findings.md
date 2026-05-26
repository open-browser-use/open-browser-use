# `.incremental` ARIA snapshot — feasibility findings

> Read-only spike (Task 3 of the dom-snapshot ARIA pruning plan). No host/source
> changes were made. This memo records the verified mechanism, a live capture, and
> a go/no-go recommendation. Conclusions are grounded in the vendored Playwright
> bundle (`crates/obu-host/vendored/playwright-injected.js`), the host call site
> (`crates/obu-host/src/ops/playwright/runtime.rs`), the injected-mount code
> (`crates/obu-host/src/backends/cdp/ensure_injected.rs`), the Phase 1 pruner
> (`crates/obu-host/src/ops/playwright/aria_prune.rs`), and a live browser capture.

## Mechanism (verified)
- `incrementalAriaSnapshot(root, {mode:"ai", track})` returns `{full, incremental}`.
  In the vendored bundle, `ariaSnapshot(e,t)` is literally
  `this.incrementalAriaSnapshot(e,t).full` — `full` is the only thing OBU consumes
  today.
- `incremental` (the `Se(tree, opts, previousSnapshot)` diff) collapses unchanged
  subtrees to `- ref=eN [unchanged]` and prefixes changed top-level nodes with
  `<changed> `. Verified verbatim in the minified bundle:
  - unchanged branch: `c.get(h)==="same"&&h.ref` ⇒
    `i.push(Qt(g)+\`- ref=${h.ref} [unchanged]\`)`
  - changed branch: `Qt(g)+"- "+(S?"<changed> ":"")+xn(d(h,m))`
- The diff is computed against `_lastAriaSnapshotForTrack.get(track)`, stored on the
  per-page `window.__obuPlaywrightInjected` instance. The exact bundle logic:
  ```js
  let n = ye(e,t), i = Se(n,t), s;
  if (t.track) {
    let o = this._lastAriaSnapshotForTrack.get(t.track);
    o && (s = Se(n,t,o).text);                 // diff vs prior snapshot for this track
    this._lastAriaSnapshotForTrack.set(t.track, n);
  }
  return /* … */, { full: i.text, /* … */ incremental: s ?? null };
  ```
  So on the FIRST call for a track there is no prior (`o` is undefined) ⇒
  `incremental` is `null` by construction; the delta only appears on the SECOND+
  call for the same track.

## Persistence (verified)
- `ensure_injected.rs` mounts `window.__obuPlaywrightInjected` once
  (`if (!window.__obuPlaywrightInjected) { … new PlaywrightInjected.InjectedScript(…) }`)
  and reuses it; the host marks the tab injected and re-probes
  `!!window.__obuPlaywrightInjected` before re-mounting. The constructor sets
  `this._lastAriaSnapshotForTrack = new Map`, so per-track state lives on that single
  instance and survives across `dom_snapshot` calls within a page.
- Navigation/reload destroys the page's `window`, so the next `ensure_injected`
  re-mounts a fresh instance with an empty `_lastAriaSnapshotForTrack` ⇒ the first
  post-navigation snapshot has no prior ⇒ `incremental` is null. Any future wiring
  MUST fall back to `full` in that case (and on first-ever snapshot).
- Today `dom_snapshot` in `runtime.rs` calls
  `injected.incrementalAriaSnapshot(root, { mode:"ai", track:"open-browser-use-dom-snapshot" }).full`
  and returns `{ domSnapshot: <full>, source: "playwright_dom_snapshot" }`. The
  `.incremental` sibling is computed and stored every call (because `track` is set)
  but is **discarded** — nothing in OBU reads it. There is no `incremental` field on
  the wire, in the SDK, or in any test.

## The ref conflict (the decision)
- Phase 1 (`aria_prune.rs`, sibling task T1, `prune_aria_snapshot`) strips
  `[ref=…]` (and `[cursor=…]`) from the model-facing `full` snapshot. Its own
  doc-comment states the rationale: "OBU addresses elements via Playwright locators
  / dom_cua node ids, never ARIA refs, so stripping refs is lossless for the
  model-facing snapshot." (T2 — wiring the pruner into `dom_snapshot` — is still
  pending, so on this branch `dom_snapshot` currently returns raw `full` WITH refs;
  but the plan's intent is that the shipped snapshot is ref-free.)
- But `incremental` references unchanged regions BY ref: an entire unchanged subtree
  collapses to one line like `- ref=e3 [unchanged]`. That line is only meaningful to
  a consumer that still holds a prior snapshot containing `ref=e3` to expand it
  against. Phase 1 removes exactly those refs from `full`.
- Therefore exposing incremental to the model requires one of:
  - **(A)** keep refs in `full` snapshots when incremental is enabled (costs the
    tokens Phase 1 saved, in the snapshots the model must retain), then let the model
    correlate `- ref=eN [unchanged]` against the prior full snapshot it kept; or
  - **(B)** translate `[unchanged]`/`<changed>` into a self-contained, ref-free diff
    OBU owns (e.g. re-expand each `[unchanged]` ref against the prior tree, or emit a
    structural/positional diff that needs no external ref table); or
  - **(C)** defer — rely on the existing "reuse the last snapshot" instruction +
    dom_cua caching, and revisit if/when a concrete consumer needs sub-snapshot
    deltas.

## Captured sample
Live capture on `https://news.ycombinator.com/` via the open-browser-use `js` tool
(webextension-backed Chrome). Sequence: one `tab.domSnapshot()` to mount the injected
script and seed the track (seed `full` was 63,874 chars), then a structural mutation
(appended `<nav aria-label="obu-probe-injected"><button>OBU Probe Button</button></nav>`
to `document.body`), then a raw-CDP probe of the `.incremental` sibling
(`JSON.stringify(window.__obuPlaywrightInjected.incrementalAriaSnapshot(document.body,{mode:"ai",track:"open-browser-use-dom-snapshot"}).incremental ?? null)`).

Probe output, verbatim (the `JSON.stringify`'d string; length 161 chars):

```
- <changed> generic [active] [ref=e1]:
  - ref=e3 [unchanged]
  - navigation "obu-probe-injected" [ref=e682]:
    - button "OBU Probe Button" [ref=e683]
```

Reading it: the top-level node whose subtree changed is prefixed `<changed> `; the
entire unchanged ~63 KB HN body collapses to the single line `- ref=e3 [unchanged]`
(the whole token win, addressed purely by ref `e3`); only the newly added landmark is
expanded inline. The first (seed) call's `incremental` was null by construction, as
the mechanism predicts. This empirically confirms the ref conflict: the `[unchanged]`
line carries no information to a model unless it still holds a prior `full` snapshot
containing `ref=e3` — i.e. refs must survive in `full`, which is exactly what Phase 1
strips.

## Recommendation
**(C) Defer.** Reasons, grounded in the capture and code:

1. **No consumer exists.** Nothing in OBU — wire schema, SDK, agent prompt, or tests
   — reads a `.incremental` field today; `dom_snapshot` already computes the diff and
   throws it away. There is no caller waiting on this, so the value is purely
   speculative right now.
2. **Phase 1 directly undercuts the diff.** The captured diff's entire payoff is the
   `- ref=e3 [unchanged]` collapse, and that is addressed BY ref. Phase 1's whole
   premise (and its tests, e.g. `strips_ref_and_cursor_annotations`) is that refs are
   dead weight OBU never uses. Shipping incremental therefore means either contradicting
   Phase 1 (option A) or building a non-trivial ref-resolution layer (option B). Doing
   that to feed a consumer that does not exist is premature.
3. **Token trade-off is not a clear win.** The diff only saves tokens on the model's
   *second+* snapshot of an *unchanged-mostly* page, AND only if the model is also
   carrying the prior ref-bearing `full` snapshot to expand `[unchanged]` against —
   which re-incurs the per-snapshot ref tokens Phase 1 removed (option A), or requires
   OBU to host-side expand the diff itself (option B). The existing mitigation ("reuse
   the last snapshot" guidance + dom_cua caching) already covers the "page didn't
   change much" case without any of this machinery or the ref regression.
4. **Fragility.** `incremental` is null on first snapshot and after every
   navigation/reload (fresh `window` ⇒ fresh `_lastAriaSnapshotForTrack`), so a
   consumer must always carry a `full` fallback anyway — extra branching for a
   conditional, partial win.

If a concrete consumer later justifies a go, the **future host work is not yet built**
and is roughly:

- **For (A) — keep refs when incremental is on:**
  - Change `dom_snapshot` to return `{ full, incremental }` (currently `.full` only),
    and make the Phase 1 pruner ref-strip *conditional* (preserve `[ref=…]` in `full`
    while incremental is enabled, so the model can correlate `[unchanged]` refs).
  - Surface an `incremental` field on the wire op result + the SDK `domSnapshot`
    return shape, with a documented `null`-on-first/after-nav contract and `full`
    fallback.
  - Add fake-backend tests asserting: first call ⇒ `incremental: null`; second call
    after a mutation ⇒ a diff containing `<changed> ` and `- ref=eN [unchanged]`;
    post-navigation ⇒ `incremental: null`.
- **For (B) — OBU-owned ref-free diff:**
  - All of the wire/SDK surfacing in (A), plus a host-side transform that re-expands
    each `- ref=eN [unchanged]` against the previously stored `full` tree (OBU would
    need to retain the prior pruned tree keyed by track), OR replaces refs with a
    self-contained positional/structural marker. This is the most code and the most
    test surface (round-trip diff↔expand correctness, ref-name collisions like the
    pruner's known ` [ref=` accessible-name caveat, stale-track handling).

None of that exists yet. Recommendation stands: **defer (C)**, keep Phase 1's
ref-stripping unconditional, and reconsider only when a concrete consumer needs
sub-snapshot deltas.
