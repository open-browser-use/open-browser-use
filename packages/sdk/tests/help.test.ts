import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { renderHelp } from "../src/help.js";

describe("help", () => {
  it("documents the P2 agent, browser, tab, and locator surfaces", () => {
    const help = renderHelp();
    expect(help).toContain("agent.browsers.get");
    expect(help).toContain("get(\"chrome\") is WebExtension-backed Chrome by default");
    expect(help).toContain("fails fast instead of falling back to CDP");
    expect(help).toContain("use get(\"cdp\") or an explicit CDP backend option");
    expect(help).toContain("agent.browsers.diagnostics");
    expect(help).toContain(".lifecycleDiagnostics");
    expect(help).toContain(".capabilityRegistry.list()/has(name)/get(name)");
    expect(help).toContain(".profileMetadata");
    expect(help).toContain(".deliverables()");
    expect(help).toContain(".clearLifecycleDiagnostics()");
    expect(help).toContain(".tabs.create");
    expect(help).toContain(".tabs.content({urls})");
    expect(help).toContain(".viewport?.set({width,height})");
    expect(help).toContain(".visibility?.set({visible})");
    expect(help).toContain(".waitForEvent(\"filechooser\"|\"download\")");
    expect(help).toContain(".waitForNavigation()");
    expect(help).toContain(".domSnapshot()");
    expect(help).toContain("display(await tab.screenshot())");
    expect(help).toContain(".dom_cua.text()");
    expect(help).toContain(".cua.click");
    expect(help).toContain(".dev.cdp");
    expect(help).toContain(".getByRole");
    expect(help).toContain(".all() -> Locator[] with batched collection reads");
    expect(help).toContain("display(value)");
  });

  it("is returned by Agent.help", () => {
    const agent = new Agent({
      listBackends: () => [],
      connectBackend: async () => {
        throw new Error("unexpected connect");
      },
    });

    expect(agent.help()).toBe(renderHelp());
  });

  it("keeps overview docs on the safe user-tab discovery surface", async () => {
    const sdkReadme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const architecture = await readFile(new URL("../../../docs/current-product-architecture.md", import.meta.url), "utf8");

    expect(sdkReadme).toContain("browser.tabs.current()");
    expect(sdkReadme).toContain("browser.tabs.selected()");
    expect(sdkReadme).toContain("browser.user.discoverTabs()");
    expect(sdkReadme).not.toContain("browser.user.openTabs/history/claimTab");
    expect(sdkReadme).not.toContain("browser.user.openTabs()` |");

    expect(architecture).toContain("tabs.create/list/get/current/selected");
    expect(architecture).toContain("user.discoverTabs/history/claimTab");
    expect(architecture).not.toContain("user.openTabs/history/claimTab");
    expect(architecture).not.toContain("| `BrowserUser` | `openTabs()`");
  });
});
