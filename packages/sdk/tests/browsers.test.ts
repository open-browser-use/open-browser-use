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

  it("treats chrome as WebExtension-only by default", () => {
    expect(() => selectBackend([cdp], "chrome")).toThrow(/no backend available for chrome/);
  });

  it("does not silently fall back to CDP for Chromium-family browser names", () => {
    const chrome = webextension("/tmp/obu/chrome.sock", "20", "chrome");
    expect(() => selectBackend([chrome, cdp], "edge")).toThrow(/no backend available for edge/);
  });

  it("allows an explicit WebExtension assertion that matches the default", () => {
    const webext = webextension("/tmp/obu/chrome.sock", "10");
    expect(selectBackend([cdp, webext], "chrome", [], { requireBackend: "webextension" })).toBe(webext);
  });

  it("keeps the CDP escape hatch visibly explicit", () => {
    expect(selectBackend([cdp], "chrome", [], { backend: "cdp" })).toBe(cdp);
    expect(selectBackend([cdp], "cdp")).toBe(cdp);
  });

  it("applies backend assertions before the dedicated CDP shortcut", () => {
    expect(() => selectBackend([cdp], "cdp", [], { requireBackend: "webextension" })).toThrow(
      /no backend available for cdp/,
    );
    expect(() => selectBackend([cdp], "cdp", [], { backend: "webextension" })).toThrow(
      /no backend available for cdp/,
    );
    expect(selectBackend([cdp], "cdp", [], { backend: "cdp" })).toBe(cdp);
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

  it("fails fast when a requested Chromium-family WebExtension is absent", () => {
    const chrome = webextension("/tmp/obu/chrome.sock", "20", "chrome");
    const fail = () => selectBackend([chrome, cdp], "edge");
    expect(fail).toThrow(/no backend available for edge/);
    expect(fail).toThrow(/Ignored available backends: webextension:chrome/);
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

  it("includes ignored available backend diagnostics and verify hints when CDP is present but not continuity-safe", () => {
    try {
      selectBackend([cdp], "chrome");
      throw new Error("expected selectBackend to fail");
    } catch (error) {
      expect(error).toMatchObject({
        data: expect.objectContaining({
          code: "no_backend",
          requested_backend: "chrome",
          ignored_backends: expect.arrayContaining([expect.stringContaining("cdp:cdp")]),
          verify_hint: expect.stringContaining("obu verify"),
        }),
      });
    }
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
