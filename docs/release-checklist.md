# open-browser-use P4 Release Checklist

P4a supports macOS and Linux only. Do not publish Windows npm packages or curl
targets until a dedicated Windows runtime milestone is complete.

## Release Stance

Current stance: preview.

- Public npm scope/package access for `@open-browser-use/*` is not verified here.
- Curl-style preview installs use GitHub Release assets, not a dedicated
  website URL.
- Docs and smoke tests must use local tarballs or GitHub Release artifacts until
  npm publication is verified.
- Planned GitHub Release repository name: `open-browser-use`.

## Build

Pinned Node runtime for P4a: Node.js `v22.22.0`.

Official source index:

```text
https://nodejs.org/download/release/v22.22.0/
```

Official `SHASUMS256.txt` entries used for supported upstream tarballs:

| Target | Node archive | SHA-256 |
| --- | --- | --- |
| darwin-arm64 | `node-v22.22.0-darwin-arm64.tar.gz` | `5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640` |
| darwin-x64 | `node-v22.22.0-darwin-x64.tar.gz` | `5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce` |
| linux-x64-gnu | `node-v22.22.0-linux-x64.tar.gz` | `c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744` |
| linux-arm64-gnu | `node-v22.22.0-linux-arm64.tar.gz` | `25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be` |

Linux musl source:

```text
https://unofficial-builds.nodejs.org/download/release/v22.22.0/
```

| Target | Node archive | SHA-256 |
| --- | --- | --- |
| linux-x64-musl | `node-v22.22.0-linux-x64-musl.tar.gz` | `5618c83f81bdf51ac7fdfdf5bd6e179c15294b10ae4af13c028a27d54a0bd780` |

The musl archive is Node-hosted but comes from `unofficial-builds.nodejs.org`;
verify that this source is acceptable before public publish.

Fetch a pinned Node runtime root:

```bash
node scripts/fetch-node-runtime.mjs --target current
node scripts/fetch-node-runtime.mjs --target linux-x64-musl
```

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm -r test
pnpm -r build
cargo test -p obu-wire -p obu-node-repl -p obu-host --lib --tests --no-fail-fast
```

Verify the pinned cargo-dist release plan:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/axodotdev/cargo-dist/releases/download/v0.31.0/cargo-dist-installer.sh | \
  CARGO_DIST_NO_MODIFY_PATH=1 CARGO_HOME="$PWD/.cache/cargo-dist-home" sh
CARGO_DIST_BIN="$PWD/.cache/cargo-dist-home/bin/cargo-dist" \
  node scripts/cargo-dist-smoke.mjs
node scripts/p4-release-readiness-smoke.mjs
```

The P4 packaging CI includes a `p4-target-payloads` matrix for the five P4a
targets. Each matrix leg builds target Rust binaries, fetches the pinned Node
runtime for that target, assembles a payload, runs `payload-self-check`, stages
the matching npm package, and runs static package/tarball checks. Runner-native
targets also run dynamic npm and curl install smokes. Every matrix leg uploads
the generated `open-browser-use-<version>-<target>.tar.gz`, `.sha256`,
`install.sh`, and manifest as a GitHub Actions artifact for GitHub Release
promotion.

Assemble the current-platform preview payload:

```bash
node scripts/assemble-payload.mjs --node-root /path/to/node-22.22-or-newer
node scripts/payload-self-check.mjs --payload dist/payload/current
```

`--allow-current-node` is for local smoke payloads only. Release payloads must
use a full Node 22.x distribution at or above `22.22.0`.
For non-current P4a targets, pass `--target <p4a-target> --host-bin
</path/to/obu-host> --node-repl-bin </path/to/obu-node-repl>` with binaries
built for that target; the assembler refuses cross-target payloads unless both
Rust binaries are explicit.
`stage-npm-packages.mjs` and `make-curl-artifact.mjs` accept repeated
`--payload <dir>` inputs, or `--payload-root <dir>` to scan immediate child
payload directories, and attach each payload/artifact to the target from its
`metadata.targetTriple`.

## npm Preview Packages

```bash
node scripts/stage-npm-packages.mjs --payload dist/payload/current
node scripts/npm-wrapper-resolver-smoke.mjs
node scripts/package-local-smoke.mjs --target all --static --expect-payload current
node scripts/npm-pack-smoke.mjs --target current
```

Verify:

- staged `@open-browser-use/cli` has no `engines.node >=22.22.0`;
- staged `@open-browser-use/cli` only contains `bin/obu` and wrapper metadata;
- platform package contains the full payload;
- platform package bundles `@open-browser-use/sdk` and `jsonc-parser`;
- no Windows platform package exists.
- `obu repl` exits with the P4a deferred-command message until a direct debug
  REPL contract is implemented and tested.

