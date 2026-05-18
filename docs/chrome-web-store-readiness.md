# Chrome Web Store Readiness Gaps

Date: 2026-05-17

This note records the remaining gaps between the current preview implementation
and a complete Chrome Web Store user experience. It assumes the user installs
the extension from Chrome Web Store, opens the popup, copies the Terminal
command, and ends with a working native-host connection.

## Bottom Line

2026-05-17 implementation update:

- Repo-side Store channel support is implemented for `setup`, `install-host`,
  `doctor browser`, and `doctor browser --repair`.
- Store-channel commands require a configured Store extension id from
  `--extension-id`, `OBU_STORE_EXTENSION_ID`, persisted user config, or payload
  metadata. They fail loudly when the id is missing.
- Store builds of the popup copy `--channel=store` setup and repair commands.
- `scripts/make-extension-store-artifact.mjs` generates and validates the Store
  upload zip separately from the unpacked-dev payload zip, and omits
  `manifest.key` because Chrome Web Store rejects uploads that include it.
- Permission justifications, data-handling notes, and reviewer instructions are
  drafted in `docs/chrome-web-store-review-pack.md`.
- The Chrome Web Store draft item creation, final id verification, and
  clean-profile Store install gate remain external release tasks.

The current branch is close for the unpacked-development flow. It is not yet a
complete Chrome Web Store flow.

Current readiness:

| Flow | Status | Reason |
| --- | --- | --- |
| Local developer loads `packages/extension/dist` unpacked | Mostly ready | Stable dev extension id, native host setup, popup recovery, and icon assets are in place. |
| User installs GitHub Release CLI then loads unpacked extension manually | Mostly ready | Installer and popup command cover this, but manual extension load remains required. |
| User installs extension from Chrome Web Store and runs copied Terminal command | Repo-side ready; externally blocked | Store-channel setup/doctor/repair/popup commands are implemented, but the final Store item id and clean-profile Store install gate still need Chrome Web Store verification. |
| Store submission package/review | Repo-side draft ready; externally blocked | Store artifact generation and review notes exist, but listing assets, privacy policy URL, Store draft upload, and final reviewer submission remain release tasks. |

## Official Constraints

Primary references:

- Chrome native messaging:
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Chrome manifest `key`:
  <https://developer.chrome.com/docs/extensions/reference/manifest/key>
- Chrome Web Store publish flow:
  <https://developer.chrome.com/docs/webstore/publish>
- Chrome Web Store program policies:
  <https://developer.chrome.com/docs/webstore/program-policies/policies>

Relevant constraints:

- A native host manifest must allow a concrete extension origin:
  `chrome-extension://<extension-id>/`. This is not a wildcardable relationship.
- The browser validates the native host manifest outside the extension. The
  extension cannot install or repair that manifest by itself.
- The extension id is derived from the extension public key. The Store item id
  must be known and stable before generating native host manifests for Store
  users.
- Chrome Web Store publishing is more than a zip upload. The listing, privacy
  disclosures, permission justifications, test instructions, and review posture
  all matter.

## Current Repo Facts

Extension package:

- `packages/extension/public/manifest.json` has a fixed `key`; local tests
  derive dev id `fblnfcjnjklpgnmfnngcihbcgojnpadj`.
- The manifest now has icon assets for Chrome surfaces.
- Permissions are intentionally broad: `nativeMessaging`, `debugger`, `tabs`,
  `tabGroups`, `scripting`, `storage`, `history`, `downloads`, `alarms`, plus
  `<all_urls>` host access and an all-URLs content script.
- `scripts/assemble-payload.mjs` builds and zips the extension under the CLI
  payload, records `extensionChannel: "unpacked-dev"` by default, and can
  include Store id metadata with `--store-extension-id`.

CLI/setup:

- `packages/cli/src/index.ts` accepts `unpacked-dev` and `store`.
- `obu setup --channel=store` installs native-host manifests for the Store
  extension id, persists the channel/id, and skips `updateExtension`.
- `update-extension` is rejected for Store channel because Chrome Web Store owns
  Store extension updates.
- `install-host` and `setup` resolve the Store id from `--extension-id`,
  `OBU_STORE_EXTENSION_ID`, user config, payload metadata, or verified repo
  release metadata.

Doctor:

- `doctor` and `doctor browser` resolve the extension channel/id before running.
- `doctor browser --channel=store` checks Chrome Preferences for the Store
  extension id and enabled state without requiring an unpacked path.
- `doctor browser --repair --channel=store` writes native host manifests for the
  Store extension id.
- Doctor JSON reports the channel, extension id, and id source.

Popup:

- Unpacked-dev popup builds copy the local preview recovery command:

```bash
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh && \
~/.obu/bin/obu setup --yes --all --skip-agents && \
~/.obu/bin/obu doctor browser --repair
```

- Store popup builds copy the Store-channel recovery command:

