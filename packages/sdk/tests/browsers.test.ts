import { describe, expect, it } from "vitest";
import { selectBackend, type DiscoveredBackend } from "../src/browsers.js";

const cdp: DiscoveredBackend = {
  type: "cdp",
  name: "cdp",
  socketPath: "/tmp/obu/cdp.sock",
};

describe("selectBackend", () => {
  it("selects the single WebExtension descriptor for chrome before CDP", () => {
    const webext = webextension("/tmp/obu/chrome.sock", "10");
    expect(selectBackend([cdp, webext], "chrome")).toBe(webext);
  });

  it("chooses the newest same-family WebExtension descriptor", () => {
    const older = webextension("/tmp/obu/a.sock", "10");
    const newer = webextension("/tmp/obu/b.sock", "20");
    expect(selectBackend([older, newer, cdp], "chrome")).toBe(newer);
  });

  it("uses socket path as a deterministic tie breaker", () => {
    const second = webextension("/tmp/obu/b.sock", "20");
    const first = webextension("/tmp/obu/a.sock", "20");
    expect(selectBackend([second, first], "chrome")).toBe(first);
  });

  it("forces an exact socket path", () => {
    const first = webextension("/tmp/obu/a.sock", "10");
    const second = webextension("/tmp/obu/b.sock", "20");
    expect(selectBackend([first, second], "/tmp/obu/a.sock")).toBe(first);
  });

  it("does not select WebExtension for explicit cdp requests", () => {
    const webext = webextension("/tmp/obu/chrome.sock", "20");
    expect(selectBackend([webext, cdp], "cdp")).toBe(cdp);
  });

  it.each(["edge", "brave", "arc", "chromium"] as const)(
    "selects the matching %s WebExtension descriptor before chrome",
    (kind) => {
      const chrome = webextension("/tmp/obu/chrome.sock", "20", "chrome");
      const requested = webextension(`/tmp/obu/${kind}.sock`, "10", kind);
      expect(selectBackend([chrome, requested, cdp], kind)).toBe(requested);
    },
  );

  it("falls back to CDP when a requested Chromium-family WebExtension is absent", () => {
    const chrome = webextension("/tmp/obu/chrome.sock", "20", "chrome");
    expect(selectBackend([chrome, cdp], "edge")).toBe(cdp);
  });

  it("includes backend discovery diagnostics when no backend matches", () => {
    const fail = () =>
      selectBackend([], "chrome", [
        {
          source: "/tmp/obu/webextension/future.json",
          reason: "unsupported schema_version 999",
        },
      ]);
    expect(fail).toThrow(/Run obu verify for readiness/);
    expect(fail).toThrow(/Ignored backend descriptors: .*future\.json: unsupported schema_version 999/);
  });
});

function webextension(socketPath: string, startedAt: string, browserKind = "chrome"): DiscoveredBackend {
  return {
    type: "webextension",
    name: browserKind,
    socketPath,
    metadata: {
      browser_kind: browserKind,
      startedAt,
    },
  };
}
