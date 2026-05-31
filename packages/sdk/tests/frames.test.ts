import { describe, expect, it } from "vitest";
import { FrameDecoder, FrameEncoder, MAX_FRAME_LEN } from "../src/wire/frames.js";

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

  it("rejects oversize frame headers", () => {
    const decoder = new FrameDecoder();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_LEN + 1, true);

    expect(() => decoder.feed(header)).toThrow(/oversize frame/);
  });

  it("rejects oversize encoded payloads", () => {
    const encoder = new FrameEncoder();

    expect(() => encoder.encode(new Uint8Array(MAX_FRAME_LEN + 1))).toThrow(/oversize frame/);
  });

  it("decodes multiple frames fed one byte at a time", () => {
    const encoder = new FrameEncoder();
    const decoder = new FrameDecoder();
    const wire = new Uint8Array([
      ...encoder.encode(new TextEncoder().encode("one")),
      ...encoder.encode(new TextEncoder().encode("two")),
      ...encoder.encode(new TextEncoder().encode("three")),
    ]);
    const out: string[] = [];
    for (const byte of wire) {
      for (const frame of decoder.feed(new Uint8Array([byte]))) {
        out.push(new TextDecoder().decode(frame));
      }
    }
    expect(out).toEqual(["one", "two", "three"]);
  });

  it("reads a length prefix that is split across feeds", () => {
    const encoder = new FrameEncoder();
    const decoder = new FrameDecoder();
    const wire = encoder.encode(new TextEncoder().encode("payload"));
    expect(decoder.feed(wire.slice(0, 2))).toHaveLength(0);
    const frames = decoder.feed(wire.slice(2));
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0])).toBe("payload");
  });

  it("emitted frames are independent of subsequent feeds", () => {
    const encoder = new FrameEncoder();
    const decoder = new FrameDecoder();
    const [first] = decoder.feed(encoder.encode(new TextEncoder().encode("AAAA")));
    const snapshot = new Uint8Array(first);
    decoder.feed(encoder.encode(new TextEncoder().encode("BBBBBBBB")));
    expect(first).toEqual(snapshot);
  });

  it("reassembles a large frame fragmented across 64KiB chunks", () => {
    const encoder = new FrameEncoder();
    const decoder = new FrameDecoder();
    const big = new Uint8Array(1_000_000).map((_, i) => i & 0xff);
    const wire = encoder.encode(big);
    let frames: Uint8Array[] = [];
    for (let off = 0; off < wire.length; off += 65536) {
      frames = frames.concat(decoder.feed(wire.slice(off, off + 65536)));
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(big);
  });
});
