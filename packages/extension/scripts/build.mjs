import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const dist = join(root, "dist");
const pub = join(root, "public");

await mkdir(dist, { recursive: true });

await cp(join(pub, "popup.html"), join(dist, "popup.html"));
await cp(join(pub, "popup.css"), join(dist, "popup.css"));

const manifest = JSON.parse(await readFile(join(pub, "manifest.json"), "utf8"));
manifest.version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
