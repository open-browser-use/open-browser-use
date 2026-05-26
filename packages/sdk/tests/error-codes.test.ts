import { describe, expect, it } from "vitest";
import {
  ERR_CDP_FAILURE,
  ERR_CONFLICT,
  ERR_DIALOG_REQUIRES_DECISION,
  ERR_DISALLOWED,
  ERR_IO,
  ERR_PEER_AUTH,
  ERR_TIMEOUT,
  ERR_TRANSPORT_CLOSED,
} from "../src/errors.js";

describe("wire error codes", () => {
  it("keep stable numeric values", () => {
    expect(ERR_TIMEOUT).toBe(-1000);
    expect(ERR_DISALLOWED).toBe(-1002);
    expect(ERR_CONFLICT).toBe(-1007);
    expect(ERR_IO).toBe(-1099);
    expect(ERR_PEER_AUTH).toBe(-1100);
    expect(ERR_CDP_FAILURE).toBe(-1201);
    expect(ERR_DIALOG_REQUIRES_DECISION).toBe(-1203);
  });

  it("derive ERR_TRANSPORT_CLOSED from ERR_IO", () => {
    expect(ERR_TRANSPORT_CLOSED).toBe(ERR_IO);
    expect(ERR_TRANSPORT_CLOSED).toBe(-1099);
  });
});
