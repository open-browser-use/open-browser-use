#!/usr/bin/env node
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "dist", "npm");
const wrapperSource = path.join(root, "scripts", "npm", "obu-wrapper.cjs");
const licenseFile = path.join(root, "LICENSE");

const targets = [
  { name: "@open-browser-use/cli-darwin-arm64", dir: "cli-darwin-arm64", p4Target: "darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
  { name: "@open-browser-use/cli-darwin-x64", dir: "cli-darwin-x64", p4Target: "darwin-x64", os: ["darwin"], cpu: ["x64"] },
  { name: "@open-browser-use/cli-linux-x64-gnu", dir: "cli-linux-x64-gnu", p4Target: "linux-x64-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
  { name: "@open-browser-use/cli-linux-x64-musl", dir: "cli-linux-x64-musl", p4Target: "linux-x64-musl", os: ["linux"], cpu: ["x64"], libc: ["musl"] },
  { name: "@open-browser-use/cli-linux-arm64-gnu", dir: "cli-linux-arm64-gnu", p4Target: "linux-arm64-gnu", os: ["linux"], cpu: ["arm64"], libc: ["glibc"] },
];

const args = parseArgs(process.argv.slice(2));
const version = await workspaceCliVersion();
const sdkVersion = await packageVersion(path.join(root, "packages", "sdk", "package.json"));
const cliManifest = JSON.parse(await readFile(path.join(root, "packages", "cli", "package.json"), "utf8"));
const jsoncParserVersion = cliManifest.dependencies?.["jsonc-parser"];
if (typeof jsoncParserVersion !== "string") throw new Error("packages/cli must declare jsonc-parser as a dependency");
const payloads = await collectPayloads(args);

await rm(outRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
await stageWrapper(version);
for (const target of targets) {
  await stagePlatformPackage(
    target,
    version,
    sdkVersion,
    jsoncParserVersion,
    payloads.get(target.p4Target),
  );
}

console.log(`staged npm packages in ${outRoot}`);

async function stageWrapper(packageVersion) {
  const wrapperRoot = path.join(outRoot, "cli");
  await mkdir(path.join(wrapperRoot, "bin"), { recursive: true });
  await cp(wrapperSource, path.join(wrapperRoot, "bin", "obu"));
  await cp(wrapperSource, path.join(wrapperRoot, "bin", "open-browser-use"));
  await cp(licenseFile, path.join(wrapperRoot, "LICENSE"));
  await chmod(path.join(wrapperRoot, "bin", "obu"), 0o755);
  await chmod(path.join(wrapperRoot, "bin", "open-browser-use"), 0o755);
  await writeJson(path.join(wrapperRoot, "package.json"), {
    name: "@open-browser-use/cli",
    version: packageVersion,
    private: false,
    description: "open-browser-use command line wrapper and platform payload resolver.",
    license: "MIT",
    bin: { obu: "bin/obu", "open-browser-use": "bin/open-browser-use" },
    files: ["bin", "LICENSE"],
    optionalDependencies: Object.fromEntries(targets.map((target) => [target.name, packageVersion])),
  });
}

async function stagePlatformPackage(target, packageVersion, sdkPackageVersion, jsoncPackageVersion, payloadDir) {
  const packageRoot = path.join(outRoot, target.dir);
  await mkdir(packageRoot, { recursive: true });
  const manifest = {
    name: target.name,
    version: packageVersion,
    private: false,
    description: `open-browser-use platform payload for ${target.dir.replace(/^cli-/, "")}.`,
    license: "MIT",
    os: target.os,
    cpu: target.cpu,
    ...(target.libc ? { libc: target.libc } : {}),
    dependencies: {
      "@open-browser-use/sdk": sdkPackageVersion,
      "jsonc-parser": jsoncPackageVersion,
    },
    bundledDependencies: ["@open-browser-use/sdk", "jsonc-parser"],
    files: ["bin", "cli", "node", "node_modules", "extension", "metadata.json", "LICENSE-THIRD-PARTY.md"],
  };
  await writeJson(path.join(packageRoot, "package.json"), manifest);
  await cp(licenseFile, path.join(packageRoot, "LICENSE"));
  if (payloadDir) {
    await cp(payloadDir, packageRoot, { recursive: true, force: true, dereference: true });
  }
}

async function workspaceCliVersion() {
  return packageVersion(path.join(root, "packages", "cli", "package.json"));
}

async function packageVersion(file) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (typeof manifest.version !== "string") throw new Error(`${file} is missing version`);
  return manifest.version;
}

async function targetFromPayload(payloadDir) {
  const metadata = JSON.parse(await readFile(path.join(payloadDir, "metadata.json"), "utf8"));
  if (typeof metadata.targetTriple !== "string") {
    throw new Error(`${path.join(payloadDir, "metadata.json")} is missing targetTriple`);
  }
  return metadata.targetTriple;
}

async function collectPayloads(options) {
  const payloadDirs = [...options.payloads];
  for (const rootDir of options.payloadRoots) {
    for (const entry of await readdir(rootDir, { withFileTypes: true })) {
      if (entry.isDirectory()) payloadDirs.push(path.join(rootDir, entry.name));
    }
  }

  const payloads = new Map();
  for (const payloadDir of payloadDirs) {
    const payloadTarget = await targetFromPayload(payloadDir);
    if (!targets.some((target) => target.p4Target === payloadTarget)) {
      throw new Error(`payload target ${payloadTarget} from ${payloadDir} is not a supported P4a npm target`);
    }
    if (payloads.has(payloadTarget)) {
      throw new Error(`duplicate payload for ${payloadTarget}: ${payloads.get(payloadTarget)} and ${payloadDir}`);
    }
    payloads.set(payloadTarget, payloadDir);
  }
  return payloads;
}

function parseArgs(argv) {
  const parsed = { payloads: [], payloadRoots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a directory`);
      return argv[index];
    };
    if (flag === "--payload") {
      parsed.payloads.push(path.resolve(readValue()));
      continue;
    }
    if (flag === "--payload-root") {
      parsed.payloadRoots.push(path.resolve(readValue()));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
