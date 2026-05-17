# @open-browser-use/sdk

Agent-facing open-browser-use SDK. It exposes a Playwright-shaped browser API over the
open-browser-use broker wire and is bundled as ESM in `dist/index.mjs`.

## Runtime Loading

`obu-node-repl` imports the trusted SDK bundle during kernel bootstrap and
installs locked `agent` and `help` globals. The SDK receives socket access only
through `import.meta.__obuNativePipe` on the trusted module. It does not read
`globalThis.__obuNativePipe`, `OBU_HOST_SOCKET_PATH`, or
`OBU_CAPABILITY_TOKEN`.

```js
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.create("https://example.com");
await tab.attach();
await tab.locator("h1").click();
await tab.screenshotForModel({ clip: { x: 0, y: 0, width: 900, height: 700, scale: 0.5 } });
```

Backend discovery is lazy. `setupObuRuntime()` installs `agent` without opening
a socket; `agent.browsers.get(kind)` performs discovery, connects, and sends
`getInfo`. For Chromium-family kinds (`chrome`, `edge`, `brave`, `arc`,
`chromium`), discovery prefers live WebExtension descriptors and falls back to
CDP. `agent.browsers.get("cdp")` forces a CDP backend, and passing an exact
`socketPath` forces that backend.
If no backend is available, `agent.browsers.get(kind)` includes ignored runtime
descriptor diagnostics in the thrown `ERR_NO_BACKEND` message. Call
`await agent.browsers.diagnostics()` to inspect those setup diagnostics without
attempting a connection.

## Public Surface

Call `agent.help()` for the live API table. Main layers:

| API | Wire methods |
| --- | --- |
| `agent.browsers.get(kind)` | `getInfo` |
| `agent.browsers.diagnostics()` | Local runtime descriptor diagnostics |
| `browser.diagnostics/lifecycleDiagnostics/capabilities` | `getInfo` metadata |
| `browser.ensureReady()` | `getInfo` readiness summary |
| `browser.deliverables()` | `getTabs`, `getInfo`, `claimUserTab` |
| `browser.clearLifecycleDiagnostics()` | `clearLifecycleDiagnostics` |
| `browser.finishTurn({ keep })` | `finalizeTabs`, `turnEnded` |
| `browser.tabs.create(urlOrOptions)/list/get` | `createTab`, `getTabs` |
| `browser.user.openTabs/history/claimTab` | `getUserTabs`, `getUserHistory`, `claimUserTab` |
| `tab.attach/detach` | `attach`, `detach` |
| `tab.goto/back/forward/reload/waitForURL/waitForLoadState/screenshot` | `tab_*` |
| `tab.evaluate()` / `tab.snapshotText()` | capped `executeCdp` evaluation |
| `tab.screenshotForModel()` | `tab_screenshot` plus MCP image emission when available |
| `tab.waitForEvent("filechooser" \| "download")` | `playwright_wait_for_*` |
| `tab.locator(selector)` / `locator.download_media()` | `playwright_locator_*` |
| `tab.frameLocator(selector)` | Playwright selector scope |
| `tab.cua.*` | `cua_*` |
| `tab.content.export({ format })` | `tab_content_export` |
| `tab.clipboard.readText/writeText/read/write` | `tab_clipboard_*` |
| `tab.dom_cua.*` | `dom_cua_*` |
| `tab.dev.cdp(method, params)` | `executeCdp` |
| `display(value)` | Delegates to the kernel-locked display global |

`browser.tabs.create()` accepts either a URL string or `{ url }`. With no URL it
creates `about:blank`, not Chrome's extension-restricted new-tab page.
`tab.screenshot()` accepts the Playwright-shaped subset `{ type, quality, clip,
fullPage }`. Prefer `tab.screenshotForModel()` for agent observations; it
defaults to compressed JPEG and emits an MCP image resource when the kernel
supports `nodeRepl.emitImage`. Avoid returning or logging raw
screenshot/content-export base64. The MCP `js` tool caps large text/JSON fields
and spills image-like base64 payloads to resources, but compact summaries remain
the intended path.

Rich clipboard `read()` / `write()` use Codex-shaped multi-MIME clipboard items
on WebExtension sessions through the target-page virtual clipboard. Cookies,
storage, and arbitrary evaluation are intentionally not first-class SDK methods;
use `tab.dev.cdp(...)` when needed.

WebExtension `tab.cua.type()`, `tab.dom_cua.type()`, and plain
`Cmd/Ctrl+V` keypresses use the same virtual clipboard path, so paste handlers
can receive `text/plain` and generated `text/html` without touching the OS
clipboard.

## Errors

The SDK throws `ObuError` for JSON-RPC failures.

| Range | Meaning |
| --- | --- |
| `-32xxx` | JSON-RPC standard errors |
| `-1000..-1099` | server, timeout, IO, protocol |
| `-1100..-1199` | guard and auth failures |
| `-1200..-1299` | backend failures |
| `-2000+` | user-program errors |

## Build and Test

```bash
pnpm -C packages/sdk build
pnpm -C packages/sdk typecheck
pnpm -C packages/sdk test
```

The build writes `dist/version.json` with the SHA-256 of `dist/index.mjs`.
`obu-node-repl` uses that hash to seed the trusted-module allowlist.
