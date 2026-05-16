#!/usr/bin/env node
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "dev.obu.host";
const EXTENSION_ID_ALPHABET_OFFSET = "a".charCodeAt(0);

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = path.resolve(packageRoot, "..", "..");
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const manifestPath = resolvePath(
  options.manifestPath ?? path.join(packageRoot, "public", "manifest.json"),
);
const extensionManifest = JSON.parse(await readFile(manifestPath, "utf8"));
const extensionId = options.extensionId ?? extensionIdFromManifestKey(extensionManifest.key);

if (options.printExtensionId) {
  console.log(extensionId);
  process.exit(0);
}

const browserNames = browserList(options.browser ?? "chrome");
if (options.outputDir && browserNames.length > 1) {
  throw new Error("--output-dir can only be used with one --browser value");
}

const hostBinary = resolvePath(
  options.hostBinary ??
    process.env.OBU_HOST_BIN ??
    path.join(repoRoot, "target", "debug", process.platform === "win32" ? "obu-host.exe" : "obu-host"),
);
if (!options.skipHostCheck) {
  await access(hostBinary, constants.X_OK).catch((error) => {
    throw new Error(
      `host binary is not executable: ${hostBinary}\n` +
        `Run cargo build -p obu-host or pass --host-binary /absolute/path/to/obu-host.\n` +
        `Original error: ${error.message}`,
    );
  });
}

const wrapperDir = resolvePath(options.wrapperDir ?? path.join(packageRoot, ".dev-native-host"));
await mkdir(wrapperDir, { recursive: true });

const manifests = [];
for (const browser of browserNames) {
  const browserKind = browser === "chrome-for-testing" ? "chrome" : browser;
  const wrapperPath = path.join(wrapperDir, `obu-host-native-wrapper-${browser}`);
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexport OBU_BROWSER_KIND=${shellQuote(browserKind)}\nexec ${shellQuote(hostBinary)} --native-messaging\n`,
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  const nativeManifest = {
    name: HOST_NAME,
    description: "open-browser-use development native messaging host",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const targetDir = options.outputDir
    ? resolvePath(options.outputDir)
    : nativeMessagingHostDir(browser);
  await mkdir(targetDir, { recursive: true });
  const manifestFile = path.join(targetDir, `${HOST_NAME}.json`);
  await writeFile(manifestFile, `${JSON.stringify(nativeManifest, null, 2)}\n`, "utf8");
  await chmod(manifestFile, 0o644);
  manifests.push({ browser, browserKind, manifestFile, wrapperPath });
}

console.log(
  JSON.stringify(
    {
      hostName: HOST_NAME,
      extensionId,
      allowedOrigin: `chrome-extension://${extensionId}/`,
      hostBinary,
      manifests,
    },
    null,
    2,
  ),
);

function parseArgs(argv) {
  const parsed = {
    skipHostCheck: false,
    printExtensionId: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    const [flag, inlineValue] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    switch (flag) {
      case "--browser":
        parsed.browser = readValue();
        break;
      case "--host-binary":
        parsed.hostBinary = readValue();
        break;
      case "--output-dir":
        parsed.outputDir = readValue();
        break;
      case "--wrapper-dir":
        parsed.wrapperDir = readValue();
        break;
      case "--manifest-path":
        parsed.manifestPath = readValue();
        break;
      case "--extension-id":
        parsed.extensionId = readValue();
        break;
      case "--skip-host-check":
        parsed.skipHostCheck = true;
        break;
      case "--print-extension-id":
        parsed.printExtensionId = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function browserList(value) {
  const normalized = value.toLowerCase();
  if (normalized === "all") {
    return process.platform === "darwin"
      ? ["chrome", "edge", "brave", "arc", "chromium"]
      : ["chrome", "edge", "brave", "chromium"];
  }
  const browsers = normalized.split(",").map((item) => item.trim()).filter(Boolean);
  if (browsers.length === 0) throw new Error("--browser must not be empty");
  for (const browser of browsers) {
    if (!["chrome", "chrome-for-testing", "edge", "brave", "arc", "chromium"].includes(browser)) {
      throw new Error(`unsupported browser: ${browser}`);
    }
  }
  return browsers;
}

function nativeMessagingHostDir(browser) {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support");
    const browserDirs = {
      chrome: path.join(appSupport, "Google", "Chrome", "NativeMessagingHosts"),
      "chrome-for-testing": path.join(appSupport, "Google", "Chrome for Testing", "NativeMessagingHosts"),
      edge: path.join(appSupport, "Microsoft Edge", "NativeMessagingHosts"),
      brave: path.join(appSupport, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      arc: path.join(appSupport, "Arc", "User Data", "NativeMessagingHosts"),
      chromium: path.join(appSupport, "Chromium", "NativeMessagingHosts"),
    };
    return browserDirs[browser];
  }
  if (process.platform === "linux") {
    if (browser === "arc") throw new Error("Arc native messaging is only supported on macOS");
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    const browserDirs = {
      chrome: path.join(configRoot, "google-chrome", "NativeMessagingHosts"),
      "chrome-for-testing": path.join(configRoot, "google-chrome-for-testing", "NativeMessagingHosts"),
      edge: path.join(configRoot, "microsoft-edge", "NativeMessagingHosts"),
      brave: path.join(configRoot, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      chromium: path.join(configRoot, "chromium", "NativeMessagingHosts"),
    };
    return browserDirs[browser];
  }
  throw new Error("P3 dev native-host manifest writer supports macOS and Linux");
}

function extensionIdFromManifestKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("manifest key is required; pass --extension-id to override");
  }
  const der = Buffer.from(key, "base64");
  if (der.length === 0) throw new Error("manifest key is not valid base64");
  const hash = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...hash]
    .map((byte) => `${nibbleToIdChar(byte >> 4)}${nibbleToIdChar(byte & 0x0f)}`)
    .join("");
}

function nibbleToIdChar(nibble) {
  return String.fromCharCode(EXTENSION_ID_ALPHABET_OFFSET + nibble);
}

function resolvePath(value) {
  return path.resolve(process.cwd(), value);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printHelp() {
  console.log(`Usage: pnpm -C packages/extension dev:manifest -- [options]

Options:
  --browser chrome|chrome-for-testing|edge|brave|arc|chromium|all
                                                 Browser manifest target (default: chrome)
  --host-binary PATH                            obu-host binary (default: target/debug/obu-host)
  --output-dir PATH                             Write manifest into this directory
  --wrapper-dir PATH                            Write wrapper script into this directory
  --manifest-path PATH                          Extension manifest to read the dev key from
  --extension-id ID                             Override ID instead of deriving it from manifest.key
  --print-extension-id                          Print the derived extension ID
  --skip-host-check                             Do not require the host binary to exist
`);
}
