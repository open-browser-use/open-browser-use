# @open-browser-use/extension

Chromium MV3 extension for the open-browser-use WebExtension backend. It connects to the
native host `dev.obu.host`, proxies CDP through `chrome.debugger`, owns
session-tab state, and exposes the popup Stop control.

## Build

```bash
pnpm -C packages/extension build
```

Load `packages/extension/dist` as an unpacked extension in a Chromium-family
browser. The development manifest includes a fixed public key, so the unpacked
extension ID is stable:

```text
fblnfcjnjklpgnmfnngcihbcgojnpadj
```

## Dev Native Host Manifest

Build the host, then install the per-user native-messaging manifest:

```bash
cargo build -p obu-host
pnpm -C packages/extension dev:manifest -- --browser chrome
```

The writer creates a wrapper script under `packages/extension/.dev-native-host`
and writes `dev.obu.host.json` for the chosen browser. The manifest points at
`obu-host --native-messaging` and allows only:

```text
chrome-extension://fblnfcjnjklpgnmfnngcihbcgojnpadj/
```

Useful options:

```bash
pnpm -C packages/extension dev:manifest -- --browser all
pnpm -C packages/extension dev:manifest -- --browser chrome-for-testing
pnpm -C packages/extension dev:manifest -- --browser chromium --host-binary /abs/path/obu-host
pnpm -C packages/extension dev:manifest -- --browser chrome --output-dir /tmp/NativeMessagingHosts
pnpm -C packages/extension dev:manifest -- --print-extension-id
```

macOS and Linux are supported in P3. Windows native-host registration is a P4
installer task.

## Permissions

P3 uses `nativeMessaging`, `debugger`, `tabs`, `tabGroups`, `scripting`,
`storage`, `history`, `downloads`, and `<all_urls>`. It intentionally does not
request bookmarks, reading list, notifications, top sites, or clipboard
permissions; text clipboard uses the target-page virtual clipboard CDP path.

## E2E

The manual E2E helper builds the host, SDK, and extension, installs a temporary
native-host manifest, launches Chromium with the unpacked extension, waits for a
runtime descriptor, then runs the ignored Rust node-repl SDK test:

```bash
scripts/p3-webext-e2e.sh
```

Set `OBU_WEBEXT_CHROME_BIN=/path/to/chrome` if Chrome for Testing or Chromium is
not in a standard location. Branded Google Chrome is for the manual
`chrome://extensions` path; the scripted E2E rejects it unless
`OBU_WEBEXT_E2E_ALLOW_BRANDED=1` is set. Set `OBU_WEBEXT_E2E_HEADLESS=1` to try
headless Chromium.

For local setup, install or locate Chrome for Testing with:

```bash
scripts/ensure-chrome-for-testing.sh
```

The E2E script can also do this automatically:

```bash
OBU_WEBEXT_E2E_AUTO_INSTALL=1 scripts/p3-webext-e2e.sh
```
