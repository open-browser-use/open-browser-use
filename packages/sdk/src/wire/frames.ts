/** 4-byte little-endian length-prefix codec; mirrors `obu-wire::FrameCodec`. */
export const MAX_FRAME_LEN = 16 * 1024 * 1024;

export class FrameEncoder {
  encode(payload: Uint8Array): Uint8Array {
    if (payload.length > MAX_FRAME_LEN) {
      throw new RangeError(`oversize frame (${payload.length} bytes; max ${MAX_FRAME_LEN})`);
    }
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length, true);
    out.set(payload, 4);
    return out;
  }
}

export class FrameDecoder {
  #buffer: Uint8Array = new Uint8Array(0);
  #start = 0; // offset of the first unconsumed byte
  #end = 0; // offset just past the last valid byte

  feed(chunk: Uint8Array): Uint8Array[] {
    this.#append(chunk);

    const frames: Uint8Array[] = [];
    while (this.#end - this.#start >= 4) {
      const len = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + this.#start,
        4,
      ).getUint32(0, true);
      if (len > MAX_FRAME_LEN) {
        throw new RangeError(`oversize frame (${len} bytes; max ${MAX_FRAME_LEN})`);
      }
      if (this.#end - this.#start < 4 + len) break;
      const bodyStart = this.#start + 4;
      // `.slice` returns an independent copy, decoupled from the backing store.
      frames.push(this.#buffer.slice(bodyStart, bodyStart + len));
      this.#start = bodyStart + len;
    }

    // Reset cursors when fully drained so the (grown) backing store is reused
    // for the next burst without leftward drift.
    if (this.#start === this.#end) {
      this.#start = 0;
      this.#end = 0;
    }
    return frames;
  }

  #append(chunk: Uint8Array): void {
    const unconsumed = this.#end - this.#start;
    const roomAtEnd = this.#buffer.length - this.#end;
    if (chunk.length <= roomAtEnd) {
      this.#buffer.set(chunk, this.#end);
      this.#end += chunk.length;
      return;
    }
    // Grow geometrically so a frame fragmented across many chunks amortizes to
    // O(n) total copying instead of O(n²). Compact unconsumed bytes to offset 0.
    const required = unconsumed + chunk.length;
    const capacity = Math.max(required, this.#buffer.length * 2);
    const next = new Uint8Array(capacity);
    next.set(this.#buffer.subarray(this.#start, this.#end), 0);
    next.set(chunk, unconsumed);
    this.#buffer = next;
    this.#start = 0;
    this.#end = required;
  }
}
