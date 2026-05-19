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

For a Chrome Web Store-installed extension, use the Store channel so native-host
manifests allow the Store extension id instead of the unpacked-dev id:

```bash
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh && \
~/.obu/bin/obu bootstrap --yes --all --channel=store --extension-id=<store-extension-id> --agents=auto
```

Store-channel setup requires a release payload with `storeExtensionId` metadata,
or an explicit `OBU_STORE_EXTENSION_ID` / `--extension-id` override while
testing a draft item.

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

See [native-host-recovery-ux.md](native-host-recovery-ux.md) for the popup
recovery UX rationale and the release manifest contract.

The extension popup setup panel keeps **Copy for agent** available. Paste that
handoff into the user's coding agent; it points to
[`agent-install-prompt.md`](../prompts/agent-install-prompt.md), preserves the exact
extension id, describes the generic MCP stdio server contract, and asks the
agent to choose the right install/repair, verification, MCP wiring, and
persistent instruction steps for the current client. The agent should make
open-browser-use the primary BrowserUse/browser automation tool in the core
`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, Cursor/Claude/Codex project instructions,
or equivalent agent memory when one exists. The OBU adapter commands are
secondary helpers for known clients. The popup keeps this entry available after
the native host connects so users can connect another agent later.

## Setup

After installing an `obu` shim:

```bash
eval "$("$HOME/.obu/bin/obu" shellenv zsh)"
obu bootstrap --yes --all --agents=auto
obu setup --yes --agents=codex-cli,claude-code
obu doctor
```

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
obu doctor
```

For Chrome Web Store installs, do not run `obu update-extension`; Chrome Web
Store owns extension updates. Use:

```bash
obu doctor browser --channel=store
obu doctor browser --repair --channel=store
```

## Agent Configuration

Inspect the exact MCP config for any supported client:

```bash
obu mcp-config --agent=codex-cli --print
```

See [agent-adapters.md](agent-adapters.md) for all adapter IDs and write
strategies.
