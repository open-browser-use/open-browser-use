import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const sdkVersion = "0.1.2";
const entry = new URL("../dist/index.mjs", import.meta.url);
const out = new URL("../dist/version.json", import.meta.url);
const bytes = await readFile(entry);
const sha256 = createHash("sha256").update(bytes).digest("hex");

await writeFile(
  out,
  `${JSON.stringify({ sdkVersion, sha256, signedAt: new Date().toISOString() }, null, 2)}\n`,
);