```bash
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh && \
~/.obu/bin/obu setup --yes --all --skip-agents --channel=store && \
~/.obu/bin/obu doctor browser --repair --channel=store
```

## P0 Gaps

### 1. Store Extension ID Is Not Established In The Product Contract

The native host manifest depends on a concrete extension id. Today the dev id is
derived from `packages/extension/public/manifest.json`, but a Chrome Web Store
item id must be verified before public use.

Risk:

- If the Store item id differs from the current dev id, the native host manifest
  produced by `obu setup` will allow the wrong origin.
- Chrome will reject `runtime.connectNative()` from the Store extension with a
  forbidden or host-access error.

Required work:

1. Create a Chrome Web Store draft item.
2. Upload an initial Store artifact and inspect the dashboard item id/public key.
3. Decide the canonical id source:
   - Store upload artifact behavior must be verified against the dashboard id.
   - Local/unpacked artifacts should use the Store public key only if local dev
     and Store ids are intentionally meant to match.
4. Add release metadata for `storeExtensionId`, `extensionChannel`, and the
   explicit note that the Store upload artifact omits `manifest.key`.
5. Add a test that native host manifests for `store` include
   `chrome-extension://<STORE_EXTENSION_ID>/`.

Repo-side status: release metadata exists with `store.storeExtensionId: null`
and `store.storeDraftVerified: false`, and Store native-host tests cover an
explicit Store id. The remaining blocker is the external Chrome Web Store draft
item/id verification.

### 2. Store Channel In CLI Setup Is Implemented Repo-Side

Store users need a setup flow that installs local native host manifests for the
Store extension id without staging or asking the user to load an unpacked
extension. The repo now implements this with `obu setup --channel=store`.

Previously:

- The popup command led Store users through dev setup semantics.
- `setup` may install native hosts for the wrong id, then overwrite or refresh
  `~/.obu/extension/current` even though the user is using a Store extension.

Implemented work:

- `obu setup --channel=store` is supported.
- For `store`, setup skips `updateExtension`; the extension is installed by
  Chrome Web Store, not by the CLI.
- Native host manifests are installed using the Store extension id.
- Channel/id are persisted in user config or release metadata so later `doctor` and
  `repair` do not fall back to the dev id.
- Store popup builds use the Store channel command:

```bash
curl -fsSL https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh | sh && \
~/.obu/bin/obu setup --yes --all --skip-agents --channel=store && \
~/.obu/bin/obu doctor browser --repair --channel=store
```

Remaining release dependency: the command depends on a release payload that
records the final Store extension id.

### 3. Doctor/Repair Is Channel-Aware Repo-Side

`doctor browser` still checks whether an unpacked-dev extension is loaded from
`~/.obu/extension/current`, but Store mode now checks for the Store extension id
without requiring that path.

Previously:

- A healthy Store extension can be reported as stale/missing because it does not
  have an unpacked path.
- `doctor browser --repair` can repair native host manifests for the dev id
  instead of the Store id.

Implemented work:

- Channel-aware doctor behavior is implemented.
- In `store` mode, doctor checks that Chrome Preferences contain the Store
  extension id and that it is enabled, but does not require the unpacked path to equal
  `~/.obu/extension/current`.
- In `store` mode, native host manifest repair uses the Store id.
- Doctor JSON reports channel, extension id, and extension id source.

### 4. Doctor Channel Argument Is Enforced

`--channel` is parsed globally and `runDoctor` resolves the channel/id target
before running checks. A command such as:

```bash
obu doctor browser --repair --channel=store
```

now either runs Store-aware checks or fails loudly if the Store id is missing.

Previously:

- The setup command can include `--channel=store` before doctor actually honors
  it.
- A partial Store implementation can repair or validate the wrong extension id
  without producing an obvious error.

Implemented work:

- `doctor browser --channel=store` either fails loudly when no Store id is
  configured or runs Store-aware checks.
- Tests cover `doctor browser --channel=store` behavior and aggregate
  `doctor --channel=store` JSON.
- Doctor JSON includes channel and extension id source.

### 5. Popup Command Is Channel-Aware

The popup command is selected at build time. Local preview builds keep the
unpacked-dev command; Store builds copy a command with `--channel=store`.

Previously:

- The copied command appears to complete successfully but leaves the Store
  extension unable to connect.
- The user receives setup instructions that mention or trigger unpacked
  extension reload behavior.

Implemented work:

- The build script configures the popup with the intended extension channel.
- Store builds copy a Store-specific command.
- The current unpacked-dev command remains the dev/unpacked artifact command.
- Popup tests cover both channel commands.

### 6. Permission, Privacy, And Review Pack Is Drafted

The extension asks for broad and sensitive capabilities. The product likely
needs many of them, but Chrome Web Store review needs a precise story before the
Store flow can be considered ready.

Current sensitive surfaces:

