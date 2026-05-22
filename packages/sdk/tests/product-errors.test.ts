import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ERR_DIALOG_REQUIRES_DECISION,
  ERR_DISALLOWED,
  ERR_NO_BACKEND,
  ERR_NOT_IMPLEMENTED,
  ERR_TIMEOUT,
  ERR_TRANSPORT_CLOSED,
  ObuError,
  PRODUCT_ERROR_MATRIX,
  productErrorByCode,
  productErrorData,
  productErrorForRpcCode,
} from "../src/errors.js";

describe("product error matrix", () => {
  it("uses the repo-level product error schema", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../product-errors.json", import.meta.url), "utf8"));
    expect(schema.schemaVersion).toBe(1);
    expect(JSON.parse(JSON.stringify(PRODUCT_ERROR_MATRIX))).toEqual(schema.errors);
  });

  it("maps runtime rpc errors to product errors and preserves data on ObuError", () => {
    expect(productErrorForRpcCode(ERR_NO_BACKEND)?.code).toBe("no_backend");
    expect(productErrorForRpcCode(ERR_DIALOG_REQUIRES_DECISION)?.code).toBe("dialog_requires_decision");
    expect(productErrorForRpcCode(ERR_DISALLOWED)?.code).toBe("disallowed_command");
    expect(productErrorForRpcCode(ERR_NOT_IMPLEMENTED)).toBeUndefined();

    const data = productErrorData("dialog_requires_decision", {
      tab_id: "42",
      dialog_type: "confirm",
      default_action: "dismiss",
    });
    const error = new ObuError(ERR_DIALOG_REQUIRES_DECISION, "dialog_requires_decision", data);

    expect(error.code).toBe(ERR_DIALOG_REQUIRES_DECISION);
    expect(error.data).toBe(data);
    expect(error.productError?.code).toBe("dialog_requires_decision");
    expect(error.toJSON()).toMatchObject({
      code: ERR_DIALOG_REQUIRES_DECISION,
      data,
      product_error: productErrorByCode("dialog_requires_decision"),
    });
  });
});
