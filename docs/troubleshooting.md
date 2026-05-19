# open-browser-use Troubleshooting

Start with:

```bash
obu doctor
obu doctor --json
```

Use strict mode in CI:

```bash
obu doctor --strict --json
```

Without `--strict`, `obu doctor` exits nonzero only when a check fails. With
`--strict`, warnings also produce a nonzero exit so CI can reject drift such as
stale extension paths, stale runtime descriptors, or leftover generated backups.

## Runtime Directory

open-browser-use uses one runtime directory for the CLI, native host, extension
descriptors, and MCP entrypoint.

Resolution order:

1. `OBU_RUNTIME_DIR`
2. `~/.obu/config.json`
3. Linux `$XDG_RUNTIME_DIR/obu`, otherwise `/tmp/obu-<uid>`

The directory must be owner-only and must not be a symlink. Repairable
permission issues can be fixed by rerunning setup or:

```bash
obu doctor browser --repair
```

## MCP Stdio Exits Before Starting

`obu mcp stdio` intentionally never runs setup, prints prompts, or writes
first-run help to stdout. If runtime state is missing, it exits nonzero and
writes a short error to stderr.

Run:

```bash
obu setup --yes
obu doctor
```

Then retry the MCP client.

## MCP Server Ready But No Browser Backend

MCP availability and browser availability are separate. An agent can have the
`open-browser-use` MCP server configured and still see `browser_status` return
an available SDK with `backends: []`. That means the MCP server can start, but
no live browser backend descriptor is available yet.

For a Store-channel extension, repair with the exact extension id copied from
the extension popup:

```bash
obu doctor browser --repair --channel=store --extension-id=<STORE_EXTENSION_ID>
```

Do not infer this id from the unpacked extension manifest or another Chrome
profile. The Chrome native messaging manifest must include the matching
`allowed_origins` entry:

```json
["chrome-extension://<STORE_EXTENSION_ID>/"]
```

After repair, open the open-browser-use extension popup and click **Resume** if
the popup is not connected. Static repair can make the native-host manifest and
runtime descriptor directory valid, but the active WebExtension runtime
descriptor is written only after the extension reconnects to the native host.
Rerun:

```bash
obu doctor browser --channel=store --extension-id=<STORE_EXTENSION_ID>
```

Then retry `browser_status`.

## Agent JavaScript Pitfalls

For agent setup and MCP wiring, use the popup's **Copy for Agent** handoff or
[`prompts/agent-install-prompt.md`](../prompts/agent-install-prompt.md).

Inside the MCP `js` tool, `agent.browsers.get(...)` returns a promise:

```js
const browser = await agent.browsers.get("chrome");
```

`browser.tabs.create()` accepts either a URL string or `{ url }`. With no URL it
opens `about:blank`; pass the target URL at creation time when possible:

```js
const tab = await browser.tabs.create({ url: "http://127.0.0.1:8000/index.html" });
```

The WebExtension backend cannot inspect or automate `file://` pages. Serve local
files over HTTP before navigating, for example:

```bash
python3 -m http.server 8000
```

Large Retina screenshots can exceed an MCP response budget. Prefer a clipped or
compressed screenshot for model inspection:

```js
const shot = await tab.screenshot({
  type: "jpeg",
  quality: 60,
  clip: { x: 0, y: 0, width: 900, height: 700, scale: 0.5 }
});
display({ __obuImage: true, mime_type: shot.mime_type, data: shot.data_base64 });
```

For bounded page-level JavaScript, prefer the first-class `tab.evaluate()`
helper:

```js
const title = await tab.evaluate(() => document.title);
```

Keep raw `tab.dev.cdp(...)` for cases that need direct CDP protocol access.

The Node kernel intentionally hides `process` / `node:process`; use
`nodeRepl.cwd`, `nodeRepl.homeDir`, `nodeRepl.tmpDir`, and
`nodeRepl.requestMeta` instead. Filesystem writes are blocked in the default
permission model, so do not rely on `screenshot({ path })` or `writeFile` from
the MCP JavaScript cell.

If WebExtension navigation fails with a stale native socket path after the
extension service worker restarts, call `js_reset`. The reset respawns the
JavaScript kernel and refreshes runtime descriptors before the next `agent`
connection.

## Extension Loaded From The Wrong Path

The unpacked extension path should be stable:

```text
~/.obu/extension/current
```

If doctor reports loaded-path drift, remove the old unpacked extension from
`chrome://extensions` and load the stable `current` directory, or click Reload
for the already-loaded stable extension after:

```bash
obu update-extension
```

## Native Host Problems

Reinstall native-host manifests and wrappers:

```bash
obu install-host --browser chrome
obu install-host --all
```

For a Chrome Web Store-installed extension, repair with the Store channel:

```bash
obu install-host --channel=store --browser chrome --extension-id <STORE_EXTENSION_ID>
obu doctor browser --repair --channel=store --extension-id <STORE_EXTENSION_ID>
```

If the Store channel reports that the Store extension id is not configured,
install a release payload that records `storeExtensionId`, use the Store popup
agent handoff, or pass `--extension-id <STORE_EXTENSION_ID>` while testing a
draft item. Prefer the id from the popup handoff over any guessed id; repair
will write that exact origin into `allowed_origins`.

The manifest path should point at an open-browser-use wrapper under
`~/.obu/native-host/dev.obu.host/<browser>/obu-host-wrapper`, not directly at a
source-tree helper or versioned payload binary.

## Extension Debug Logs

The unpacked extension popup has local debug logging controls. Open the
open-browser-use extension popup, enable **Debug logs**, reproduce the issue,
then click **Copy** to copy a JSON report with the current popup status and the
recent extension service-worker events. Click **Clear** after collecting the
report.

Logs stay in `chrome.storage.local` and are not uploaded. Keep debug logging
off when you are not actively reproducing an issue.

## Agent Adapter Backups

Direct-edit adapters retain only open-browser-use timestamped backups. To inspect counts:

```bash
obu doctor
```

To remove open-browser-use-generated backups:

```bash
obu doctor --clean-backups
```

User-named backup files are ignored.

## Preview Install Artifacts

P4 preview artifacts are local or GitHub Release artifacts until the public npm
scope is verified. The curl-style preview install path is GitHub Release assets,
not a dedicated website URL. The planned release repository name is
`open-browser-use`.
