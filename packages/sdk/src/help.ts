export function renderHelp(): string {
  return `open-browser-use SDK - API overview

agent.browsers.get(kind?) -> Promise<Browser>   kind in {chrome, cdp, ...}
  get("chrome") is WebExtension-backed Chrome by default; it fails fast instead of falling back to CDP
  use get("cdp") or an explicit CDP backend option only when losing Chrome profile continuity is acceptable
agent.browsers.diagnostics() -> ignored backend descriptor setup diagnostics

Browser:
  .diagnostics / .lifecycleDiagnostics / .capabilities
  .capabilityRegistry.list()/has(name)/get(name) -> inspect advertised backend capabilities
  .profileMetadata -> non-sensitive browser profile identity; raw profile paths are diagnostics-only
  .deliverables() -> finalized durable tabs, with .claim()
  .ensureReady() -> compact backend/capability/diagnostic summary
  .tabs.create(urlOrOptions?) -> Tab   accepts "https://..." or {url}; defaults to "about:blank"
  .tabs.current() -> current session-owned task tab, if any
  .tabs.selected() -> browser-visible selected tab or UserTabRef when claim/resume is required
  .tabs.list() -> Tab[]
  .tabs.get(id) -> Tab
  .tabs.content({urls}) -> host-side unauthenticated batch URL content without opening tabs
  .viewport?.set({width,height}) / .viewport?.reset() when the backend advertises viewport control
  .visibility?.set({visible}) / .visibility?.get() when the backend advertises window visibility control
  keep multiple Tab handles when a workflow needs more than one tab
  .user.discoverTabs() -> UserTabRef[] / .user.history() / .user.claimTab()
  .name(label) / .turnEnded() to mark a turn boundary while keeping active tabs controlled
  .yieldControl() / .resumeControlResult() to let a human take over and resume with structured blocked-repair diagnostics
  .finalizeTabs({keep?}) / .finalize() / .finishTurn({keep?, endTurnOnPartial?}) to close, release, hand off, or preserve tabs
  .clearLifecycleDiagnostics()

Tab:
  .goto(url) / .back() / .forward() / .reload() / .waitForURL() / .waitForLoadState() / .waitForNavigation()
  .waitForTimeout()
  .waitForEvent("filechooser"|"download") -> FileChooser | Download
  .locator(sel) -> Locator
  .frameLocator(sel) -> FrameLocator
  .content.export({format?}) -> bytes
  .screenshot({type?, quality?, clip?, fullPage?}) -> Image with toBase64(); use display(await tab.screenshot())
  .screenshotForModel({clip?, artifactMode?}) -> compact screenshot summary or inline bytes
  .domSnapshot() -> model-safe Playwright DOM/ARIA snapshot string
  .playwright.elementInfo({x,y}) / .playwright.elementScreenshot({x,y}) -> point-level inspection
  .evaluate(expressionOrFn, {maxJsonBytes?}) -> capped JSON-safe page result
  .snapshotText({maxItems?, maxTextLength?}) -> compact page text summary
  .cua.click() / .dblclick() / .scroll() / .type() / .keypress() / .drag() / .dragPath() / .move() / .download_media() / .get_visible_screenshot()
  .clipboard.readText() / .writeText() / .read() / .write()
  .dom_cua.get_visible_dom({format:"text"}) / .dom_cua.text() -> LLM-readable visible DOM-CUA
  .dev.cdp(method, params)
  .attach() / .detach()

Locator:
  .click({ waitForNavigation }) / .dblclick({ waitForNavigation }) / .type() / .fill() / .press() / .hover()
  .isVisible() / .isEnabled() / .boundingBox() / .count() / .waitFor()
  .textContent() / .innerText() / .getAttribute() / .allTextContents()
  .all() -> Locator[] with batched collection reads for text and attributes
  .selectOption() / .check() / .uncheck() / .setChecked() / .screenshot() -> Image / .download_media()
  .getByRole() / .getByText() / .getByLabel() / .getByPlaceholder() / .getByTestId()
  .first() / .last() / .nth(i) / .and() / .or() / .filter({has, hasText}) / .locator(sub)
  .frameLocator(sel)

display(value): calls the kernel-locked display global.
help(): returns this string.
`;
}
