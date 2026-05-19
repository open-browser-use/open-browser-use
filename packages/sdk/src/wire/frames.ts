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
  #buffer: Uint8Array = new Uint8Array();

  feed(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;

    const frames: Uint8Array[] = [];
    while (this.#buffer.length >= 4) {
      const len = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(0, true);
      if (len > MAX_FRAME_LEN) {
        throw new RangeError(`oversize frame (${len} bytes; max ${MAX_FRAME_LEN})`);
      }
      if (this.#buffer.length < 4 + len) break;
      frames.push(this.#buffer.slice(4, 4 + len));
      this.#buffer = this.#buffer.slice(4 + len);
    }
    return frames;
  }
}
