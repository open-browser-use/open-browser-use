# Native Host Recovery UX Research

Date: 2026-05-17

This note records the deeper review behind the WebExtension popup recovery flow
and the GitHub Release installer path. It intentionally excludes GitHub URL
availability; the remaining risks are source-of-truth drift in popup advice and
the shell installer's release-manifest contract.

## Scope

Current recovery path:

```bash
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh && \
~/.obu/bin/obu setup --yes --all --skip-agents && \
~/.obu/bin/obu doctor browser --repair
```

The popup shows this command when the native host looks missing, stale, too old,
or locally repairable. The command is meant to be pasted into Terminal, after
which the user returns to the extension popup and clicks **Resume**.

## Current Flow

Native-host status is produced by
`packages/extension/src/background.ts`.

- `HostStatus.state` is the broad lifecycle: `connecting`, `connected`,
  `version_mismatch`, `stopped`, `error`, or `disconnected`.
- `HostStatus.diagnosis` is the stable repair category:
  `native_host_not_found`, `native_host_forbidden`, `native_host_crashed`,
  `native_host_disconnected`, `native_host_hello_timeout`,
  `native_host_heartbeat_timeout`, `native_host_unavailable`, or
  `version_mismatch`.
- `connectNative`, `handleNativeMessage`, hello timeout, heartbeat timeout, and
  reconnect scheduling call `setStatus`, which persists the status to
  `chrome.storage.local`.
- `packages/extension/src/popup.ts` listens to storage changes and renders the
  dot, status label, detail text, setup panel, Stop, Resume, and debug controls.

Installer status is produced by the curl artifact tooling:

- `scripts/make-curl-artifact.mjs` writes `dist/curl/manifest.json` and
  `dist/curl/manifest.tsv`.
- The JSON manifest has `schemaVersion`, `version`, `artifactPrefix`,
  `artifacts[]`, `installer`, and `shellManifest`.
- Each artifact row has `target`, `file`, `sha256`, and `size`.
- `scripts/install.sh` can still install from explicit `--artifact` and
  `--checksum`, but it can now also auto-select a current-platform artifact by
  reading `manifest.tsv` and falling back to `manifest.json`.
- `scripts/curl-install-smoke.mjs` covers explicit artifact install, env-driven
  artifact install, TSV manifest-driven auto-selection, JSON fallback, and an
  unsupported-target failure path.

## External Browser Constraints

The popup UX has to fit the browser's native-messaging model, not just this
repo's internal state names.

- Chrome requires an extension-side `nativeMessaging` permission and a
  host-side manifest that names the native application, executable path, and
  `allowed_origins` list. The browser rejects connections when the manifest is
  missing, malformed, installed in the wrong browser-specific location, points
  at a missing path, or does not allow the extension origin. Reference:
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>.
- Chrome starts a native host process for `runtime.connectNative()` and keeps it
  alive for the lifetime of the port. In extension code, the popup and service
  worker usually see startup failures through `runtime.lastError.message` and
  port disconnects, while richer startup/protocol diagnostics may live in
  Chrome's own logs. That makes a central `HostStatus.diagnosis` more reliable
  than each UI surface parsing raw messages independently.
- Chrome documents common native-messaging errors that map directly to our
  diagnosis categories: host not found, access forbidden, host exited, and
  protocol communication errors. These are setup or repair categories, but a
  repeated crash/protocol failure still needs debug logs after the first repair
  attempt.
- macOS and Linux host-manifest paths vary by browser. Chrome, Chrome for
  Testing, and Chromium use different native-host directories, and downstream
  Chromium-family browsers add more variants. This is why the popup command
  should run setup for all supported local browsers instead of guessing the
  owning browser from the popup context.
- MDN's WebExtension docs describe the same browser/native split: browsers read
  and validate the app manifest, but the native app itself is installed and
  updated by the operating-system/application installer, not by the extension.
  Reference:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>.

The key product consequence is that the extension cannot "just fix" a missing
or forbidden native host from inside the popup. It can detect, explain, and copy
an installer/setup command that repairs files on disk, then reconnect after the
user runs it.

## Fix: Popup Advice Uses One Model

The original popup implementation had three related decision points:

- `repairHint(status)` decides the inline status-detail repair sentence.
- `setupHint(status)` decides whether to show the setup panel and what it says.
- `diagnosisFromMessage(message)` repeats part of the background script's
  diagnosis regex fallback for statuses that lack `diagnosis`.

