import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const defaultRepoRoot = path.resolve(packageRoot, "..", "..");

export type RuntimeLayoutMode = "repo" | "packaged";

export type RuntimeLayout = {
  mode: RuntimeLayoutMode;
  root: string;
  userConfig?: UserConfig;
  openBrowserUseCommand: string;
  cliEntry: string;
  hostBin: string;
  nodeReplBin: string;
  nodeBin: string;
  nodeModulesRoot: string;
  sdkPackageRoot: string;
  sdkDistRoot: string;
  extensionDir: string;
  extensionZip?: string;
  extensionInstallRoot: string;
  extensionCurrentDir: string;
  nativeHostInstallRoot: string;
  userConfigPath: string;
  metadataPath?: string;
  runtimeDir: string;
  configIssue?: UserConfigIssue;
};

export type UserConfig = {
  schemaVersion: 1;
  runtimeDir: string;
  extensionCurrentDir: string;
  nativeHostInstallRoot: string;
  extensionChannel?: "unpacked-dev" | "store";
  storeExtensionId?: string;
  lastSetup?: { version: string; completedAt: string };
};

export type RuntimeLayoutOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  repoRoot?: string;
  runtimeDir?: string;
  openBrowserUseCommand?: string;
};

export type UserConfigIssue = {
  code: "unreadable" | "malformed-json" | "invalid-shape";
  path: string;
  message: string;
  details?: Record<string, unknown>;
};

export type UserConfigReadResult = {
  config?: UserConfig;
  issue?: UserConfigIssue;
};

export type RuntimeDirValidation = {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
};

export async function resolveRuntimeLayout(options: RuntimeLayoutOptions = {}): Promise<RuntimeLayout> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const payloadRoot = env.OBU_PAYLOAD_ROOT ? path.resolve(env.OBU_PAYLOAD_ROOT) : undefined;
  const root = payloadRoot ?? options.repoRoot ?? defaultRepoRoot;
  const mode: RuntimeLayoutMode = payloadRoot ? "packaged" : "repo";
  const userConfigPath = openBrowserUseUserConfigPath(homeDir);
  const configResult = await readUserConfigResult(userConfigPath);
  const config = configResult.config;
  const userRoot = path.dirname(userConfigPath);
  const extensionInstallRoot = path.join(userRoot, "extension");
  const nativeHostInstallRoot = config?.nativeHostInstallRoot ?? path.join(userRoot, "native-host");
  const extensionCurrentDir = config?.extensionCurrentDir ?? path.join(extensionInstallRoot, "current");
  const nodeModulesRoot = mode === "packaged" ? path.join(root, "node_modules") : await repoNodeModulesRoot(root);
  const extensionZip = mode === "packaged" ? await packagedExtensionZip(root) : undefined;
  const runtimeDir = path.resolve(
    options.runtimeDir
      ?? env.OBU_RUNTIME_DIR
      ?? config?.runtimeDir
      ?? platformDefaultRuntimeDir({ env, platform }),
  );

  const layout: RuntimeLayout = {
    mode,
    root,
    ...(config ? { userConfig: config } : {}),
    openBrowserUseCommand: options.openBrowserUseCommand ?? env.OBU_COMMAND ?? process.argv[1] ?? "obu",
    cliEntry: mode === "packaged" ? path.join(root, "cli", "dist", "index.js") : path.join(root, "packages", "cli", "dist", "index.js"),
    hostBin: env.OBU_HOST_BIN ?? (mode === "packaged" ? path.join(root, "bin", hostBinaryName(platform)) : path.join(root, "target", "debug", hostBinaryName(platform))),
    nodeReplBin: env.OBU_NODE_REPL_BIN ?? (mode === "packaged" ? path.join(root, "bin", nodeReplBinaryName(platform)) : path.join(root, "target", "debug", nodeReplBinaryName(platform))),
    nodeBin: env.OBU_NODE_BINARY ?? (mode === "packaged" ? path.join(root, "node", "bin", nodeBinaryName(platform)) : process.execPath),
    nodeModulesRoot,
    sdkPackageRoot: mode === "packaged" ? path.join(root, "node_modules", "@open-browser-use", "sdk") : path.join(root, "packages", "sdk"),
    sdkDistRoot: mode === "packaged" ? path.join(root, "node_modules", "@open-browser-use", "sdk", "dist") : path.join(root, "packages", "sdk", "dist"),
    extensionDir: mode === "packaged" ? path.join(root, "extension", "dist") : path.join(root, "packages", "extension", "dist"),
    ...(mode === "packaged" && extensionZip ? { extensionZip } : {}),
    ...(mode === "packaged" ? { metadataPath: path.join(root, "metadata.json") } : {}),
    extensionInstallRoot,
    extensionCurrentDir,
    nativeHostInstallRoot,
    userConfigPath,
    runtimeDir,
  };
  if (configResult.issue) layout.configIssue = configResult.issue;
  return layout;
}

async function repoNodeModulesRoot(root: string): Promise<string> {
  const standardRoot = path.join(root, "node_modules");
  const pnpmRoot = path.join(standardRoot, ".pnpm", "node_modules");
  if (await access(path.join(pnpmRoot, "@open-browser-use", "sdk", "package.json")).then(() => true).catch(() => false)) {
    return pnpmRoot;
  }
  return standardRoot;
}

