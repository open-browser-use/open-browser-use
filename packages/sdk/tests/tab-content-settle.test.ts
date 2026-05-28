import { describe, expect, it } from "vitest";
import { Guards } from "../src/guards.js";
import { Tab } from "../src/tab.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

// Returns the queued fingerprints in order, then repeats the last one forever —
// models a DOM that mutates a few times after load and then stabilizes.
class SettleTransport {
  calls: Array<{ method: string }> = [];
  private i = 0;
  constructor(private readonly fingerprints: string[]) {}
  async sendRequest<T>(method: string): Promise<T> {
    this.calls.push({ method });
    if (method !== M.TAB_EVALUATE) throw new Error(`unexpected method ${method}`);
    const fp = this.fingerprints[Math.min(this.i, this.fingerprints.length - 1)];
    this.i += 1;
    return { result: { value: fp } } as T;
  }
}

// Models a page whose DOM never stops mutating (every read differs).
class ChurnTransport {
  calls: Array<{ method: string }> = [];
  private i = 0;
  async sendRequest<T>(method: string): Promise<T> {
    this.calls.push({ method });
    if (method !== M.TAB_EVALUATE) throw new Error(`unexpected method ${method}`);
    return { result: { value: `n${this.i++}` } } as T;
  }
}

function makeTab(transport: { sendRequest: Transport["sendRequest"] }): Tab {
  return new Tab(
    transport as unknown as Transport,
    new Guards(),
    "tab-1",
    { commandable: true, owned: true },
    { supportedMethods: [M.TAB_EVALUATE] },
  );
}

describe("tab.waitForContentSettle", () => {
  it("resolves { settled: true, reason: 'quiet' } once the DOM fingerprint stops changing", async () => {
    const transport = new SettleTransport(["1:5", "2:8", "9:20"]);
    const tab = makeTab(transport);

    const result = await tab.waitForContentSettle({ quietMs: 20, pollMs: 2, timeout: 2000 });

    expect(result.settled).toBe(true);
    expect(result.reason).toBe("quiet");
    expect(result.samples).toBeGreaterThan(1);
    expect(transport.calls.every((c) => c.method === M.TAB_EVALUATE)).toBe(true);
  });

  it("resolves { settled: false, reason: 'timeout' } when the DOM never stabilizes", async () => {
    const transport = new ChurnTransport();
    const tab = makeTab(transport);

    const result = await tab.waitForContentSettle({ quietMs: 50, pollMs: 2, timeout: 60 });

    expect(result.settled).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.samples).toBeGreaterThan(1);
  });
});
