import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const dist = path.join(packageRoot, "dist");
const vendorModule = path.join(dist, "vendor", "browser-control-core.mjs");

await access(vendorModule);
await access(path.join(dist, "pairing.html"));
await access(path.join(dist, "pairing.css"));

const bareWorkspaceImports = [];
for (const file of await listFiles(dist)) {
  if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
  const contents = await readFile(file, "utf8");
  if (contents.includes("@open-browser-use/")) {
    bareWorkspaceImports.push(path.relative(dist, file));
  }
}
assert.deepEqual(bareWorkspaceImports, [], "extension dist must not ship bare workspace package imports");

const browserSessionMachine = await readFile(path.join(dist, "lifecycle", "browser_session_machine.js"), "utf8");
assert.match(browserSessionMachine, /from "\.\.\/vendor\/browser-control-core\.mjs"/);

const finalizeTabsMachine = await readFile(path.join(dist, "lifecycle", "finalize_tabs_machine.js"), "utf8");
assert.match(finalizeTabsMachine, /from "\.\.\/vendor\/browser-control-core\.mjs"/);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}
