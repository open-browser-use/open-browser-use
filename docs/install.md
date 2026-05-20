# Installing open-browser-use

P4a is a macOS/Linux public-preview target. Windows is not supported by P4a.

| Platform | P4a status |
| --- | --- |
| macOS arm64 | Supported preview target |
| macOS x64 | Supported preview target |
| Linux x64 glibc | Supported preview target |
| Linux x64 musl | Supported preview target |
| Linux arm64 glibc | Supported preview target |
| Linux arm64 musl | Not published in P4a |
| Windows | Not supported in P4a |

## Preview Stance

The public npm scope is not treated as live until release verification proves it
is available. The curl-style preview path uses GitHub Release assets, not a
dedicated website URL. The planned release repository name is
`open-browser-use`; a future website can redirect to the same assets later.

## Local npm Tarballs

Build the workspace and assemble a current-platform payload:

```bash
pnpm install --frozen-lockfile
pnpm -r build
NODE_ROOT="$(node scripts/fetch-node-runtime.mjs --target current)"
node scripts/assemble-payload.mjs --node-root "$NODE_ROOT"
node scripts/payload-self-check.mjs --payload dist/payload/current
node scripts/stage-npm-packages.mjs --payload dist/payload/current
```

For local smoke testing only, `--allow-current-node` may be used instead of
`--node-root`.
Cross-target payload assembly requires explicit Rust binaries:
`--target <p4a-target> --host-bin <obu-host> --node-repl-bin <obu-node-repl>`.
When staging more than one platform package or curl artifact, repeat
`--payload <dir>` or pass `--payload-root dist/payload` after assembling
per-target payload directories.

Run the tarball smoke:

```bash
node scripts/package-local-smoke.mjs --target all --static --expect-payload current
node scripts/npm-pack-smoke.mjs --target current
```

The staged public wrapper package is in `dist/npm/cli`. It deliberately has no
Node 22 engine requirement; it only resolves the platform payload and then
launches the bundled Node from that payload.

## Local curl-Style Tarball

Create and test the tarball installer artifacts:

```bash
node scripts/make-curl-artifact.mjs
node scripts/curl-install-smoke.mjs
```

Manual local install:

```bash
sh dist/curl/install.sh \
  --artifact dist/curl/open-browser-use-<version>-<target>.tar.gz \
  --checksum <sha256> \
  --install-dir "$HOME/.obu"
```

GitHub Release preview install can auto-select the current platform from the
Release `manifest.tsv`, with `manifest.json` as an older-release fallback:

```bash
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh && \
~/.obu/bin/obu bootstrap --yes --all --agents=auto
```

**Fresh install is better for preview releases.** The current installer does
not compare the already installed payload version with the latest GitHub
Release before deciding what to do. If the local install may be stale, rerun the
fresh install command above so the latest release asset is downloaded and the
native host, extension payload, and agent wiring are refreshed together.

The future update path should make that decision explicitly: compare the local
`obu --version` / payload metadata with the latest release version, download and
install only when the release is newer, and otherwise keep the existing local
install and reconnect or repair it with `obu bootstrap`, `obu setup`, or
`obu verify --repair`.

For a Chrome Web Store-installed extension, use the Store channel so native-host
manifests allow the Store extension id instead of the unpacked-dev id:

```bash
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh && \
~/.obu/bin/obu bootstrap --yes --all --channel=store --extension-id=<store-extension-id> --agents=auto
```

Store-channel setup requires a release payload with `storeExtensionId` metadata,
or an explicit `OBU_STORE_EXTENSION_ID` / `--extension-id` override while
testing a draft item.
Use the exact id copied from the extension popup. Do not substitute the
unpacked-dev id or infer an id from another profile; Chrome native messaging
requires the manifest `allowed_origins` entry to match the installed extension:
`chrome-extension://<store-extension-id>/`.