NPM publish order for a production release:

1. Publish all platform payload packages first:
   `@open-browser-use/cli-darwin-arm64`, `@open-browser-use/cli-darwin-x64`,
   `@open-browser-use/cli-linux-x64-gnu`, `@open-browser-use/cli-linux-x64-musl`, and
   `@open-browser-use/cli-linux-arm64-gnu`.
2. Verify each platform package appears on npm with the expected version and
   tarball checksum.
3. Publish the wrapper package `@open-browser-use/cli` last, after all optional dependency
   targets are available.
4. Install `@open-browser-use/cli` from npm in a fresh temp prefix with optional
   dependencies enabled and run the npm tarball smoke against that install.
5. Do not publish any Windows package in P4a.

## curl Preview Artifact

```bash
node scripts/make-curl-artifact.mjs
sh -n scripts/install.sh
node scripts/curl-install-smoke.mjs
node scripts/setup-local-spine-smoke.mjs
```

Verify installer support for:

- checksum verification;
- `OBU_INSTALL_DIR`;
- `OBU_UNMANAGED_INSTALL`;
- `--no-modify-path`;
- stable `bin/obu` shim pointing at `payloads/current`.
- packaged `obu doctor --json` payload integrity checks and `obu mcp stdio`
  initialize/list-tools through the installed shim.
- installed-payload `obu setup --yes --skip-agents` and
  `obu setup --yes --agents=codex-cli` using a fake Codex CLI.

Payload metadata must include `extensionZip`, `extensionZipSha256`,
`extensionId`, and `extensionChannel`; `node scripts/payload-self-check.mjs`
verifies that the recorded extension zip checksum matches the staged file.
The root MIT `LICENSE` must ship in every payload. `LICENSE-THIRD-PARTY.md`
must include notices for the bundled Node.js runtime, `jsonc-parser`, and the
vendored Playwright InjectedScript, and the payload self-check must confirm
that both license files are present in every payload.

## Manual Browser Gate

Run from a fresh temp home with Chrome or Chrome for Testing:

```bash
obu setup --yes --skip-agents
obu doctor --json
obu doctor --strict --json
```

Then load or reload the unpacked extension from:

```text
~/.obu/extension/current
```

The extension must publish a WebExtension runtime descriptor, and
`agent.browsers.get("chrome")` must complete a browser task.
The automated `setup-webext-e2e.mjs` path also wires a fake Codex CLI with
`obu setup --yes --agents=codex-cli` before launching Chrome for Testing.
`obu doctor --strict` must exit nonzero on warnings as well as failures; use the
non-strict command for interactive troubleshooting where warnings are advisory.
Before manual testing, enable extension popup Debug logs, reproduce one browser
task, copy the JSON report, and confirm it includes status changes plus
`native.request` / `host.request.ok` events. Clear logs after capture.

## Agent Gate

At minimum, test:

```bash
obu setup --yes --agents=codex-cli
obu setup --yes --agents=claude-code
obu setup --yes --agents=cursor
```

For direct-edit adapters, rerun setup and confirm unchanged configs do not
create new backups.

MCP/browser-use compatibility gates:

- `tools/list` shows `js`, `browser_status`, `js_reset`, and
  `js_add_module_dir`, and `initialize` advertises both tools and resources.
- `browser_status` returns SDK bootstrap state, discovered backends,
  diagnostics, runtime dir, and a doctor hint without leaking descriptor auth
  tokens or capability tokens.
- A `display({ __obuImage: true, mime_type, data })` call returns a resource
  link, and `resources/read` fetches the artifact bytes.
- A huge `console.log` or huge final result stays bounded and sets the matching
  `structuredContent.truncated` flag.
- Codex CLI, Claude Code, and Cursor are checked for `structuredContent`,
  concise text fallback, progress notifications, and resource-link behavior.

## Rollback

If a preview release is bad:

1. Stop publishing the wrapper package version first; the wrapper is the public
   entry point that pulls optional platform payload packages.
2. Deprecate the bad npm version with an explicit install message that points to
   the last known-good version.
3. Remove or replace the bad GitHub Release installer assets and update the
   release notes to mark the version withdrawn.
4. Repoint any preview install page or GitHub Release instructions to the last
   known-good artifact set.
5. Confirm a fresh temp-prefix install of the last known-good npm and curl
   artifacts still passes `obu --version`, `obu doctor --json`, and MCP
   initialize/list-tools.
6. Keep `~/.obu/extension/current` stable: rollback by reinstalling a prior
   extension payload into that path, not by asking users to load a versioned
   cache directory directly.