- `debugger` for CDP control.
- `<all_urls>` host permissions and all-URLs content scripts.
- `history` and `downloads`.
- `nativeMessaging`.
- `tabs`, `tabGroups`, and `scripting`.

Risk:

- Store review can reject or delay the extension if permissions are not narrowly
  justified.
- Users will see strong permission warnings.
- Even if native-host setup works technically, the Store release is blocked
  until privacy disclosures and reviewer instructions are ready.

Implemented work:

- Permission justifications per permission and per host permission are drafted
  in `docs/chrome-web-store-review-pack.md`.
- Data read/transmitted/stored-local/not-uploaded notes are drafted.
- Optional-permission posture is documented for the first Store draft.
- Review notes explain the local agent/native-host architecture and
  why `debugger` and `<all_urls>` are core to browser automation.
- Remaining release dependency: prepare the final privacy policy URL/disclosure
  fields required by the Store submission flow.

## P1 Gaps

### 7. Store Artifact Is A First-Class Release Output

The payload contains an unpacked-preview extension zip. The release process now
also has a dedicated Chrome Web Store upload artifact gate.

Risk:

- A zip intended for local/unpacked payloads may be uploaded without the exact
  Store manifest shape.
- Store upload can drift from the tested extension bundle.

Implemented work:

- `scripts/make-extension-store-artifact.mjs` generates the Store upload artifact.
- The Store artifact script validates zip contents: `manifest.json`, generated
  JS/CSS/HTML, icons, no source logo previews, no test files, no stale `dist`
  leftovers.
- The Store upload manifest omits `key`; Chrome Web Store rejects uploads that
  include a manifest `key` field.
- Release checklist steps cover draft upload, item id verification, review
  submission, and rollback.

### 8. Native Host Name Still Reads As Development

The native messaging host name is `dev.obu.host`.

Risk:

- It is valid for development, but it is not ideal for a public Store product
  and can appear in Chrome errors or local manifest files.
- Renaming later creates migration and cleanup work.

Required work:

- Decide whether P4/public should keep `dev.obu.host` for compatibility or move
  to a production host name before first public Store release.
- If renaming, add migration cleanup for old manifests/wrappers and update
  extension/native host tests together.

### 9. Store Install UX Still Needs Manual Verification

The intended public flow spans Chrome Web Store, local GitHub installer, native
host registration, browser preferences, extension service worker, and popup
state recovery. Automated smokes cover parts of this, but not the actual Store
install path.

Required work:

- Create a manual release gate with a Chrome Web Store draft/unlisted item.
- On a clean Chrome profile, install from the Store listing, open popup, run the
  copied command, click Resume, and verify `connected`.
- Run the same on macOS arm64, macOS x64 if available, and at least one Linux
  glibc target before broad release.
- Capture expected screenshots/statuses for support docs.

## P2 Gaps

### 10. Store Listing Assets And Support Docs Are Missing

Needed before submission:

- Store name, short description, detailed description, category, language.
- Screenshots and promotional images.
- Support URL and privacy policy URL.
- Test account/instructions if reviewers need to exercise the local agent flow.
- Public troubleshooting doc for Store install specifically.

### 11. Release/Update Story Is Split Between Store And GitHub

The extension updates through Chrome Web Store; the native host/CLI updates
through GitHub Release assets. That split is acceptable but needs explicit
version compatibility rules.

Required work:

- Define which extension versions are compatible with which native host
  versions.
- Confirm popup `version_mismatch` copy is correct for Store users.
- Decide whether Store extension update should ever prompt a native host update.
- Add a release note template that coordinates Store extension version and
  GitHub native host version.

## Recommended Implementation Plan

1. Establish the Chrome Web Store draft item and final extension id.
2. Add release metadata for Store channel, including Store extension id.
3. Implement or loudly reject `--channel=store` in `doctor browser` and
   aggregate `doctor` before exposing it in copied commands.
4. Implement `--channel=store` in `setup`, `install-host`, `doctor browser`,
   and `doctor browser --repair`.
5. Make the popup copied command channel-aware.
6. Add Store artifact packaging/validation.
7. Add permission/privacy/reviewer docs, then Store listing assets.
8. Run a real Store draft install gate on a clean profile.

## Minimum Definition Of Done For Store Readiness

The product is Store-ready only when all of these are true:

- The Store extension id is final and committed in release metadata.
- `obu setup --channel=store --all --skip-agents` installs native hosts whose
  `allowed_origins` include the Store extension id.
- `doctor browser --channel=store` either fails loudly until supported or runs
  Store-aware checks; once supported, doctor JSON includes channel and extension
  id source.
- `obu doctor browser --channel=store --repair` repairs the Store native-host
  manifest without requiring `~/.obu/extension/current`.
- The Store popup copies a Store-channel command.
- A Store upload zip is generated and validated separately from local unpacked
  payloads.
- Permission justifications, privacy disclosures, and reviewer instructions are
  ready before Store submission.
- A clean-profile Store install has been manually verified end to end.