If the CLI and MCP server are installed but browser automation is still
unavailable, verify the selected agent/browser pair. Replace `<agent-id>` with
the canonical OBU adapter id for the agent whose MCP config should be checked,
such as `codex-cli` for Codex, `claude-code` for Claude Code, `gemini-cli`,
`cursor`, or `vscode`; the full supported list is in
[Agent Configuration](#agent-configuration). If this came from the popup **Copy
for agent** handoff, use the current agent by default unless the user asks to
configure another client.

```bash
~/.obu/bin/obu verify --agent=<agent-id> --browser=chrome --channel=store --extension-id=<store-extension-id>
~/.obu/bin/obu verify --repair --agent=<agent-id> --browser=chrome --channel=store --extension-id=<store-extension-id>
```

After repair, open the open-browser-use extension popup and click **Resume** if
the browser is not connected yet. Repair can update native-host manifests and
runtime descriptor permissions, but Chrome publishes the active WebExtension
runtime descriptor only after the extension connects to the native host. Rerun
verify with the same agent/browser/channel/id after opening the popup.

Manual GitHub Release installs can still pin a specific asset and checksum:

```bash
curl -fsSLO https://github.com/<org>/open-browser-use/releases/download/<version>/install.sh
sh install.sh \
  --artifact https://github.com/<org>/open-browser-use/releases/download/<version>/open-browser-use-<version>-<target>.tar.gz \
  --checksum <sha256>
```

Installer options:

- `OBU_INSTALL_DIR` or `--install-dir` controls the install root.
- `OBU_UNMANAGED_INSTALL=1` skips shellenv PATH integration instructions.
- `--no-modify-path` skips shellenv PATH integration instructions for that run.
- `OBU_ARTIFACT` can provide the artifact path or URL.
- `OBU_ARTIFACT_SHA256` can provide the expected checksum.
- `OBU_RELEASE_BASE_URL` and `OBU_TARGET` are preview/debug overrides for the
  GitHub Release `manifest.tsv` / `manifest.json` lookup.

The release manifest contract is summarized in
[release-checklist.md](release-checklist.md).

The extension popup setup panel keeps **Copy for agent** available. Paste that
handoff into the user's coding agent; it points to
[`agent-install-prompt.md`](../prompts/agent-install-prompt.md), preserves the exact
extension id, describes the generic MCP stdio server contract, and asks the
agent to choose the right install/repair, verification, MCP wiring, and
persistent instruction steps for the current client. The agent should make
open-browser-use the primary BrowserUse/browser automation tool in the core
`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, Cursor/Claude/Codex project instructions,
or equivalent agent memory when one exists. Agents should also check known
global instruction files before falling back to a snippet, especially
`~/.codex/AGENTS.md` for Codex and `~/.claude/CLAUDE.md` for Claude Code.
The OBU adapter commands are secondary helpers for known clients. The popup
keeps this entry available after the native host connects so users can connect
another agent later.

## Setup

After installing an `obu` shim:

```bash
eval "$("$HOME/.obu/bin/obu" shellenv zsh)"
obu bootstrap --yes --all --agents=auto
obu setup --yes --agents=codex-cli,claude-code --write-instructions
obu verify --agent=codex-cli --browser=chrome
```

`--write-instructions` is opt-in. It appends the primary-browser instruction to
an existing project instruction file when one is present, otherwise it uses the
known global instruction file for supported agents such as Codex
(`~/.codex/AGENTS.md`) and Claude Code (`~/.claude/CLAUDE.md`). It preserves
existing content and skips reruns when the instruction is already present.

`obu repl` is deferred in P4a. Use `obu mcp stdio` through an MCP client; a
direct debug REPL will need its own tested command contract before it is
documented as supported.

Unpacked extension install/reload still has a browser UI boundary. If setup
returns `manual_action_required`, load or reload:

```text
~/.obu/extension/current
```

from `chrome://extensions`, then rerun:

```bash
obu verify --agent=<agent-id> --browser=chrome
```

For Chrome Web Store installs, do not run `obu update-extension`; Chrome Web
Store owns extension updates. Verify and repair the selected Store target with:

```bash
obu verify --agent=<agent-id> --browser=chrome --channel=store --extension-id=<store-extension-id>
obu verify --repair --agent=<agent-id> --browser=chrome --channel=store --extension-id=<store-extension-id>
```

If `browser_status` in an MCP client reports that the SDK is available but
`backends` is empty, MCP is configured but the browser backend is not connected.
Run `obu verify` for that same MCP client with the exact Store extension id,
repair if needed, then open the extension popup and click **Resume** so Chrome
reconnects the native host. Keep the same `--agent`, `--browser`, `--channel`,
and `--extension-id` values between repair and the final verify rerun. Use
`obu doctor browser` only when you need lower-level browser diagnostics.

## Agent Configuration

Inspect the exact MCP config for any supported client:

```bash
obu mcp-config --agent=codex-cli --print
```

Verify that an agent has both MCP wiring and the primary browser instruction:

```bash
obu agent doctor --agent=codex-cli
```

Supported adapter IDs are `codex-cli`, `claude-code`, `gemini-cli`, `vscode`,
`cursor`, `cline`, `windsurf`, `claude-desktop`, `zed`, and `continue`.
