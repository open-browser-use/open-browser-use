# Chrome Web Store Review Pack

Status: draft for first Store submission.

The Store submission must use the final Chrome Web Store item id. Until the
draft item is created and verified, `packages/extension/release-metadata.json`
keeps `store.storeExtensionId` as `null` and `storeDraftVerified` as `false`.

## Permission Justifications

| Permission | Justification |
| --- | --- |
| `nativeMessaging` | Connects the extension to the locally installed `dev.obu.host` native host. This is the core bridge between Chrome and the user's local open-browser-use runtime. |
| `debugger` | Enables Chrome DevTools Protocol control for browser automation actions requested by the local user or local agent. |
| `tabs` | Discovers, creates, selects, and reports tabs so local agents can operate on the intended page. |
| `tabGroups` | Preserves and reports Chrome tab organization when the local agent inspects or moves tabs. |
| `scripting` | Injects controlled helper code for page interaction where browser APIs require explicit script execution. |
| `storage` | Stores local connection state, debug-log settings, and recent extension diagnostics in `chrome.storage.local`. |
| `history` | Allows local browser tasks to inspect history only when the user's local host policy permits it. |
| `downloads` | Allows local browser tasks to observe or manage downloads only when the user's local host policy permits it. |
| `alarms` | Schedules service-worker reconnect attempts to the native host after suspension or transient failures. |
| `<all_urls>` | Lets the user direct their local agent at arbitrary pages they choose to automate. |
| all-URLs content script | Loads the cursor/interaction helper at `document_start` so visible automation feedback and page interaction work across frames. |

## Data Handling

Read locally:

- Tab metadata, page URLs, titles, frame information, browser state, and page
  content needed to execute local user-requested browser tasks.
- Browser history and download information only through local commands and only
  when not blocked by the user's local host policy.
- Extension connection diagnostics and debug logs stored in
  `chrome.storage.local`.

Stored locally:

- Runtime descriptors under the owner-only open-browser-use runtime directory.
- Native host manifests under the browser's NativeMessagingHosts directory.
- Popup debug logs in `chrome.storage.local` when the user enables them.
- CLI setup configuration under `~/.obu/config.json`.

Transmitted:

- Extension messages are sent to the locally installed native host through
  Chrome native messaging.
- The copied agent handoff links to GitHub-hosted setup instructions and may ask
  the user's local agent to download release assets from GitHub.

Not uploaded by the extension:

- Page content, history, download records, screenshots, debug logs, and runtime
  descriptor tokens are not uploaded by the extension to an open-browser-use
  cloud service.
- Debug logs remain local until the user explicitly copies them.

## Optional Permission Review

Current stance for the first Store draft:

- Keep `nativeMessaging`, `debugger`, `<all_urls>`, and the all-URLs content
  script as required permissions because they define the product's local browser
  automation model.
- Keep `history` and `downloads` as required until the local host policy and SDK
  command surface can be split into optional capability grants without breaking
  existing automation flows.
- Revisit optional permissions before broad public release if Store review
  requests narrower warnings.

## Reviewer Instructions

1. Install the Chrome Web Store draft item in a clean Chrome profile.
2. Open the extension popup.
3. Click **Copy for Agent** in the popup.
4. Paste the handoff into the local coding agent and have it complete setup or
   repair. The handoff must include:

   ```text
   Extension channel: store
   ```

5. Click **Resume** in the popup.
6. Expected result: popup status changes to `Connected`.

Reviewer notes:

- The native host is installed outside the extension because Chrome native
  messaging requires a browser-owned native-host manifest whose
  `allowed_origins` contains the concrete extension id.
- The extension cannot repair that manifest by itself; the copied agent handoff
  sends the exact Store channel/id and prompt link to the user's coding agent,
  which installs or repairs the GitHub Release CLI/native host payload when
  needed.
- Diagnostics are local. `obu doctor browser --channel=store --json` reports the
  channel, extension id, id source, native-host manifest status, and runtime
  descriptor status.

## Store Artifact Commands

For the first draft upload, the Store item id may not exist yet. Generate a
keyless upload zip, upload it to the Developer Dashboard, then copy the item id
shown by the dashboard:

```bash
pnpm -C packages/extension build
node packages/extension/scripts/build.mjs --channel store
node scripts/make-extension-store-artifact.mjs
```

After the Store draft item id is known, regenerate the artifact with the id so
the summary records the native-host target:

```bash
pnpm -C packages/extension build
node packages/extension/scripts/build.mjs --channel store
node scripts/make-extension-store-artifact.mjs \
  --store-extension-id <STORE_EXTENSION_ID>
```

The upload zip omits `manifest.key`; Chrome Web Store rejects packages that
include the `key` field.

The artifact summary is written to:

```text
dist/chrome-web-store/chrome-web-store-artifact.json
```

The Store upload zip is:

```text
dist/chrome-web-store/open-browser-use-chrome-web-store-<version>.zip
```
