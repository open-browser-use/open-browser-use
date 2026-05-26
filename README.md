<div align="center">

<h1>open-browser-use</h1>

<p><b>Let agents control the browser you already use.</b></p>

<img src="open-browser-use-readme-preview-wide.png" alt="open-browser-use — agent browser tool, agentic RL ready" width="820">

<sub><b>English</b> · <a href="i18n/README.zh-CN.md">简体中文</a> · <a href="i18n/README.ja.md">日本語</a> · <a href="i18n/README.ko.md">한국어</a> · <a href="i18n/README.es.md">Español</a></sub>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Status: public preview" src="https://img.shields.io/badge/status-public%20preview-orange?style=flat-square">
  <img alt="Platforms: macOS and Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux-lightgrey?style=flat-square">
  <br>
  <img alt="Built with Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Model Context Protocol" src="https://img.shields.io/badge/MCP-server-7C3AED?style=flat-square">
</p>

<p>
  <a href="#install-current-preview">Install</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#capabilities">Capabilities</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#security-and-privacy">Security</a> ·
  <a href="#agentic-rl-environment">Agentic RL</a>
</p>

</div>

---

Your coding agent can reason, plan, and write code. But the moment a task lives behind a login, inside a dashboard with no API, or in a clicky multi-step web form, it hits a wall: plenty of brain, no hands on the browser. **open-browser-use gives it those hands** — driving *your* real, already-signed-in browser, entirely on your own machine.

## Your agent has a brain, but no hands

We love telling agents to "just handle it." The trouble is that so much of *it* lives in a browser tab:

- "Download every invoice from my email this quarter and add them up."
- "Reorder my usual groceries from the store I'm already logged into."
- "Pull the numbers off this dashboard — it has no export button."
- "Fill out this application using the details from that PDF."

None of these are hard to *think* about. They're hard because the agent can't *touch* the page. open-browser-use closes that gap, and tries to do it the friendly way:

- **Your real browser, your sessions.** It drives the Chrome you already use, with your logins and cookies — not a fresh, logged-out robot browser. So it can do your *actual* errands.
- **Local and private.** Everything runs on your machine. No cloud, no account, nothing phones home.
- **Works with the agents you already have.** Codex, Claude Code, Cursor, Gemini CLI, VS Code, and more — over the Model Context Protocol (MCP).
- **Open source**, MIT licensed.

## Install (current preview)

open-browser-use is a **macOS / Linux public preview** — the Chrome Web Store listing isn't live yet, so the extension ships through GitHub Releases. You set up one thing by hand: the browser extension. Your AI agent installs and connects everything else.

