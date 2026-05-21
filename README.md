# open-browser-use

open-browser-use is an open computer-use stack for local agents. It includes the Rust
host daemon, the `obu-node-repl` native-pipe broker integration, the
agent-facing `@open-browser-use/sdk`, a raw CDP backend, and a Chromium MV3 extension path
for driving an installed browser profile without `--remote-debugging-port`.

## Workspace

| Path | Purpose |
| --- | --- |
| `crates/obu-wire` | Shared JSON-RPC framing, envelopes, and error constants. |
| `crates/obu-host` | Per-session broker daemon and browser backend dispatcher. |
| `crates/obu-node-repl` | MCP JavaScript runtime with trusted SDK/native-pipe support. |
| `packages/sdk` | Agent-facing TypeScript SDK. |
| `packages/cli` | User-facing setup, readiness, and diagnostics commands such as `obu verify`. |
| `packages/extension` | Chromium MV3 extension and dev native-host manifest writer. |
| `docs/install.md` | Preview install, setup, and agent wiring guide. |

## Install Preview

P4a release packaging is macOS/Linux preview work. Until the public npm scope is
verified, use local or GitHub Release artifacts rather than documenting npm as
live. The curl-style preview path is GitHub Release assets, not a dedicated
website URL. The planned release repository name is `open-browser-use`.

Local npm tarball smoke:

```bash
pnpm -r build
node scripts/assemble-payload.mjs --allow-current-node
node scripts/stage-npm-packages.mjs --payload dist/payload/current
node scripts/package-local-smoke.mjs --target all --static --expect-payload current
node scripts/npm-pack-smoke.mjs --target current
```

Local curl-style artifact smoke:

```bash
node scripts/make-curl-artifact.mjs
node scripts/curl-install-smoke.mjs
```

For real release payloads, pass `--node-root /path/to/node-22.22-or-newer` to
`scripts/assemble-payload.mjs`; `--allow-current-node` is only for local smoke
payloads.

See [docs/install.md](docs/install.md), [docs/troubleshooting.md](docs/troubleshooting.md),
and [docs/release-checklist.md](docs/release-checklist.md). Chrome Web Store
submission notes live in
[docs/chrome-web-store-review-pack.md](docs/chrome-web-store-review-pack.md).

Project source is MIT licensed. See [LICENSE](LICENSE).

Third-party notices for vendored and packaged runtime components are in
[LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).

## Build and Test

```bash
cargo test --workspace
pnpm -C packages/sdk build
pnpm -C packages/sdk typecheck
pnpm -C packages/sdk test
pnpm -C packages/cli build
pnpm -C packages/cli test
pnpm -C packages/extension build
pnpm -C packages/extension test
```

Coverage entry points:

```bash
pnpm coverage:sdk
pnpm coverage:extension
pnpm coverage:rust
pnpm coverage
```

`pnpm coverage:sdk` writes the Vitest HTML report to
`packages/sdk/coverage/`. `pnpm coverage:extension` writes the c8 HTML report to
`packages/extension/coverage/` for the built MV3 JavaScript. `pnpm coverage:rust`
requires `cargo-llvm-cov`; install it with `cargo install cargo-llvm-cov
--locked` if the command is missing. By default the Rust coverage script prints
a summary; pass cargo-llvm-cov flags through the script for other formats, for
example:

```bash
pnpm coverage:rust -- --html
```

Ignored CDP E2E tests require a Chromium instance with remote debugging enabled:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless \
  --remote-debugging-port=9223 \
  --user-data-dir="$(mktemp -d /tmp/obu-chrome.XXXXXX)" \
  --no-first-run \
  --no-default-browser-check \
  --remote-allow-origins='*' \
  about:blank

cargo build -p obu-node-repl
OBU_CDP_URL=http://127.0.0.1:9223 \
  cargo test -p obu-host --test e2e_node_repl_to_chromium -- --ignored
```

Or run the scripted gate, which starts headless Chrome on `9223` when one is not
already listening:

```bash
scripts/p2-e2e.sh
```

WebExtension development installs use the fixed unpacked extension ID from
`packages/extension/public/manifest.json` and a native-messaging manifest:

```bash
cargo build -p obu-host
pnpm -C packages/extension build
pnpm -C packages/extension dev:manifest -- --browser chrome
```

Load `packages/extension/dist` unpacked, then run `obu-node-repl`; Chromium
family calls such as `agent.browsers.get("chrome")` prefer the discovered
WebExtension backend. The ignored end-to-end helper is:

```bash
scripts/p3-webext-e2e.sh
```

For that helper, use Chrome for Testing or Chromium. Branded Google Chrome is
kept for the manual `chrome://extensions` path and is rejected by the scripted
E2E unless `OBU_WEBEXT_E2E_ALLOW_BRANDED=1` is set. To prepare a local Chrome
for Testing binary in `~/.cache/open-browser-use-browsers`, run:

```bash
scripts/ensure-chrome-for-testing.sh
```

The scripted gate can also install/use that binary automatically:

```bash
OBU_WEBEXT_E2E_AUTO_INSTALL=1 scripts/p3-webext-e2e.sh
```

To verify browser/profile/extension/native-host setup and reconnect state for a
selected agent/browser pair, build the CLI and run `obu verify`:

```bash
pnpm -C packages/cli build
node packages/cli/dist/index.js verify --agent=codex-cli --browser chrome
node packages/cli/dist/index.js verify --agent=codex-cli --browser chrome --json
node packages/cli/dist/index.js verify --repair --agent=codex-cli --browser chrome
```

`obu verify` returns one readiness result and one next action. Use
`doctor browser` as a lower-level diagnostic when you need browser-only details.
`verify --repair` delegates browser-side repair to `doctor browser`, refreshes
agent MCP wiring for the selected agent, and then re-evaluates readiness for the
same target.
The browser doctor JSON output includes runtime descriptor lifecycle diagnostics
from `getInfo`; stale session reasons, compact deliverable tab summaries, and
deliverable recovery hints are also summarized in the human report. A reachable
runtime descriptor is reported as `WARN`, not `PASS`, when host lifecycle
diagnostics contain stale sessions, tabs, file chooser handles, or download
handles. Browser doctor repair performs conservative local repairs: it can
regenerate an invalid native-host manifest through a wrapper script, create the
runtime descriptor directory, and chmod descriptor directories/files back to
owner-only modes. It can also remove stale WebExtension runtime descriptors
whose recorded process is gone, whose socket path is clearly invalid, whose
descriptor auth is rejected, or whose `getInfo` probe is inconsistent. When a
live descriptor reports stale lifecycle diagnostics, repair asks the host to
clear those acknowledged stale diagnostic tombstones and then probes again.
Inside the SDK, `agent.browsers.diagnostics()` returns ignored runtime
descriptor reasons surfaced by `obu-node-repl`, and no-backend errors include
those reasons before pointing back to `obu verify`. Durable tabs
finalized as deliverables can be inspected and reclaimed with
`await browser.deliverables()` and each returned handle's `claim()` method.
Acknowledged stale lifecycle diagnostics can also be cleared from host apps with
`await browser.clearLifecycleDiagnostics()`.
For extension-side debugging, open the extension popup, enable **Debug logs**,
reproduce the issue, then click **Copy** to collect the local JSON debug report.

## Local Host Policy

open-browser-use does not call a remote URL or product-policy service. SDK guards and
`obu-host` policy are local and permissive by default. Deployments that need a
stricter local host policy can opt in with environment variables:

| Variable | Effect |
| --- | --- |
| `OBU_HOST_POLICY_DENY_ORIGINS` | Comma/semicolon-delimited URL origins blocked for navigation and current-origin commands, for example `https://example.com;https://admin.example`. |
| `OBU_HOST_POLICY_DENY_CDP_METHODS` | Comma/semicolon-delimited raw CDP methods to block. Use `*` to block all raw CDP. |
| `OBU_HOST_POLICY_BLOCK_HISTORY` | Blocks browser history reads when set to `1`, `true`, `yes`, or `on`. |
| `OBU_HOST_POLICY_BLOCK_DOWNLOADS` | Blocks download commands when set to `1`, `true`, `yes`, or `on`. |
| `OBU_HOST_POLICY_BLOCK_UPLOADS` | Blocks upload commands when set to `1`, `true`, `yes`, or `on`. |
| `OBU_GUARD_MODE=disabled` | Local/testing bypass for SDK and host policy checks. |

SDK callers can install local hooks per browser handle:

```ts
import { Guards } from "@open-browser-use/sdk";

const browser = await agent.browsers.get("chrome", {
  guards: new Guards({
    checkNavigation(url) {
      if (url.startsWith("https://admin.example/")) throw new Error("navigation blocked");
    },
    checkDownload(tabId, url) {
      if (url?.endsWith(".exe")) throw new Error(`download blocked for tab ${tabId ?? "unknown"}`);
    },
    checkUpload(_tabId, paths) {
      if (paths.some((path) => path.includes("/secrets/"))) throw new Error("upload blocked");
    },
  }),
});
```

The SDK hook surface covers navigation targets, current-origin commands,
history, downloads, uploads, and raw CDP calls. Hooks run in the local agent
process; the default implementation makes no network policy request.

## Third-party Notices

open-browser-use project source is MIT licensed. Release payloads also carry
third-party components under their upstream licenses. The repository currently
bundles Apache-2.0 Playwright InjectedScript in
`crates/obu-host/vendored/playwright-injected.js`; see
[LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md) for the upstream license text
and pinned source details.
