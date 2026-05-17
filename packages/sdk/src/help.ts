export function renderHelp(): string {
  return `open-browser-use SDK - API overview

agent.browsers.get(kind?) -> Promise<Browser>   kind in {chrome, cdp, ...}
agent.browsers.diagnostics() -> ignored backend descriptor setup diagnostics

Browser:
  .diagnostics / .lifecycleDiagnostics / .capabilities
  .deliverables() -> finalized durable tabs, with .claim()
  .ensureReady() -> compact backend/capability/diagnostic summary
  .tabs.create(urlOrOptions?) -> Tab   accepts "https://..." or {url}; defaults to "about:blank"
  .tabs.list() -> Tab[]
  .tabs.get(id) -> Tab
  .user.openTabs() / .user.history() / .user.claimTab()
  .name(label) / .turnEnded() / .finalizeTabs({keep?}) / .finalize() / .finishTurn({keep?}) / .clearLifecycleDiagnostics()

Tab:
  .goto(url) / .back() / .forward() / .reload() / .waitForURL() / .waitForLoadState() / .waitForNavigation()
  .waitForTimeout()
  .waitForEvent("filechooser"|"download") -> FileChooser | Download
  .locator(sel) -> Locator
  .frameLocator(sel) -> FrameLocator
  .content.export({format?}) -> bytes
  .screenshot({type?, quality?, clip?, fullPage?}) -> bytes
  .screenshotForModel({clip?, artifactMode?}) -> compact screenshot summary or inline bytes
  .evaluate(expressionOrFn, {maxJsonBytes?}) -> capped JSON-safe page result
  .snapshotText({maxItems?, maxTextLength?}) -> compact page text summary
  .cua.click() / .dblclick() / .scroll() / .type() / .keypress() / .drag() / .dragPath() / .move()
  .clipboard.readText() / .writeText() / .read() / .write()
  .dev.cdp(method, params)
  .attach() / .detach()

Locator:
  .click({ waitForNavigation }) / .dblclick({ waitForNavigation }) / .type() / .fill() / .press() / .hover()
  .isVisible() / .isEnabled() / .boundingBox() / .count() / .waitFor()
  .textContent() / .innerText() / .getAttribute() / .allTextContents()
  .selectOption() / .check() / .uncheck() / .setChecked() / .screenshot() / .download_media()
  .getByRole() / .getByText() / .getByLabel() / .getByPlaceholder() / .getByTestId()
  .first() / .last() / .nth(i) / .and() / .or() / .filter({has, hasText}) / .locator(sub)
  .frameLocator(sel)

display(value): calls the kernel-locked display global.
help(): returns this string.
`;
}
