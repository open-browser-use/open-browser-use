import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const workspaceRoot = dirname(dirname(root));
const browserControlCoreRoot = join(workspaceRoot, "packages", "browser-control-core");
const dist = join(root, "dist");
const pub = join(root, "public");
const browserControlCoreSpecifier = "@open-browser-use/browser-control-core";
const browserControlCoreVendor = join(dist, "vendor", "browser-control-core.mjs");
const args = parseArgs(process.argv.slice(2));
const extensionChannel = args.channel ?? process.env.OBU_EXTENSION_CHANNEL ?? "unpacked-dev";
if (extensionChannel !== "unpacked-dev" && extensionChannel !== "store") {
  throw new Error(`unsupported extension channel: ${extensionChannel}`);
}

await mkdir(dist, { recursive: true });

await cp(join(pub, "popup.html"), join(dist, "popup.html"));
await cp(join(pub, "popup.css"), join(dist, "popup.css"));
await cp(join(pub, "options.html"), join(dist, "options.html"));
await cp(join(pub, "options.css"), join(dist, "options.css"));
await rm(join(dist, "icons"), { recursive: true, force: true });
await cp(join(pub, "icons"), join(dist, "icons"), { recursive: true });
await rm(join(dist, "_locales"), { recursive: true, force: true });
await cp(join(pub, "_locales"), join(dist, "_locales"), { recursive: true });
await stageBrowserControlCoreVendor();
await rewriteBrowserControlCoreImports();

const manifest = JSON.parse(await readFile(join(pub, "manifest.json"), "utf8"));
manifest.version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const popupPath = join(dist, "popup.js");
const popup = await readFile(popupPath, "utf8");
await writeFile(
  popupPath,
  popup.replace(
    /const EXTENSION_CHANNEL = "(?:__OBU_EXTENSION_CHANNEL__|unpacked-dev|store)";/,
    `const EXTENSION_CHANNEL = ${JSON.stringify(extensionChannel)};`,
  ),
  "utf8",
);

async function stageBrowserControlCoreVendor() {
  const vendorDir = dirname(browserControlCoreVendor);
  await rm(vendorDir, { recursive: true, force: true });
  await mkdir(vendorDir, { recursive: true });
  const coreDist = join(browserControlCoreRoot, "dist");
  const source = join(coreDist, "index.mjs");
  let contents;
  try {
    contents = await readFile(source, "utf8");
  } catch (error) {
    throw new Error(`browser-control-core dist is missing at ${source}; run pnpm -C packages/browser-control-core build first`, { cause: error });
  }
  await writeFile(
    browserControlCoreVendor,
    contents.replace(/\/\/# sourceMappingURL=index\.mjs\.map\s*/g, ""),
    "utf8",
  );
}

async function rewriteBrowserControlCoreImports() {
  for (const file of await listFiles(dist)) {
    if (!file.endsWith(".js")) continue;
    const contents = await readFile(file, "utf8");
    if (!contents.includes(browserControlCoreSpecifier)) continue;
    const replacement = relativeModuleSpecifier(dirname(file), browserControlCoreVendor);
    const updated = contents.replace(
      /(["'])@open-browser-use\/browser-control-core\1/g,
      (_match, quote) => `${quote}${replacement}${quote}`,
    );
    await writeFile(file, updated, "utf8");
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function relativeModuleSpecifier(fromDir, toFile) {
  let specifier = path.relative(fromDir, toFile).split(path.sep).join("/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };
    if (flag === "--channel") {
      parsed.channel = readValue();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