That meant the same native-host condition could drift across three user-facing
surfaces. For example, `native_host_not_found` mapped to both an inline
hint ("Install the native host manifest...") and a setup-panel hint ("Install
open-browser-use from GitHub..."). Both are valid, but future diagnosis changes
would have had to update both paths and the fallback regex.

The background service worker should remain the authority for producing
`HostStatus.diagnosis`. The popup should not independently rediscover host
failure semantics except as a compatibility fallback for old stored statuses or
Chrome-native error strings that did not receive a diagnosis.

### Code Evidence

`background.ts` already has the central semantics the popup should consume:

- `HostDiagnosis` is the closed set of native-host repair categories.
- `connectNative` assigns `native_host_unavailable`,
  `native_host_disconnected`, or a more specific result from
  `diagnoseNativeHostFailure`.
- hello and heartbeat timers assign `native_host_hello_timeout` and
  `native_host_heartbeat_timeout`.
- a host version mismatch assigns `version_mismatch`.
- stored legacy status recovery upgrades `state: "version_mismatch"` into a
  `version_mismatch` diagnosis.

The fixed `popup.ts` keeps that behavior in one helper:

- `render(status)` computes one `nativeHostAdvice(status)` object.
- `statusDetail(status, advice)` composes transient retry/deliverable notes with
  `advice.detail`.
- `renderSetup(advice)` renders only `showSetup`, `setupText`, and
  `setupCommand`; it does not choose native-host copy.
- `normalizeDiagnosis(status)` is the only popup-side compatibility fallback for
  old stored statuses or raw Chrome error strings.

This keeps `background.ts` as the source of truth for diagnosis production while
making the popup's advice copy reusable across both visible surfaces.

### Implemented Shape

Keep the render code small and drive it from one advice model:

```ts
type NativeHostAdvice = {
  detail?: string;
  setupText?: string;
  setupCommand?: string;
  showSetup: boolean;
};
```

Rendering now flows from one helper:

```ts
function nativeHostAdvice(status: HostStatus): NativeHostAdvice {
  const diagnosis = normalizeDiagnosis(status);
  // table lookup plus state-specific fallbacks
}
```

The helper should be the only place that maps diagnosis to user-facing repair
copy. `statusDetail` can still add transient retry text and deliverable-tab
recovery text, but native-host repair copy should come from the same
`nativeHostAdvice` row used by the setup panel.

Implementation boundary:

- `normalizeDiagnosis(status)` may read `status.diagnosis`, handle
  `state: "version_mismatch"`, and parse raw messages only as a legacy fallback.
- `nativeHostAdvice(status)` owns the diagnosis-to-copy table.
- `statusDetail(status)` composes transient runtime notes with
  `nativeHostAdvice(status).detail`.
- `renderSetup(advice)` only renders `showSetup`, `setupText`, and
  `setupCommand`; it does not choose copy.
- tests assert advice behavior through rendered DOM, not by snapshotting
  private helper strings.

### Recommended Diagnosis Table

| Diagnosis | Setup panel | Detail copy intent | Command |
| --- | --- | --- | --- |
| `native_host_not_found` | Yes | No manifest or host registration exists. Install open-browser-use, register native hosts, repair, then resume. | GitHub install + `obu setup --yes --all --skip-agents` + `obu doctor browser --repair` |
| `native_host_forbidden` | Yes | Installed manifest exists but does not allow this extension id, or Chrome rejected access. Reinstall manifests and repair. | Same command |
| `version_mismatch` | Yes | Extension and native host versions disagree. Update host, refresh setup, then resume. | Same command |
| `native_host_unavailable` | Yes | Startup failed without a more specific Chrome error. Repair setup and retry. | Same command |
| `native_host_crashed` | Yes | Host launched but exited or crashed. Reinstall/repair first; debug logs remain useful if it repeats. | Same command |
| `native_host_hello_timeout` | Yes | Host process did not complete the native-messaging handshake. Repair and retry. | Same command |
| `native_host_heartbeat_timeout` | Yes | A previously live host stopped responding. Repair and retry. | Same command |
| `native_host_disconnected` | No by default | Connection was lost after setup had worked or during a transient reconnect. Prefer Resume and doctor; avoid forcing reinstall as the first action. | None |
| none + `connecting` | No | Startup in progress. | None |
| none + `connected` | No | Host ready. | None |
| none + `stopped` | No | Browser control is intentionally paused. | None |

This table keeps the UX focused: the setup panel appears only when a Terminal
command is plausibly the user's next best action. It does not appear for normal
connecting, connected, stopped, or transient disconnected states.

### Related UX Notes

- The copied command uses `--skip-agents` intentionally. The extension recovery
  path should repair browser/native-host wiring without modifying a user's MCP
  client configs.
- The command uses `--all` intentionally. The popup cannot reliably know which
  Chromium-family browser owns the extension across Chrome, Chrome for Testing,
  Edge, Brave, Arc, and Chromium. `installNativeHosts` writes manifests for the
  supported browser set on the current platform.
- The command cannot reload Chrome's unpacked extension for the user. If setup
  updated `~/.obu/extension/current`, Chrome may still require a manual reload.
  The popup should keep the post-copy text precise: paste into Terminal, wait
  for doctor, then click Resume. If doctor reports loaded-path drift, the user
  follows the existing troubleshooting path.
- Stored statuses from older extension versions may lack `diagnosis`; keeping a
  small message fallback is reasonable, but it should feed only
  `normalizeDiagnosis(status)`.

### Test Expectations

Popup tests should exercise:

- setup panel hidden for `connected`, `connecting`, `stopped`, and plain
  `native_host_disconnected`;
- setup panel visible for every diagnosis in the table that maps to a Terminal
  command;
- copied command contains the GitHub install URL, `obu setup --yes --all
  --skip-agents`, and `obu doctor browser --repair`;
- copy failure reports a visible error without changing native-host state;
- state transitions from failure to connected clear the setup-panel copy status.

## Fix: Installer Manifest Has A Shell Contract

The current shell installer must work before Node is installed, so it cannot
depend on the bundled Node runtime. It also cannot assume `jq` is installed on
fresh macOS/Linux systems. That constraint makes some text parsing necessary
unless the release publishes a shell-friendly manifest.

`scripts/make-curl-artifact.mjs` now publishes `manifest.tsv` next to
`manifest.json`, and `scripts/install.sh` prefers the TSV file. The JSON parser
remains as a compatibility fallback for older releases.

The fallback `manifest_artifact_field` AWK parser is acceptable only for the
JSON shape generated by `scripts/make-curl-artifact.mjs`:

- pretty-printed JSON;
- one artifact object per line block;
- artifact object fields in insertion order: `target`, `file`, `sha256`,
  `size`;
- no nested objects inside artifact rows;
- no escaped quotes in file names or target names.

Those assumptions are true for the generated JSON manifest. They are not general
JSON parsing. A minified manifest with multiple
artifact objects on one line can make an AWK lookup match the requested target
but extract the first `file` or `sha256` field in the larger line instead of
the matching artifact row. The TSV-first path avoids that failure mode for new
releases.

### Code Evidence

The current contract is split across three files:

- `scripts/make-curl-artifact.mjs` builds `artifacts[]` from payload metadata
  and emits both `manifest.json` and `manifest.tsv`.
- `scripts/install.sh` downloads `manifest.tsv`, picks the current target with
  POSIX `awk -F '\t'`, and falls back to generated JSON only when TSV is absent.
- `scripts/curl-install-smoke.mjs` parses both manifests and exercises TSV
  install, JSON fallback install, and unsupported-target failure through
  `OBU_RELEASE_BASE_URL` and `OBU_TARGET`.

The smoke proves the generated manifest and installer currently agree. It does
not prove that `install.sh` can parse arbitrary valid JSON, and it should not
claim to. The release contract should say that the shell installer consumes the
repo-generated manifest format.

Remaining high-risk drift cases:

| Drift | Why it matters |
| --- | --- |
| Minified `manifest.json` in an older release without TSV | AWK object buffering can see multiple artifacts as one object and extract the wrong field. |
| Field order changes inside artifact rows | The parser is tolerant of order inside a buffered object, but tests should still guard the generated shape because humans may rely on it. |
| Duplicate `target` rows | Installer picks the first matching row; release should fail before upload. |
| Artifact renamed after manifest generation | Installer downloads a URL that no longer exists, or installs under an unexpected payload directory. |
| Missing `.sha256` asset | The installer can verify from `manifest.json`, but release completeness and manual pinning both degrade. |

### Recommended Contract

Treat `manifest.json` as a stable release artifact consumed by Node tools,
humans, and the shell installer. Document and enforce this generated shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO-8601 timestamp",
  "version": "0.1.0",
  "artifactPrefix": "open-browser-use",
  "artifacts": [
    {
      "target": "darwin-arm64",
      "file": "open-browser-use-0.1.0-darwin-arm64.tar.gz",
      "sha256": "...",
      "size": 123
    }
  ],
  "installer": "install.sh",
  "shellManifest": "manifest.tsv"
}
```

The installer-readable contract is narrower than the JSON schema:

- `schemaVersion` must be `1`.
- `artifacts` must contain at most one row for each supported target.
- Each artifact row must be emitted as a separate pretty-printed object block.
- Within a row, `target`, `file`, and `sha256` must be string fields.
- The release publisher must upload `manifest.json`, `manifest.tsv`,
  `install.sh`, each artifact tarball, and each `.sha256` file to the same
  GitHub Release asset directory.

The release checklist should reject a curl artifact set unless:

- `manifest.json` parses as JSON and has `schemaVersion: 1`;
- every artifact row has a unique supported target;
- `manifest.tsv` has the exact header `target<TAB>file<TAB>sha256<TAB>size`;
- JSON and TSV rows agree exactly;
- every `file` exists next to the manifest;
- every `sha256` equals the actual tarball checksum;
- every `<file>.sha256` exists and agrees with the manifest;
- `scripts/install.sh` can install through manifest lookup from a local
  `OBU_RELEASE_BASE_URL`;
- unsupported targets fail with a clear "no artifact for target" message.

### Shell Manifest Shape

The shell-oriented manifest is intentionally small:

```text
target	file	sha256	size
darwin-arm64	open-browser-use-0.1.0-darwin-arm64.tar.gz	...	123
linux-x64-gnu	open-browser-use-0.1.0-linux-x64-gnu.tar.gz	...	456
```

`install.sh` parses one tab-separated row with POSIX `awk -F '\t'` instead of
pretending to parse JSON. `manifest.json` remains the richer artifact for Node
smoke tests, release metadata, and human inspection. The shell installer
prefers TSV when available and falls back to JSON only for compatibility.

The TSV rules are deliberately boring:

- first line is the header: `target<TAB>file<TAB>sha256<TAB>size`;
- no tabs or newlines are allowed in values;
- `target` is a known P4a target triple;
- `file` must be a basename, not a path or URL;
- `sha256` must be exactly 64 lowercase hex characters;
- `size` is decimal bytes.

An alternative would be a release-specific `install.sh` with an embedded
target-to-file/checksum `case` table. That would remove one network request, but
it would also make the installer asset generated rather than copied verbatim
from `scripts/install.sh`.

### Security And Reliability Notes

- The manifest checksum model protects the downloaded artifact from corruption
  or mismatch after the manifest is fetched. It does not protect against a
  compromised GitHub Release that serves both a malicious manifest and tarball.
  That is the normal trust boundary for a `curl | sh` preview installer.
- Explicit `--artifact` without `--checksum` remains useful for local smoke
  loops, but public docs should prefer manifest auto-selection or explicit
  `--checksum`.
- `detect_target` intentionally emits `linux-arm64-musl` on musl arm64 even
  though P4a does not publish that artifact. The resulting "no artifact for
  target" error is correct and clearer than silently choosing a glibc payload.
- The installer should preserve the artifact filename when downloading. The
  installed payload directory name is derived from the artifact filename, so
  losing the original name can cause every remote install to land in a generic
  payload directory.

### Test Expectations

Release/install smokes should cover:

- generated `manifest.json` has `schemaVersion: 1`, `shellManifest` set to
  `manifest.tsv`, unique supported targets, and artifact files/checksums that
  exist;
- generated `manifest.tsv` has the expected header and rows that agree with
  `manifest.json`;
- `sh -n scripts/install.sh`;
- explicit `--artifact --checksum`;
- env-driven `OBU_ARTIFACT` and `OBU_ARTIFACT_SHA256`;
- TSV manifest-driven install with `OBU_RELEASE_BASE_URL` pointing at a local
  `dist/curl` directory;
- JSON fallback install when `manifest.tsv` is absent;
- a negative case for unsupported targets, especially `linux-arm64-musl`;
- if JSON remains the shell source, a guard that rejects or catches minified
  manifest drift before release.

## Remaining Follow-Up

1. Keep `background.ts` as the source of truth for diagnosis generation.
   Popup message regex fallback should exist only inside `normalizeDiagnosis`.
2. Keep release-manifest contract checks in `curl-install-smoke.mjs` so future
   formatting drift fails before publish.
3. Remove the generated-JSON fallback only after there are no older public
   releases that need it.
4. Link this document from install/troubleshooting docs whenever changing
   native-host recovery UX or curl artifact publishing.
