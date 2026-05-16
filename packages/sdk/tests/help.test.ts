import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { renderHelp } from "../src/help.js";

describe("help", () => {
  it("documents the P2 agent, browser, tab, and locator surfaces", () => {
    const help = renderHelp();
    expect(help).toContain("agent.browsers.get");
    expect(help).toContain("agent.browsers.diagnostics");
    expect(help).toContain(".lifecycleDiagnostics");
    expect(help).toContain(".deliverables()");
    expect(help).toContain(".clearLifecycleDiagnostics()");
    expect(help).toContain(".tabs.create");
    expect(help).toContain(".waitForEvent(\"filechooser\"|\"download\")");
    expect(help).toContain(".waitForNavigation()");
    expect(help).toContain(".cua.click");
    expect(help).toContain(".dev.cdp");
    expect(help).toContain(".getByRole");
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
});
