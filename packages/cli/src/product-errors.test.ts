import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PRODUCT_ERROR_SCHEMA } from "./product_errors.generated.js";

test("CLI product errors are generated from the repo-level schema", () => {
  const schema = JSON.parse(readFileSync(new URL("../../../product-errors.json", import.meta.url), "utf8"));
  assert.equal(schema.schemaVersion, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(PRODUCT_ERROR_SCHEMA)), schema.errors);
});
