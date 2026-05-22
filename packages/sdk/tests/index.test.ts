import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";

describe("public SDK barrel exports", () => {
  it("exposes the primary runtime, browser, tab, guard, and error APIs", () => {
    expect(sdk.Agent).toBeTypeOf("function");
    expect(sdk.Browser).toBeTypeOf("function");
    expect(sdk.BrowserTabs).toBeTypeOf("function");
    expect(sdk.BrowserUser).toBeTypeOf("function");
    expect(sdk.UserTabRef).toBeTypeOf("function");
    expect(sdk.Browsers).toBeTypeOf("function");
    expect(sdk.Tab).toBeTypeOf("function");
    expect(sdk.Locator).toBeTypeOf("function");
    expect(sdk.FrameLocator).toBeTypeOf("function");
    expect(sdk.Download).toBeTypeOf("function");
    expect(sdk.FileChooser).toBeTypeOf("function");
    expect(sdk.Guards).toBeTypeOf("function");
    expect(sdk.setupObuRuntime).toBeTypeOf("function");
    expect(sdk.renderHelp).toBeTypeOf("function");
    expect(sdk.display).toBeTypeOf("function");
    expect(sdk.ObuError).toBeTypeOf("function");
    expect(sdk.SDK_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(sdk.METHOD_CLASSIFICATION).toMatchObject({
      getInfo: "always-allowed",
      getCurrentTab: "always-allowed",
      getSelectedTab: "history",
      yieldControl: "internal-lifecycle",
      resumeControl: "internal-lifecycle",
    });
  });
});