1. **[Download the extension](https://github.com/open-browser-use/open-browser-use/releases/latest/download/open-browser-use-extension.zip)** from the latest release, then unzip it.
2. **Load it into your browser:** open `chrome://extensions` (Chrome or another Chromium browser), turn on **Developer mode**, click **Load unpacked**, and select the unzipped folder. Pin it — its popup is how you connect your agent next.

> [!NOTE]
> Once the Chrome Web Store listing is live you'll add the extension straight from the Store — no download or unzip. For per-platform notes and troubleshooting, see [docs/install.md](docs/install.md) and [docs/troubleshooting.md](docs/troubleshooting.md).

## Quickstart

With the extension loaded, connecting it to your coding agent takes about a minute — no config files to hand-edit:

1. **Open the extension popup** and click **Copy for agent**.
2. **Paste it into your coding agent** (Codex, Claude Code, Cursor, Gemini CLI, …).
3. The agent **sets up the open-browser-use MCP server and connects to your browser.** That's it.

> [!TIP]
> Then just ask, in plain language:
> *"Open my GitHub notifications and summarize what actually needs my attention."*

## Capabilities

Your agent drives the browser through a single `js` tool. The JavaScript it writes runs in a persistent Node runtime where a Playwright-shaped SDK is bound to the `agent` global, so a complete turn of browser work stays small and legible:

```js
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.current();
await tab.attach();                                   // take control of the tab
await tab.goto("https://news.ycombinator.com");
await tab.getByRole("link", { name: "new" }).click();
display(await tab.locator("h1").innerText());         // surface a result
await browser.turnEnded();                            // hand control back, keep the session
```

The SDK covers the full range of interactions a real task demands:

| Capability | What it provides |
| --- | --- |
| **Act on elements** | Click, fill, type, press, select, and hover — addressed by ARIA role, visible text, or CSS selector: the resilient, Playwright-style locators that survive markup churn. |
| **Click by sight or DOM node** | Vision/coordinate and DOM-addressed interaction for pages with no clean selector, including targets inside cross-origin iframes. |
| **Read and extract** | Page and element text, tables, attributes, and screenshots. |
| **Files and dialogs** | File uploads and downloads, plus native `alert`, `confirm`, and `prompt` handling. |
| **Tabs, sessions, and resume** | Drive multiple tabs and sessions in parallel, and resume long-running tasks across turns without losing place. |

For higher-level workflows, the SDK layers ergonomic helpers (`tab.act.*`, `tab.flows`, `tab.read`) on top of these same primitives.

## Architecture

To your agent, open-browser-use is an MCP server. The agent writes JavaScript through the single `js` tool; that code executes in a long-lived Node runtime where the SDK is bound to `agent`. SDK calls are framed as JSON-RPC and travel over a capability-gated, owner-only Unix socket to **`obu-host`** — a per-session broker daemon that drives your browser through one of two backends:

```
your agent
   │  MCP over stdio              (the `js` tool; you write JS, the SDK is `agent`)
   ▼
obu-node-repl                     (MCP server + the Node runtime it spawns)
   │  JSON-RPC over an owner-only Unix socket   (capability-gated)
   ▼
obu-host                          (per-session broker daemon)
   ├─▶ WebExtension backend ─▶ your everyday Chrome        (MV3 + native messaging, no debug port)
   └─▶ CDP backend          ─▶ Chrome with remote debugging   (OBU_CDP_URL)
```

Both backends speak the same protocol and present the same SDK; they differ only in how they reach the browser:

| Backend | How it reaches the browser | Best for |
| --- | --- | --- |
| **WebExtension** *(default)* | A normally-installed Chrome through the open-browser-use extension (MV3 + native messaging) — no `--remote-debugging-port`, your real profile and logins intact. | Everyday use against the browser you already sign in to. |
| **CDP** | Any Chrome started with remote debugging, addressed via `OBU_CDP_URL`. | Headless, containerized, and scripted runs. |

<details>
<summary><b>Repository layout</b> — where each piece lives</summary>

| Path | What it is |
| --- | --- |
| `crates/obu-wire` | Shared JSON-RPC framing, envelopes, and error codes. |
| `crates/obu-node-repl` | The MCP server: spawns the Node runtime (where the SDK runs) and brokers its capability-gated socket to `obu-host`. |
| `crates/obu-host` | The per-session broker daemon and the CDP / WebExtension backends. |
| `packages/sdk` | The agent-facing, Playwright-shaped TypeScript SDK (`@open-browser-use/sdk`). |
| `packages/browser-control-core` | Pure protocol types, planners, and fixtures shared by the SDK and extension. |
| `packages/cli` | The `obu` command line — `setup`, `verify`, `doctor`, and agent MCP wiring. |
| `packages/extension` | The Chromium MV3 extension and its native-host bridge. |

</details>

## Security and privacy

open-browser-use is local-first by design: it never calls a remote URL or a product-policy service, and nothing about your browsing leaves your machine. SDK guards and host policy run locally and are permissive by default — you tighten them only when you need to. Three layers give you control, from the process boundary outward.

**Process boundary.** `obu-host` listens on a Unix socket that is owner-only and authenticated by OS user, and only trusted SDK code holds the capability token required to reach it. open-browser-use never opens a connection to a remote service.

**Host policy.** Constrain what the browser is allowed to do with environment variables:

| Variable | Effect |
| --- | --- |
| `OBU_HOST_POLICY_DENY_ORIGINS` | Block navigation and current-origin commands for the listed origins. |
| `OBU_HOST_POLICY_DENY_CDP_METHODS` | Block specific raw CDP methods (`*` blocks all). |
| `OBU_HOST_POLICY_BLOCK_HISTORY` / `_BLOCK_DOWNLOADS` / `_BLOCK_UPLOADS` | Block history reads, downloads, or uploads. |
| `OBU_GUARD_MODE=disabled` | Local/testing bypass for all guard and policy checks. |

**SDK guards.** For programmatic, per-browser control, install `Guards` hooks for navigation, downloads, uploads, history, and raw CDP. They run inside your local agent process and make no network request:

```ts
import { Guards } from "@open-browser-use/sdk";

const browser = await agent.browsers.get("chrome", {
  guards: new Guards({
    checkNavigation(url) {
      if (url.startsWith("https://admin.example/")) throw new Error("navigation blocked");
    },
  }),
});
```

## Agentic RL environment

open-browser-use is built to double as an **environment for training and evaluating browser agents**, not just to run them. The reinforcement-learning core already exists; what remains is the harness around it.

**Already in place**

- **An env-shaped action/observation loop.** `tab.observe()` returns a typed `TabObservation`; `tab.step(action)` takes a typed `EnvAction` and returns an `ActionResult`. `EnvAction` spans **13 action kinds** across three addressing modes — `locator.*`, `dom_cua.*`, and `coordinate.*` — each with an optional capability `policy`.
- **Rich, structured step results.** `ActionResult` reports an `ActionEffect` (`navigation`, `dom_changed`, `download_started`, `no_visible_change`, …), `invalidatedObservations`, handles, advisories, and a structured `error` — enough signal to drive a learner or a verifier.
- **Durable episodes with recovery.** Sessions carry ownership arbitration, stale-handle diagnostics, owner-turn proofs, and `resume`, so long episodes survive crashes and reconnects. Tasks export to `EpisodeExport { task_id, turns, events }`.

**Not there yet** — there's no single `Environment` facade exposing a formal, sampleable `reset/step/observe/close`; `browser.reset()` only resets the viewport (the backend attaches to a browser rather than launching a disposable one); and there's no built-in verifier substrate, reward-bearing trajectory schema, parallel rollout fleet, or Python / network (HTTP/gRPC) client — today the surface is MCP-stdio plus the native-pipe broker.

### Roadmap to a trainable environment

Ordered by the critical path to *"can you actually train against it"*:

- [ ] **Env facade + language-neutral protocol + Python client** *(keystone)* — converge `reset/step/observe/close` behind an HTTP/gRPC surface (or adapters for common RL frameworks) so an external trainer can drive rollouts at scale.
- [ ] **Clean, seeded `reset()`** — let the backend launch a disposable browser with a fresh profile and fixed start URL, torn down at episode end. This single capability unlocks both reset *and* parallelism.
- [ ] **Verifier substrate (RLVR)** — a deterministic assertion library (`url_contains`, `text_visible`, `dom_query`, `download_produced`, JS predicate) plus `episode.evaluate({ assertions })`.
- [ ] **Training-ready trajectory schema** — type `EpisodeExport.turns` into `(obs, action, effect, reward, done)` records with standard JSONL / Hugging Face dataset export.
- [ ] **Parallel rollout fleet** — a pool of N isolated browsers with async stepping (builds on clean reset).
- [ ] **Determinism & reproducibility** — seeding, optional network record/replay, and fixed task instances with content hashing to detect live-web drift.

## Building from source

Build and test the full workspace:

```bash
cargo test --workspace
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r test
```

Wire method names, SDK guard classes, host policy classes, and backend support states are all generated from `wire/methods.json`. After changing a wire method, regenerate the TypeScript/Rust tables and run the currentness check:

```bash
pnpm generate:wire-methods
pnpm check:wire-methods
```

Packaging, coverage, and the ignored CDP / WebExtension end-to-end gates have their own scripts and setup — see [docs/install.md](docs/install.md), [docs/troubleshooting.md](docs/troubleshooting.md), and [docs/release-checklist.md](docs/release-checklist.md).

## License

open-browser-use is MIT licensed — see [LICENSE](LICENSE). Release payloads also bundle third-party components under their upstream licenses; details are in [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).

---

<div align="center">
<sub>Built with Rust + TypeScript · driven over the Model Context Protocol · macOS / Linux public preview</sub>
</div>
