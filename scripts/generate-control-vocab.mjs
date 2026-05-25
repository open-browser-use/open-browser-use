#!/usr/bin/env node
// Run via tsx so the import of the TypeScript source resolves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_MODE = process.argv.includes("--check");
const OUT = path.join(ROOT, "packages/browser-control-core/fixtures/control-vocab.json");

const core = await import(path.join(ROOT, "packages/browser-control-core/src/index.ts"));

const manifest = {
  schemaVersion: 1,
  taskStates: [...core.TASK_STATES],
  resumeCompleteStatuses: [...core.RESUME_COMPLETE_STATUSES],
  tabOrigins: [...core.TAB_ORIGINS],
  tabStatuses: [...core.TAB_STATUSES],
  coordinateSpaces: [...core.COORDINATE_SPACES],
  sessionControlProjections: [...core.SESSION_CONTROL_PROJECTIONS],
};
const content = JSON.stringify(manifest, null, 2) + "\n";

if (CHECK_MODE) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== content) {
    console.error(`${path.relative(ROOT, OUT)} is stale; run pnpm generate:control-vocab`);
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, content);
}
