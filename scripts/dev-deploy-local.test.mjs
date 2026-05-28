#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, "dev-deploy-local.mjs"));

test("parseSigningIdentity picks the first identity hash", () => {
  const out =
    '  1) 0E0709B2E0FD56855FF9849C1EB00D450DC59922 "Apple Development: a@b.com (TEAM1)"\n' +
    '  2) 38F07963341D3DB5420B55A0B68A44A141AECD96 "Developer ID Application: X (TEAM2)"\n' +
    "     2 valid identities found";
  assert.equal(mod.parseSigningIdentity(out), "0E0709B2E0FD56855FF9849C1EB00D450DC59922");
});

test("parseSigningIdentity returns null when there are none", () => {
  assert.equal(mod.parseSigningIdentity("     0 valid identities found"), null);
  assert.equal(mod.parseSigningIdentity(""), null);
});

test("atomicReplace resolves a symlinked dest dir and replaces the real target inode", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "obu-deploy-"));
  const realDir = path.join(base, "versioned");
  await mkdir(realDir);
  const link = path.join(base, "current");
  await symlink(realDir, link); // current -> versioned (mirrors ~/.obu/payloads/current)
  const dest = path.join(link, "obu-host"); // path goes *through* the symlink
  await writeFile(path.join(realDir, "obu-host"), "OLD");
  const src = path.join(base, "src-bin");
  await writeFile(src, "NEW");

  mod.atomicReplace(src, dest, { identity: null }); // no signing in test

  // The real versioned dir must hold the new bytes (symlink resolved, real inode replaced).
  assert.equal(await readFile(path.join(realDir, "obu-host"), "utf8"), "NEW");
  const st = await stat(path.join(realDir, "obu-host"));
  assert.equal(st.mode & 0o777, 0o755);
});
