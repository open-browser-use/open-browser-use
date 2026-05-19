import { afterEach, describe, expect, it } from "vitest";
import { clearSessionMetaCacheForTests, getSessionMeta } from "../src/session-meta.js";

describe("session metadata", () => {
  afterEach(() => {
    delete (globalThis as { obuRepl?: unknown }).obuRepl;
    clearSessionMetaCacheForTests();
  });

  it("does not reuse a stale turn id after active request metadata is gone", () => {
    const global = globalThis as { obuRepl?: { requestMeta?: unknown } };
    global.obuRepl = {
      requestMeta: {
        "x-obu-turn-metadata": { session_id: "session-1", turn_id: "turn-1" },
      },
    };

    expect(getSessionMeta()).toEqual({ session_id: "session-1", turn_id: "turn-1" });

    delete global.obuRepl.requestMeta;

    expect(getSessionMeta()).toEqual({ session_id: "session-1" });
  });
});
