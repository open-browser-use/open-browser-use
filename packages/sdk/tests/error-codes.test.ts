import { describe, expect, test } from "vitest";
import { ERR_TRANSPORT_CLOSED, ERR_IO, productErrorForRpcCode } from "../src/errors.js";

describe("transport-closed wire code", () => {
  test("is distinct from generic ERR_IO", () => {
    expect(ERR_TRANSPORT_CLOSED).not.toBe(ERR_IO);
    expect(ERR_TRANSPORT_CLOSED).toBe(-1098);
  });

  test("maps to the transport_closed product error; ERR_IO no longer does", () => {
    expect(productErrorForRpcCode(ERR_TRANSPORT_CLOSED)?.code).toBe("transport_closed");
    expect(productErrorForRpcCode(ERR_IO)?.code).not.toBe("transport_closed");
  });
});
