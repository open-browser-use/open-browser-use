import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "product-errors.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));

if (schema.schemaVersion !== 1 || !Array.isArray(schema.errors)) {
  throw new Error("product-errors.json must contain schemaVersion 1 and an errors array");
}

const ts = `// Generated from product-errors.json by scripts/generate-product-errors.mjs.
// Do not edit by hand.

export const PRODUCT_ERROR_SCHEMA = ${JSON.stringify(schema.errors, null, 2)} as const;
`;

await writeFile(path.join(root, "packages/sdk/src/product_errors.generated.ts"), ts);
await writeFile(path.join(root, "packages/cli/src/product_errors.generated.ts"), ts);
