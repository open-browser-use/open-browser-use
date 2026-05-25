import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { payloadRequiredFiles } from "../payload-contract.mjs";

export function run(command, args, env = {}, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

export async function writeExecutable(file, content) {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}

export async function makeArtifact(parent, name, marker, options = {}) {
  const source = path.join(parent, `${name}-src-${marker}`);
  const artifactDir = path.join(parent, "artifacts", marker);
  const artifact = path.join(artifactDir, `${name}.tar.gz`);
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(path.join(source, "node", "bin"), { recursive: true });
  await mkdir(path.join(source, "cli", "dist"), { recursive: true });
  await mkdir(path.join(source, "node_modules", "@open-browser-use", "sdk", "dist"), { recursive: true });
  await mkdir(path.join(source, "extension", "dist"), { recursive: true });
  await writeFile(path.join(source, "marker.txt"), marker, "utf8");
  await writeFile(
    path.join(source, "metadata.json"),
    JSON.stringify(options.metadata ?? { marker, release: { requiredFiles: payloadRequiredFiles } }),
    "utf8",
  );
  if (options.includeNode !== false) {
    await writeExecutable(path.join(source, "node", "bin", "node"), "#!/bin/sh\nexit 0\n");
  }
  if (options.includeHost !== false) {
    await writeExecutable(path.join(source, "bin", "obu-host"), "#!/bin/sh\nexit 0\n");
    if (options.executableHost === false) await chmod(path.join(source, "bin", "obu-host"), 0o644);
  }
  if (options.includeNodeRepl !== false) {
    await writeExecutable(path.join(source, "bin", "obu-node-repl"), "#!/bin/sh\nexit 0\n");
    if (options.executableNodeRepl === false) await chmod(path.join(source, "bin", "obu-node-repl"), 0o644);
  }
  if (options.migrationScript) {
    await mkdir(path.join(source, "install-migrations.d"), { recursive: true });
    await writeExecutable(path.join(source, "install-migrations.d", options.migrationName ?? "001-native-host-layout.sh"), options.migrationScript);
  }
  if (options.includeCli !== false) {
    await writeFile(path.join(source, "cli", "dist", "index.js"), "console.log('obu')\n", "utf8");
  }
  if (options.includeSdkBundle !== false) {
    await writeFile(path.join(source, "node_modules", "@open-browser-use", "sdk", "dist", "index.mjs"), "export {}\n", "utf8");
  }
  if (options.includeExtensionManifest !== false) {
    await writeFile(path.join(source, "extension", "dist", "manifest.json"), "{\"manifest_version\":3}\n", "utf8");
  }
  await mkdir(artifactDir, { recursive: true });
  run("tar", ["-czf", artifact, "-C", source, "."]);
  return artifact;
}

export const installerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "install.sh",
);
