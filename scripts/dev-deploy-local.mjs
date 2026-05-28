#!/usr/bin/env node
// Local dev deploy for open-browser-use native binaries.
//
// Prevents the macOS Sequoia host crash-loop with two guarantees:
//   1. Real-identity codesign (NOT adhoc). An adhoc/linker-signed obu-host is SIGKILLed
//      ("CODESIGNING / Invalid Page") when Chrome — a notarized, hardened-runtime app —
//      spawns it as a native-messaging host. We refuse to deploy without a real identity.
//   2. Atomic rename onto the *resolved* real target (never cp-in-place over a mapped binary,
//      and never write *through* the ~/.obu/payloads/current symlink).
//
// RELEASE NOTE: production binaries MUST be Developer-ID signed + notarized + stapled. This
// helper is for LOCAL development deploys to ~/.obu only (it uses whatever codesigning identity
// is present in the keychain, e.g. an Apple Development cert).
//
// Usage: node scripts/dev-deploy-local.mjs <src>::<dest> [<src>::<dest> ...]
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Parse `security find-identity -v -p codesigning` output; return the first identity SHA-1.
export function parseSigningIdentity(securityOutput) {
  const m = securityOutput.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"/m);
  return m ? m[1] : null;
}

export function detectSigningIdentity() {
  let out = "";
  try {
    out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  return parseSigningIdentity(out);
}

// Copy src to a temp in the dest's RESOLVED real dir, optionally sign, then atomically rename
// over the real target. Resolving symlinks first (e.g. ~/.obu/payloads/current -> versioned dir)
// keeps temp+rename on the real target fs so we replace the real inode and never write through
// a symlink over a still-mapped binary.
export function atomicReplace(src, dest, { identity = null } = {}) {
  const destDir = realpathSync(path.dirname(dest));
  const realDest = path.join(destDir, path.basename(dest));
  const tmp = path.join(destDir, `.${path.basename(dest)}.deploy.${process.pid}`);
  copyFileSync(src, tmp);
  chmodSync(tmp, 0o755);
  if (identity && process.platform === "darwin") {
    execFileSync("codesign", ["--force", "-s", identity, tmp], { stdio: "inherit" });
    execFileSync("codesign", ["-v", tmp], { stdio: "inherit" });
  }
  renameSync(tmp, realDest); // atomic, new inode, on the resolved real target
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    console.error("usage: dev-deploy-local.mjs <src>::<dest> [<src>::<dest> ...]");
    process.exit(64);
  }
  const identity = process.platform === "darwin" ? detectSigningIdentity() : null;
  if (process.platform === "darwin" && !identity) {
    console.error(
      "ERROR: no codesigning identity found (security find-identity -v -p codesigning).",
    );
    console.error(
      "Refusing to deploy an adhoc-signed host — Chrome-spawned hosts are SIGKILLed " +
        "(CODESIGNING/Invalid Page) on macOS Sequoia. Install an Apple Development or " +
        "Developer ID identity, then retry.",
    );
    process.exit(2);
  }
  for (const pair of argv) {
    const idx = pair.indexOf("::");
    if (idx < 0) {
      console.error(`bad pair (expected src::dest): ${pair}`);
      process.exit(64);
    }
    const src = pair.slice(0, idx);
    const dest = pair.slice(idx + 2);
    atomicReplace(src, dest, { identity });
    console.log(`deployed ${path.basename(dest)} (identity ${identity ?? "none/non-darwin"})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
