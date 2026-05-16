import { describe, expect, it } from "vitest";
import { FrameDecoder, FrameEncoder } from "../src/wire/frames.js";

describe("Frame codec", () => {
  it("round-trips one frame", () => {
    const encoder = new FrameEncoder();
    const decoder = new FrameDecoder();
    const payload = new TextEncoder().encode('{"a":1}');
    const frames = decoder.feed(encoder.encode(payload));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0])).toBe('{"a":1}');
  });

  it("handles split chunks", () => {
    const encoder = new FrameEncoder();
    const decoder = new FrameDecoder();
    const wire = encoder.encode(new TextEncoder().encode("ABCDE"));
    expect(decoder.feed(wire.slice(0, 3))).toHaveLength(0);
    expect(decoder.feed(wire.slice(3, 6))).toHaveLength(0);
    const frames = decoder.feed(wire.slice(6));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0])).toBe("ABCDE");
  });
});
