# Agent Browser Use over MCP

This document is the agent-facing contract for driving open-browser-use through
the MCP `js` tool. It exists to keep LLMs on the intended path and to make token
costs visible before they turn into failed tool calls.

For the broader system-level integration analysis, including current bottlenecks
and recommended implementation priorities, see
[`mcp-browser-integration-analysis.md`](mcp-browser-integration-analysis.md).

Reference points checked against the latest published MCP specification at the
time of writing (`2025-11-25`):

- Tool results may include `structuredContent`, and tools that advertise an
  `outputSchema` should return structured data matching that schema:
  https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Long-running tools can stream progress with `notifications/progress` when the
  client supplies a progress token:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress
- Large artifacts should be exposed as resources or resource links instead of
  inlining the full payload in a tool result:
  https://modelcontextprotocol.io/specification/2025-11-25/server/resources

## Call Chain

1. The MCP client calls `tools/list` and receives `js`, `browser_status`,
   `js_reset`, and `js_add_module_dir`, each with an input schema and output
   schema.
2. The client calls `tools/call` for `js` with JavaScript `source` and optional
   `timeout_ms`.
3. `crates/obu-node-repl/src/mcp_server.rs` validates arguments. If the request
   has a progress token, it installs a temporary progress sink.
4. `JsRuntimeManager` sends a JSONL `exec` frame to the Node kernel with request
   metadata, including session and turn identifiers.
5. `kernel.js` runs each cell as a fresh ES module in the same Node child. It
   installs locked globals: `agent`, `display`, `nodeRepl`, and `obuRepl`.
6. `await agent.browsers.get("chrome" | "cdp")` asks
   `obuRepl.discoverBackends()` for backend descriptors, opens the native pipe
   through the Rust broker, and sends `getInfo` to `obu-host`.
7. Browser commands flow through SDK guards, add session metadata, cross the
   native pipe broker, hit `obu-host` dispatcher policy, and then run in the CDP
   or WebExtension backend.
8. `display()` frames can stream as MCP progress for text/JSON. The final MCP
   result returns concise text `content` plus structured `stdout`, `stderr`,
   `result`, `duration_ms`, `truncated`, `displays`, `artifacts`,
   `response_meta`, and `error`. Large image/content payloads are returned as
   MCP resource links when they cross the inline budget.

## Canonical Agent Flow

```js
const browser = await agent.browsers.get("chrome");
const tab = await browser.tabs.create({ url: "http://127.0.0.1:8000/index.html" });
await tab.attach();

const snapshot = await tab.snapshotText();
display({ title: snapshot.title, headings: snapshot.headings.slice(0, 3) });

const shot = await tab.screenshotForModel({
  clip: { x: 0, y: 0, width: 900, height: 700, scale: 0.5 }
});
await browser.finishTurn();
({ snapshot, shot });
```

Use this order when possible:

1. Call `browser_status` before the first `js` cell when setup readiness is
   uncertain.
2. Inspect state with locators, `textContent()`, `count()`, `readAll()`, URL, and
   title.
3. Use a clipped/compressed screenshot only when visual inspection is needed.
4. Use `tab.evaluate(...)` for bounded page evaluation; keep raw
   `tab.dev.cdp(...)` as an escape hatch.
5. Return small summaries as the last expression; send progress with small
   `display()` calls.

## Repeated Agent Mistakes to Avoid

- `agent.browsers.get(...)` is async. Always `await` it before reading `.tabs`.
- `browser.tabs.create()` accepts a URL string or `{ url }`. With no URL it uses
  `about:blank`.
- WebExtension sessions cannot drive `file://` pages. Serve local files over
  HTTP, for example `python3 -m http.server 8000`.
- `tab.evaluate()` exists and defaults to a capped JSON result. Prefer it over
  raw CDP evaluation:

  ```js
  const result = await tab.evaluate(() => ({
    title: document.title,
    buttons: document.querySelectorAll("button").length
  }));
  ```

- `process` and `node:process` are unavailable in the kernel. Use
  `nodeRepl.cwd`, `nodeRepl.homeDir`, `nodeRepl.tmpDir`, and
  `nodeRepl.requestMeta`.
- Default filesystem writes are blocked by Node permissions. Do not rely on
  `screenshot({ path })` or `writeFile` inside the MCP JavaScript cell.
- If a WebExtension service worker restart leaves a stale native socket path,
  call `js_reset`; reset respawns the kernel and refreshes runtime descriptors.

## Token Budget Hotspots

Large-payload sources:

- `tab.screenshot()` and `tab.content.export({ format: "png" | "pdf" })`
  return base64 at the SDK/host layer.
- `tab.content.export({ format: "html" })` base64-encodes the full document.
- `display({ __obuImage, data })` and `nodeRepl.emitImage(...)` are captured as
  image displays. The MCP server spills those image bytes to resources in the
  final result.
- Text and JSON `display()` frames can stream as progress, but they are also
  included in final `displays`.
- `console.log`, `nodeRepl.write`, and the final expression all flow back in the
  final structured result.
- Raw `tab.dev.cdp("Runtime.evaluate", { returnByValue: true })` can return
  very large objects if the expression serializes DOM, storage, or app state.
- DOM snapshots and locator `readAll()` results can be large on dense pages.

Use these defaults to keep results small:

- Never `console.log` or return raw screenshot/base64/HTML/PDF payloads.
- Prefer `tab.screenshotForModel()` over `tab.screenshot()` when the result is
  for model inspection.
- If using `display()` manually, do not write `display(await tab.screenshot())`;
  wrap the image explicitly as `{ __obuImage: true, mime_type, data }`.
- Prefer `type: "jpeg"`, `quality: 50..70`, `fullPage: false`, and a `clip`
  with `scale < 1` for screenshots.
- Return counts, selected text, dimensions, short arrays, or explicit summaries
  instead of whole documents or page state.
- Use `tab.snapshotText()` for compact page state and `tab.evaluate()` for
  bounded page expressions.

Current protections:

- MCP `js` results cap `stdout`, `stderr`, final `result`, and `displays`, and
  set field-level `truncated` flags.
- Image displays and oversized base64 payloads with MIME metadata are spilled to
  `obu-artifact://...` MCP resources.
- Clients that do not fetch resources still receive a structured summary with
  URI, MIME type, byte count, and truncation flags.
