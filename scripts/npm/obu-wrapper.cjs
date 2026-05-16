#!/usr/bin/env node
"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var path = require("path");

var PLATFORM_PACKAGES = {
  "darwin-arm64": "@open-browser-use/cli-darwin-arm64",
  "darwin-x64": "@open-browser-use/cli-darwin-x64",
  "linux-x64-gnu": "@open-browser-use/cli-linux-x64-gnu",
  "linux-x64-musl": "@open-browser-use/cli-linux-x64-musl",
  "linux-arm64-gnu": "@open-browser-use/cli-linux-arm64-gnu"
};

function main(argv) {
  var override = process.env.OBU_BINARY;
  if (override) {
    return spawnAndExit(override, argv, process.env);
  }

  var packageName = resolvePayloadPackage();
  var payloadRoot = findPackageRoot(packageName);
  var nodeBin = process.env.OBU_NODE_BINARY || path.join(payloadRoot, "node", "bin", "node");
  var cliEntry = path.join(payloadRoot, "cli", "dist", "index.js");
  if (!fs.existsSync(nodeBin)) {
    throw new Error("open-browser-use payload is missing bundled Node at " + nodeBin);
  }
  if (!fs.existsSync(cliEntry)) {
    throw new Error("open-browser-use payload is missing CLI entry at " + cliEntry);
  }
  var env = copyEnv(process.env);
  env.OBU_PAYLOAD_ROOT = payloadRoot;
  env.OBU_NODE_BINARY = nodeBin;
  env.OBU_COMMAND = process.argv[1];
  return spawnAndExit(nodeBin, [cliEntry].concat(argv), env);
}

function resolvePayloadPackage(input) {
  input = input || {};
  var platform = input.platform || process.platform;
  var arch = input.arch || process.arch;
  if (platform === "darwin") {
    if (arch === "arm64") return PLATFORM_PACKAGES["darwin-arm64"];
    if (arch === "x64") return PLATFORM_PACKAGES["darwin-x64"];
    throw unsupported(platform, arch);
  }
  if (platform === "linux") {
    var libc = input.libc || detectLibc(input);
    if (arch === "x64" && libc === "gnu") return PLATFORM_PACKAGES["linux-x64-gnu"];
    if (arch === "x64" && libc === "musl") return PLATFORM_PACKAGES["linux-x64-musl"];
    if (arch === "arm64" && libc === "gnu") return PLATFORM_PACKAGES["linux-arm64-gnu"];
    if (libc === "unknown") {
      throw new Error("could not detect Linux libc for open-browser-use; set OBU_BINARY to an explicit executable override");
    }
    throw unsupported(platform, arch + "-" + libc);
  }
  throw unsupported(platform, arch);
}

function detectLibc(input) {
  input = input || {};
  var platform = input.platform || process.platform;
  if (platform !== "linux") return "unknown";
  var report = input.report || process.report;
  if (report && typeof report.getReport === "function") {
    try {
      var data = report.getReport();
      if (data && data.header) {
        if (typeof data.header.glibcVersionRuntime === "string") return "gnu";
        return "musl";
      }
    } catch (_error) {
      // Fall through to the ldd probe below.
    }
  }
  try {
    var result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    var output = String(result.stdout || "") + String(result.stderr || "");
    if (/musl/i.test(output)) return "musl";
    if (/glibc|gnu libc|free software foundation/i.test(output)) return "gnu";
  } catch (_error) {
    // Return unknown below.
  }
  return "unknown";
}

function findPackageRoot(packageName) {
  try {
    return path.dirname(require.resolve(packageName + "/package.json"));
  } catch (error) {
    throw new Error(
      "open-browser-use platform payload package " + packageName + " is not installed. " +
      "Reinstall @open-browser-use/cli with optional dependencies enabled, or set OBU_BINARY."
    );
  }
}

function spawnAndExit(command, args, env) {
  var result = childProcess.spawnSync(command, args, { stdio: "inherit", env: env });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number") return result.status;
  return 1;
}

function unsupported(platform, arch) {
  return new Error(
    "open-browser-use does not provide a P4a payload for " + platform + "/" + arch + ". " +
    "Supported targets are darwin arm64/x64 and linux x64 gnu/musl plus linux arm64 gnu. " +
    "Set OBU_BINARY to an explicit executable override if you are testing a custom build."
  );
}

function copyEnv(env) {
  var copy = {};
  Object.keys(env).forEach(function (key) {
    copy[key] = env[key];
  });
  return copy;
}

module.exports = {
  PLATFORM_PACKAGES: PLATFORM_PACKAGES,
  detectLibc: detectLibc,
  main: main,
  resolvePayloadPackage: resolvePayloadPackage
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}