export async function readUserConfig(file: string): Promise<UserConfig | undefined> {
  return (await readUserConfigResult(file)).config;
}

export async function readUserConfigResult(file: string): Promise<UserConfigReadResult> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return {};
    return {
      issue: {
        code: "unreadable",
        path: file,
        message: `could not read open-browser-use user config at ${file}`,
        details: { error: String(error) },
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      issue: {
        code: "malformed-json",
        path: file,
        message: `open-browser-use user config is not valid JSON: ${file}`,
        details: { error: String(error) },
      },
    };
  }
  const shapeIssue = validateUserConfigShape(parsed);
  if (shapeIssue) {
    return {
      issue: {
        code: "invalid-shape",
        path: file,
        message: shapeIssue,
      },
    };
  }
  return { config: parsed as UserConfig };
}

export async function writeUserConfig(file: string, config: UserConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function openBrowserUseUserConfigPath(homeDir: string): string {
  return path.join(homeDir, ".obu", "config.json");
}

export function platformDefaultRuntimeDir(input: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
} = {}): string {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (platform === "linux" && env.XDG_RUNTIME_DIR) {
    return path.join(env.XDG_RUNTIME_DIR, "obu");
  }
  if (platform === "linux" || platform === "darwin") {
    return path.join("/tmp", `obu-${currentUidLabel()}`);
  }
  return path.join(os.tmpdir(), `obu-${currentUidLabel()}`);
}

export async function ensureRuntimeDir(runtimeDir: string): Promise<RuntimeDirValidation> {
  if (process.platform === "win32") {
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    return validateRuntimeDir(runtimeDir);
  }
  const stats = await lstat(runtimeDir).catch((error) => error as NodeJS.ErrnoException);
  if (stats instanceof Error) {
    if (stats.code !== "ENOENT") return validateRuntimeDir(runtimeDir);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(runtimeDir, 0o700);
    return validateRuntimeDir(runtimeDir);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return validateRuntimeDir(runtimeDir);
  }
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    return validateRuntimeDir(runtimeDir);
  }
  if ((stats.mode & 0o077) !== 0) await chmod(runtimeDir, 0o700);
  return validateRuntimeDir(runtimeDir);
}

export async function validateRuntimeDir(runtimeDir: string): Promise<RuntimeDirValidation> {
  if (process.platform === "win32") return { ok: true };
  const stats = await lstat(runtimeDir).catch((error) => `stat runtime directory failed: ${String(error)}`);
  if (typeof stats === "string") {
    return { ok: false, message: stats, details: { path: runtimeDir } };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, message: "runtime directory is a symlink", details: { path: runtimeDir } };
  }
  if (!stats.isDirectory()) {
    return { ok: false, message: `runtime path is not a directory: ${runtimeDir}`, details: { path: runtimeDir } };
  }
  const uid = currentUid();
  if (uid !== undefined && stats.uid !== uid) {
    return {
      ok: false,
      message: "runtime directory is not owned by current user",
      details: { path: runtimeDir, uid: stats.uid, expectedUid: uid },
    };
  }
  if ((stats.mode & 0o077) !== 0) {
    return {
      ok: false,
      message: "runtime directory permissions must be owner-only",
      details: { path: runtimeDir, mode: (stats.mode & 0o777).toString(8) },
    };
  }
  return { ok: true, details: { path: runtimeDir } };
}

export async function executableExists(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(() => true).catch(() => false);
}

export async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function hostBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "obu-host.exe" : "obu-host";
}

function nodeReplBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "obu-node-repl.exe" : "obu-node-repl";
}

function nodeBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "node.exe" : "node";
}

async function packagedExtensionZip(root: string): Promise<string | undefined> {
  const extensionRoot = path.join(root, "extension");
  const entries = await readdir(extensionRoot).catch(() => []);
  const zip = entries.find((entry) => /^open-browser-use-extension-.+\.zip$/.test(entry));
  return zip ? path.join(extensionRoot, zip) : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function currentUidLabel(): string {
  return String(currentUid() ?? "unknown");
}

function validateUserConfigShape(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "open-browser-use user config must be a JSON object";
  }
  const config = value as Partial<UserConfig>;
  if (config.schemaVersion !== 1) return "open-browser-use user config schemaVersion must be 1";
  if (typeof config.runtimeDir !== "string" || config.runtimeDir.length === 0) {
    return "open-browser-use user config runtimeDir must be a non-empty string";
  }
  if (typeof config.extensionCurrentDir !== "string" || config.extensionCurrentDir.length === 0) {
    return "open-browser-use user config extensionCurrentDir must be a non-empty string";
  }
  if (typeof config.nativeHostInstallRoot !== "string" || config.nativeHostInstallRoot.length === 0) {
    return "open-browser-use user config nativeHostInstallRoot must be a non-empty string";
  }
  if (
    config.extensionChannel !== undefined &&
    config.extensionChannel !== "unpacked-dev" &&
    config.extensionChannel !== "store"
  ) {
    return "open-browser-use user config extensionChannel must be unpacked-dev or store";
  }
  if (config.storeExtensionId !== undefined && !/^[a-p]{32}$/.test(config.storeExtensionId)) {
    return "open-browser-use user config storeExtensionId must be a Chrome extension id";
  }
  return undefined;
}
