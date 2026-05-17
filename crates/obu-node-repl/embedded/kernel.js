// Node-based kernel for obu-node-repl.
// Communicates over JSON lines on stdin/stdout.
// Requires Node started with --experimental-vm-modules.

const { Buffer } = require("node:buffer");
const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { builtinModules, createRequire } = require("node:module");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { URL, URLSearchParams, fileURLToPath, pathToFileURL } = require(
  "node:url",
);
const { inspect, TextDecoder, TextEncoder } = require("node:util");
const vm = require("node:vm");

const { SourceTextModule, SyntheticModule } = vm;
const meriyahPromise = import("./meriyah.umd.min.js").then(
  (m) => m.default ?? m,
);

// vm contexts start with very few globals. Populate common Node/web globals
// so snippets and dependencies behave like a normal modern JS runtime.
const context = vm.createContext({});
context.globalThis = context;
context.global = context;
context.Buffer = Buffer;
context.console = console;
context.URL = URL;
context.URLSearchParams = URLSearchParams;
if (typeof TextEncoder !== "undefined") {
  context.TextEncoder = TextEncoder;
}
if (typeof TextDecoder !== "undefined") {
  context.TextDecoder = TextDecoder;
}
if (typeof AbortController !== "undefined") {
  context.AbortController = AbortController;
}
if (typeof AbortSignal !== "undefined") {
  context.AbortSignal = AbortSignal;
}
if (typeof structuredClone !== "undefined") {
  context.structuredClone = structuredClone;
}
if (typeof fetch !== "undefined") {
  context.fetch = fetch;
}
if (typeof Headers !== "undefined") {
  context.Headers = Headers;
}
if (typeof Request !== "undefined") {
  context.Request = Request;
}
if (typeof Response !== "undefined") {
  context.Response = Response;
}
if (typeof performance !== "undefined") {
  context.performance = performance;
}
context.crypto = crypto.webcrypto ?? crypto;
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
context.setInterval = setInterval;
context.clearInterval = clearInterval;
context.queueMicrotask = queueMicrotask;
if (typeof setImmediate !== "undefined") {
  context.setImmediate = setImmediate;
  context.clearImmediate = clearImmediate;
}
context.atob = (data) => Buffer.from(data, "base64").toString("binary");
context.btoa = (data) => Buffer.from(data, "binary").toString("base64");

function defineLockedGlobal(name, value) {
  Object.defineProperty(context, name, {
    value,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function normalizeBackends(value) {
  return Array.isArray(value)
    ? value
        .filter(
          (backend) =>
            backend &&
            typeof backend === "object" &&
            typeof backend.type === "string" &&
            typeof backend.name === "string" &&
            typeof backend.socketPath === "string",
        )
        .map((backend) => deepFreeze({
          type: backend.type,
          name: backend.name,
          socketPath: backend.socketPath,
          ...(backend.metadata && typeof backend.metadata === "object"
            ? { metadata: deepFreeze({ ...backend.metadata }) }
            : {}),
        }))
    : [];
}

function normalizeBackendDiagnostics(value) {
  return Array.isArray(value)
    ? value
        .filter(
          (diagnostic) =>
            diagnostic &&
            typeof diagnostic === "object" &&
            typeof diagnostic.source === "string" &&
            typeof diagnostic.reason === "string",
        )
        .map((diagnostic) => deepFreeze({
          source: diagnostic.source,
          reason: diagnostic.reason,
        }))
    : [];
}

function parseKernelBootstrapArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      "session-id": {
        type: "string",
      },
      "working-dir": {
        type: "string",
      },
      "backends-json": {
        type: "string",
        default: "[]",
      },
      "backend-diagnostics-json": {
        type: "string",
        default: "[]",
      },
    },
  });

  const sessionId = values["session-id"] ?? null;
  const workingDir = values["working-dir"] ?? null;
  const backendsJson = values["backends-json"] ?? "[]";
  const backendDiagnosticsJson = values["backend-diagnostics-json"] ?? "[]";

  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("missing --session-id");
  }
  if (typeof workingDir !== "string" || workingDir.trim().length === 0) {
    throw new Error("missing --working-dir");
  }
  let backends;
  try {
    backends = normalizeBackends(JSON.parse(backendsJson));
  } catch {
    backends = [];
  }
  let backendDiagnostics;
  try {
    backendDiagnostics = normalizeBackendDiagnostics(JSON.parse(backendDiagnosticsJson));
  } catch {
    backendDiagnostics = [];
  }

  return {
    sessionId,
    workingDir,
    backends: deepFreeze(backends),
    backendDiagnostics: deepFreeze(backendDiagnostics),
  };
}

const kernelBootstrap = (() => {
  try {
    return parseKernelBootstrapArgs(process.argv.slice(2));
  } catch (err) {
    console.error(
      `obu-node-repl invalid kernel bootstrap args: ${err?.message ?? err}`,
    );
    process.exit(1);
  }
})();

let currentBackends = kernelBootstrap.backends;
let currentBackendDiagnostics = kernelBootstrap.backendDiagnostics;

/**
 * @typedef {{ name: string, kind: "const"|"let"|"var"|"function"|"class" }} Binding
 */

// REPL state model:
// - Every exec is compiled as a fresh ESM "cell".
// - `previousModule` is the most recently committed module namespace.
// - `previousBindings` tracks which top-level names should be carried forward.
// Each new cell imports a synthetic view of the previous namespace and
// redeclares those names so user variables behave like a persistent REPL.
let previousModule = null;
/** @type {Binding[]} */
let previousBindings = [];
let cellCounter = 0;
let internalBindingCounter = 0;
const internalBindingSalt = (() => {
  const raw = kernelBootstrap.sessionId;
  const sanitized = raw.replace(/[^A-Za-z0-9_$]/g, "_");
  return sanitized || "session";
})();
let activeExecId = null;
let fatalExitScheduled = false;

try {
  process.chdir(kernelBootstrap.workingDir);
} catch (err) {
  console.error(
    `obu-node-repl failed to switch to working directory "${kernelBootstrap.workingDir}": ${err?.message ?? err}`,
  );
  process.exit(1);
}

const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
// The kernel transport itself writes JSONL over stdout/stderr below, so exposing
// raw `process` would make it easy for user code to corrupt the stdio protocol.
// Keep this denylist narrow for now; if obu-node-repl moves off stdio transport in
// the future, we can revisit whether `process` still needs to stay blocked.
const deniedBuiltinModules = new Set(["process", "node:process"]);

function toNodeBuiltinSpecifier(specifier) {
  return specifier.startsWith("node:") ? specifier : `node:${specifier}`;
}

function isDeniedBuiltin(specifier) {
  const normalized = specifier.startsWith("node:")
    ? specifier.slice(5)
    : specifier;
  return (
    deniedBuiltinModules.has(specifier) || deniedBuiltinModules.has(normalized)
  );
}

/** @type {Map<string, (msg: any) => void>} */
const pendingEmitImage = new Map();
/** @type {Map<string, (msg: any) => void>} */
const pendingElicitations = new Map();
/** @type {Map<string, (msg: any) => void>} */
const pendingAuthenticatedFetch = new Map();
/** @type {Map<string, (msg: any) => void>} */
const pendingNativePipeRequests = new Map();
/** @type {Map<string, { listeners: { data: Set<(data: Buffer) => void>, close: Set<() => void>, error: Set<(error: Error) => void> } }>} */
const nativePipeConnections = new Map();
let emitImageCounter = 0;
let elicitationCounter = 0;
let authenticatedFetchCounter = 0;
let nativePipeRequestCounter = 0;
const nativePipeAuthToken = crypto.randomUUID();
const execContextStorage = new AsyncLocalStorage();
const cwd = process.cwd();
// Use Node's standard temp-dir resolution. Sandboxed launches redirect it by
// setting TMPDIR/TMP/TEMP to the writable workspace root before Node starts.
const tmpDir = os.tmpdir();
const homeDir = process.env.HOME ?? null;
const computerUseServiceAppPath = process.env.SKY_CUA_SERVICE_PATH ?? null;
const moduleSearchBases = [];
const moduleSearchBaseSet = new Set();

function normalizeModuleSearchBase(entry) {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(process.cwd(), trimmed);
  return path.basename(resolved) === "node_modules"
    ? path.dirname(resolved)
    : resolved;
}

function addModuleSearchBase(entry) {
  const base = normalizeModuleSearchBase(entry);
  if (!base || moduleSearchBaseSet.has(base)) {
    return;
  }
  moduleSearchBaseSet.add(base);
  const cwdIndex = moduleSearchBases.indexOf(cwd);
  if (cwdIndex === -1) {
    moduleSearchBases.push(base);
  } else {
    moduleSearchBases.splice(cwdIndex, 0, base);
  }
}

for (const entry of (process.env.OBU_NODE_REPL_MODULE_DIRS ?? "").split(
  path.delimiter,
)) {
  addModuleSearchBase(entry);
}
if (!moduleSearchBaseSet.has(cwd)) {
  moduleSearchBaseSet.add(cwd);
  moduleSearchBases.push(cwd);
}

const importResolveConditions = new Set(["node", "import"]);
const requireByBase = new Map();
const linkedFileModules = new Map();
const linkedNativeModules = new Map();
const linkedModuleEvaluations = new Map();
let ocuSdkBootstrapPromise = null;
const trustedModuleSha256s = parseTrustedModuleSha256s(
  process.env.OBU_TRUSTED_MODULE_SHA256S,
);
const trustedBrowserClientMarketplaceName = (
  process.env.OBU_NODE_REPL_SDK_MARKETPLACE_NAME || ""
).trim();
const additionalTrustedCodeDirs = (process.env.OBU_TRUSTED_CODE_PATHS || "")
  .split(path.delimiter)
  .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
const trustAllImportedCode = process.env.OBU_TRUST_ALL_CODE === "1";

function clearLocalFileModuleCaches() {
  linkedFileModules.clear();
  linkedModuleEvaluations.clear();
}

function canonicalizePath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

function isSameOrWithinDirectory(candidate, directory) {
  if (!candidate || !directory) {
    return false;
  }
  const relativePath = path.relative(
    canonicalizePath(directory),
    canonicalizePath(candidate),
  );
  return (
    relativePath === "" ||
    (relativePath.length > 0 &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

function shouldInjectTrustedModuleCapabilities(
  identifier,
  isMain,
  isHashTrustedSource = false,
) {
  if (isMain) {
    return false;
  }
  if (trustAllImportedCode) {
    return true;
  }
  return (
    isHashTrustedSource ||
    additionalTrustedCodeDirs.some((dir) =>
      isSameOrWithinDirectory(identifier, dir),
    )
  );
}

function parseTrustedModuleSha256s(value) {
  if (!value) {
    return new Set();
  }
  return new Set(
    Array.from(value.matchAll(/\b[a-fA-F0-9]{64}\b/g), (match) =>
      match[0].toLowerCase(),
    ),
  );
}

function isHashTrustedModuleSource(sourceBytes) {
  if (trustedModuleSha256s.size === 0) {
    return false;
  }
  const digest = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  return trustedModuleSha256s.has(digest);
}

function getNativePipeUnavailableMessage() {
  if (!trustedBrowserClientMarketplaceName) {
    return null;
  }
  return `privileged native pipe bridge is not available; browser-client is not trusted. Load browser-client from the ${trustedBrowserClientMarketplaceName} marketplace directory.`;
}

function resolveResultToUrl(resolved) {
  if (resolved.kind === "builtin") {
    return resolved.specifier;
  }
  if (resolved.kind === "file") {
    return pathToFileURL(resolved.path).href;
  }
  if (resolved.kind === "package") {
    return resolved.specifier;
  }
  throw new Error(`Unsupported module resolution kind: ${resolved.kind}`);
}

function setImportMeta(meta, mod, isMain = false, isHashTrustedSource = false) {
  meta.url = pathToFileURL(mod.identifier).href;
  meta.filename = mod.identifier;
  meta.dirname = path.dirname(mod.identifier);
  meta.main = isMain;
  meta.resolve = (specifier) =>
    resolveResultToUrl(resolveSpecifier(specifier, mod.identifier));
  const shouldInjectTrustedCapabilities = shouldInjectTrustedModuleCapabilities(
    mod.identifier,
    isMain,
    isHashTrustedSource,
  );
  if (shouldInjectTrustedCapabilities) {
    Object.defineProperty(meta, "__obuNativePipe", {
      configurable: false,
      enumerable: false,
      value: privilegedNativePipeBridge,
      writable: false,
    });
    Object.defineProperty(meta, "privilegedNodeRepl", {
      configurable: false,
      enumerable: false,
      value: privilegedNodeRepl,
      writable: false,
    });
  }
  const nativePipeUnavailableMessage = isMain
    ? null
    : getNativePipeUnavailableMessage();
  if (!shouldInjectTrustedCapabilities && nativePipeUnavailableMessage) {
    Object.defineProperty(meta, "__obuNativePipeUnavailableMessage", {
      configurable: false,
      enumerable: false,
      value: nativePipeUnavailableMessage,
      writable: false,
    });
  }
}

function getRequireForBase(base) {
  let req = requireByBase.get(base);
  if (!req) {
    req = createRequire(path.join(base, "__obu_node_repl__.cjs"));
    requireByBase.set(base, req);
  }
  return req;
}

function isModuleNotFoundError(err) {
  return (
    err?.code === "MODULE_NOT_FOUND" || err?.code === "ERR_MODULE_NOT_FOUND"
  );
}

function isObuSdkNotFoundError(err) {
  return (
    isModuleNotFoundError(err) ||
    (err && typeof err.message === "string" && err.message.includes("Module not found: @open-browser-use/sdk"))
  );
}

function isWithinBaseNodeModules(base, resolvedPath) {
  const canonicalBase = canonicalizePath(base);
  const canonicalResolved = canonicalizePath(resolvedPath);
  const nodeModulesRoot = path.resolve(canonicalBase, "node_modules");
  const relative = path.relative(nodeModulesRoot, canonicalResolved);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function isExplicitRelativePathSpecifier(specifier) {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith(".\\") ||
    specifier.startsWith("..\\")
  );
}

function isFileUrlSpecifier(specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith("file:")) {
    return false;
  }
  try {
    return new URL(specifier).protocol === "file:";
  } catch {
    return false;
  }
}

function isPathSpecifier(specifier) {
  if (
    typeof specifier !== "string" ||
    !specifier ||
    specifier.trim() !== specifier
  ) {
    return false;
  }
  return (
    isExplicitRelativePathSpecifier(specifier) ||
    path.isAbsolute(specifier) ||
    isFileUrlSpecifier(specifier)
  );
}

function isBarePackageSpecifier(specifier) {
  if (
    typeof specifier !== "string" ||
    !specifier ||
    specifier.trim() !== specifier
  ) {
    return false;
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return false;
  }
  if (specifier.startsWith("/") || specifier.startsWith("\\")) {
    return false;
  }
  if (path.isAbsolute(specifier)) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
    return false;
  }
  if (specifier.includes("\\")) {
    return false;
  }
  return true;
}

function resolveBareSpecifier(specifier) {
  let firstResolutionError = null;

  for (const base of moduleSearchBases) {
    try {
      const resolved = getRequireForBase(base).resolve(specifier, {
        conditions: importResolveConditions,
      });
      if (isWithinBaseNodeModules(base, resolved)) {
        return resolved;
      }
      // Ignore resolutions that escape this base via parent node_modules lookup.
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      if (!firstResolutionError) {
        firstResolutionError = err;
      }
    }
  }

  if (firstResolutionError) {
    throw firstResolutionError;
  }
  return null;
}

function resolvePathSpecifier(specifier, referrerIdentifier = null) {
  let candidate;
  if (isFileUrlSpecifier(specifier)) {
    try {
      candidate = fileURLToPath(new URL(specifier));
    } catch (err) {
      throw new Error(`Failed to resolve module "${specifier}": ${err.message}`);
    }
  } else {
    const baseDir =
      referrerIdentifier && path.isAbsolute(referrerIdentifier)
        ? path.dirname(referrerIdentifier)
        : process.cwd();
    candidate = path.isAbsolute(specifier)
      ? specifier
      : path.resolve(baseDir, specifier);
  }

  let resolvedPath;
  try {
    resolvedPath = fs.realpathSync.native(candidate);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`Module not found: ${specifier}`);
    }
    throw new Error(`Failed to resolve module "${specifier}": ${err.message}`);
  }

  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`Module not found: ${specifier}`);
    }
    throw new Error(`Failed to inspect module "${specifier}": ${err.message}`);
  }

  if (!stats.isFile()) {
    throw new Error(
      `Unsupported import specifier "${specifier}" in obu-node-repl. Directory imports are not supported.`,
    );
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension !== ".js" && extension !== ".mjs") {
    throw new Error(
      `Unsupported import specifier "${specifier}" in obu-node-repl. Only .js and .mjs files are supported.`,
    );
  }

  return { kind: "file", path: resolvedPath };
}

function resolveSpecifier(specifier, referrerIdentifier = null) {
  if (specifier.startsWith("node:") || builtinModuleSet.has(specifier)) {
    if (isDeniedBuiltin(specifier)) {
      throw new Error(
        `Importing module "${specifier}" is not allowed in obu-node-repl`,
      );
    }
    return { kind: "builtin", specifier: toNodeBuiltinSpecifier(specifier) };
  }

  if (isPathSpecifier(specifier)) {
    return resolvePathSpecifier(specifier, referrerIdentifier);
  }

  if (!isBarePackageSpecifier(specifier)) {
    throw new Error(
      `Unsupported import specifier "${specifier}" in obu-node-repl. Use a package name like "lodash" or "@scope/pkg", or a relative/absolute/file:// .js/.mjs path.`,
    );
  }

  const resolvedBare = resolveBareSpecifier(specifier);
  if (!resolvedBare) {
    throw new Error(`Module not found: ${specifier}`);
  }

  return { kind: "package", path: resolvedBare, specifier };
}

function getObuSdkEntrypointUrl() {
  const resolved = resolveSpecifier("@open-browser-use/sdk", path.join(cwd, "__obu_sdk_bootstrap__.mjs"));
  if (resolved.kind !== "package" && resolved.kind !== "file") {
    throw new Error("Resolved @open-browser-use/sdk to an unsupported module kind");
  }
  return pathToFileURL(resolved.path).href;
}

function importNativeResolved(resolved) {
  if (resolved.kind === "builtin") {
    return import(resolved.specifier);
  }
  if (resolved.kind === "package") {
    return import(pathToFileURL(resolved.path).href);
  }
  throw new Error(`Unsupported module resolution kind: ${resolved.kind}`);
}

async function loadLinkedNativeModule(resolved) {
  const key =
    resolved.kind === "builtin"
      ? `builtin:${resolved.specifier}`
      : `package:${resolved.path}`;
  let modulePromise = linkedNativeModules.get(key);
  if (!modulePromise) {
    modulePromise = (async () => {
      const namespace = await importNativeResolved(resolved);
      const exportNames = Object.getOwnPropertyNames(namespace);
      return new SyntheticModule(
        exportNames,
        function initSyntheticModule() {
          for (const name of exportNames) {
            this.setExport(name, namespace[name]);
          }
        },
        { context },
      );
    })();
    linkedNativeModules.set(key, modulePromise);
  }
  return modulePromise;
}

async function loadLinkedFileModule(modulePath) {
  let module = linkedFileModules.get(modulePath);
  if (!module) {
    const sourceBytes = fs.readFileSync(modulePath);
    const isHashTrustedSource = isHashTrustedModuleSource(sourceBytes);
    const source = sourceBytes.toString("utf8");
    module = new SourceTextModule(source, {
      context,
      identifier: modulePath,
      initializeImportMeta(meta, mod) {
        setImportMeta(meta, mod, false, isHashTrustedSource);
      },
      importModuleDynamically(specifier, referrer) {
        return importResolved(resolveSpecifier(specifier, referrer?.identifier));
      },
    });
    linkedFileModules.set(modulePath, module);
  }
  if (module.status === "unlinked") {
    await module.link(async (specifier, referencingModule) => {
      const resolved = resolveSpecifier(specifier, referencingModule?.identifier);
      return loadLinkedModule(resolved);
    });
  }
  return module;
}

async function loadLinkedModule(resolved) {
  if (resolved.kind === "file") {
    return loadLinkedFileModule(resolved.path);
  }
  if (resolved.kind === "builtin" || resolved.kind === "package") {
    return loadLinkedNativeModule(resolved);
  }
  throw new Error(`Unsupported module resolution kind: ${resolved.kind}`);
}

async function importResolved(resolved) {
  if (resolved.kind === "file") {
    const module = await loadLinkedFileModule(resolved.path);
    let evaluation = linkedModuleEvaluations.get(resolved.path);
    if (!evaluation) {
      evaluation = module.evaluate();
      linkedModuleEvaluations.set(resolved.path, evaluation);
    }
    await evaluation;
    return module.namespace;
  }
  return importNativeResolved(resolved);
}

function collectPatternNames(pattern, kind, map) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      if (!map.has(pattern.name)) map.set(pattern.name, kind);
      return;
    case "ObjectPattern":
      for (const prop of pattern.properties ?? []) {
        if (prop.type === "Property") {
          collectPatternNames(prop.value, kind, map);
        } else if (prop.type === "RestElement") {
          collectPatternNames(prop.argument, kind, map);
        }
      }
      return;
    case "ArrayPattern":
      for (const elem of pattern.elements ?? []) {
        if (!elem) continue;
        if (elem.type === "RestElement") {
          collectPatternNames(elem.argument, kind, map);
        } else {
          collectPatternNames(elem, kind, map);
        }
      }
      return;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, kind, map);
      return;
    case "RestElement":
      collectPatternNames(pattern.argument, kind, map);
      return;
    default:
      return;
  }
}

function collectBindings(ast) {
  const map = new Map();
  for (const stmt of ast.body ?? []) {
    if (stmt.type === "VariableDeclaration") {
      const kind = stmt.kind;
      for (const decl of stmt.declarations) {
        collectPatternNames(decl.id, kind, map);
      }
    } else if (stmt.type === "FunctionDeclaration" && stmt.id) {
      map.set(stmt.id.name, "function");
    } else if (stmt.type === "ClassDeclaration" && stmt.id) {
      map.set(stmt.id.name, "class");
    } else if (stmt.type === "ForStatement") {
      if (
        stmt.init &&
        stmt.init.type === "VariableDeclaration" &&
        stmt.init.kind === "var"
      ) {
        for (const decl of stmt.init.declarations) {
          collectPatternNames(decl.id, "var", map);
        }
      }
    } else if (
      stmt.type === "ForInStatement" ||
      stmt.type === "ForOfStatement"
    ) {
      if (
        stmt.left &&
        stmt.left.type === "VariableDeclaration" &&
        stmt.left.kind === "var"
      ) {
        for (const decl of stmt.left.declarations) {
          collectPatternNames(decl.id, "var", map);
        }
      }
    }
  }
  return Array.from(map.entries()).map(([name, kind]) => ({ name, kind }));
}

function collectPatternBindingNames(pattern) {
  const map = new Map();
  collectPatternNames(pattern, "binding", map);
  return Array.from(map.keys());
}

function nextInternalBindingName() {
  // We intentionally do not scan user-declared names here. Internal helpers use
  // a per-thread salt plus a counter instead. A user could still collide by
  // deliberately spelling the exact generated name, but the thread-id salt
  // keeps accidental collisions negligible while avoiding more AST bookkeeping.
  return `__obu_internal_commit_${internalBindingSalt}_${internalBindingCounter++}`;
}

function buildMarkCommittedExpression(names, markCommittedFnName) {
  const serializedNames = names.map((name) => JSON.stringify(name)).join(", ");
  return `(${markCommittedFnName}(${serializedNames}), undefined)`;
}

function tryReadBindingValue(module, bindingName) {
  if (!module) {
    return { ok: false, value: undefined };
  }

  try {
    return { ok: true, value: module.namespace[bindingName] };
  } catch {
    return { ok: false, value: undefined };
  }
}

function instrumentVariableDeclarationSource(
  code,
  declaration,
  markCommittedFnName,
) {
  if (!declaration.declarations?.length) {
    return code.slice(declaration.start, declaration.end);
  }

  const prefix = code.slice(declaration.start, declaration.declarations[0].start);
  const suffix = code.slice(
    declaration.declarations[declaration.declarations.length - 1].end,
    declaration.end,
  );
  const parts = [];

  for (const decl of declaration.declarations) {
    parts.push(code.slice(decl.start, decl.end));

    const names = collectPatternBindingNames(decl.id);
    if (names.length > 0) {
      const helperName = nextInternalBindingName();
      parts.push(
        `${helperName} = ${buildMarkCommittedExpression(names, markCommittedFnName)}`,
      );
    }
  }

  return `${prefix}${parts.join(", ")}${suffix}`;
}

function instrumentLoopBody(code, body, names, guardName, markCommittedFnName) {
  const marker = `if (${guardName}) { ${guardName} = false; ${markCommittedFnName}(${names
    .map((name) => JSON.stringify(name))
    .join(", ")}); }`;
  const bodyCode = code.slice(body.start, body.end);

  if (body.type === "BlockStatement") {
    return `{ ${marker}${bodyCode.slice(1)}`;
  }

  return `{ ${marker} ${bodyCode} }`;
}

function applyReplacements(code, replacements) {
  let instrumentedCode = code;

  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    instrumentedCode =
      instrumentedCode.slice(0, replacement.start) +
      replacement.text +
      instrumentedCode.slice(replacement.end);
  }

  return instrumentedCode;
}

function instrumentLastExpressionResult(code, ast) {
  const body = ast.body ?? [];
  const last = body.length > 0 ? body[body.length - 1] : null;
  if (!last || last.type !== "ExpressionStatement") {
    return code;
  }

  const expressionSource = code.slice(last.expression.start, last.expression.end);
  return applyReplacements(code, [
    {
      start: last.start,
      end: last.end,
      text: `globalThis.__obuLastResult = (${expressionSource});`,
    },
  ]);
}

function collectHoistedVarDeclarationStarts(ast) {
  const varDeclarationStarts = new Map();

  const recordDeclarationStart = (map, name, start) => {
    const existingStart = map.get(name);
    if (existingStart === undefined || start < existingStart) {
      map.set(name, start);
    }
  };

  const recordVarDeclarationStarts = (declaration) => {
    for (const name of collectPatternBindingNames(declaration.id)) {
      recordDeclarationStart(varDeclarationStarts, name, declaration.start);
    }
  };

  for (const stmt of ast.body ?? []) {
    if (stmt.type === "VariableDeclaration" && stmt.kind === "var") {
      for (const declaration of stmt.declarations ?? []) {
        recordVarDeclarationStarts(declaration);
      }
      continue;
    }

    if (
      stmt.type === "ForStatement" &&
      stmt.init?.type === "VariableDeclaration" &&
      stmt.init.kind === "var"
    ) {
      for (const declaration of stmt.init.declarations ?? []) {
        recordVarDeclarationStarts(declaration);
      }
      continue;
    }

    if (
      (stmt.type === "ForInStatement" || stmt.type === "ForOfStatement") &&
      stmt.left?.type === "VariableDeclaration" &&
      stmt.left.kind === "var"
    ) {
      for (const declaration of stmt.left.declarations ?? []) {
        recordVarDeclarationStarts(declaration);
      }
    }
  }

  return varDeclarationStarts;
}

function collectFutureVarWriteReplacements(
  code,
  ast,
  {
    helperDeclarations = null,
    markCommittedFnName = null,
  } = {},
) {
  // Failed-cell hoisted tracking intentionally stays small here. We only mark
  // direct top-level writes to future `var` bindings, plus top-level
  // declaration-site markers handled later in `instrumentCurrentBindings`.
  // We do not recurse through nested statement structure because that quickly
  // requires real lexical-scope tracking for blocks, loop scopes, catch
  // bindings, and similar shadowing cases. Supported write recovery is limited
  // to direct top-level expression statements such as `x = 1`, `x += 1`,
  // `x++`, and logical assignments.
  const varDeclarationStarts = collectHoistedVarDeclarationStarts(ast);
  if (varDeclarationStarts.size === 0) {
    return [];
  }
  const replacements = [];
  const replacementKeys = new Set();

  if (!markCommittedFnName) {
    throw new Error(
      "collectFutureVarWriteReplacements expected a commit marker binding name",
    );
  }

  const addReplacement = (start, end, text) => {
    const key = `${start}:${end}`;
    if (!replacementKeys.has(key)) {
      replacementKeys.add(key);
      replacements.push({ start, end, text });
    }
  };

  const getFutureVarName = (identifier) => {
    if (!identifier || identifier.type !== "Identifier") {
      return null;
    }

    const declarationStart = varDeclarationStarts.get(identifier.name);
    if (
      declarationStart === undefined ||
      identifier.start >= declarationStart
    ) {
      return null;
    }

    return identifier.name;
  };

  const instrumentUpdateExpression = (node, identifier) => {
    const bindingName = getFutureVarName(identifier);
    if (!bindingName) {
      return false;
    }

    addReplacement(
      node.start,
      node.end,
      `(${markCommittedFnName}(${JSON.stringify(bindingName)}), ${code.slice(
        node.start,
        node.end,
      )})`,
    );
    return true;
  };

  const instrumentAssignmentExpression = (node) => {
    if (node.left.type !== "Identifier") {
      return false;
    }

    const bindingName = getFutureVarName(node.left);
    if (!bindingName) {
      return false;
    }

    if (
      node.operator === "&&=" ||
      node.operator === "||=" ||
      node.operator === "??="
    ) {
      if (!helperDeclarations) {
        throw new Error(
          "collectFutureVarWriteReplacements expected helperDeclarations for logical assignment rewriting",
        );
      }

      const helperName = nextInternalBindingName();
      helperDeclarations.push(`let ${helperName};`);
      const shortCircuitOperator =
        node.operator === "&&="
          ? "&&"
          : node.operator === "||="
            ? "||"
            : "??";
      addReplacement(
        node.start,
        node.end,
        `((${helperName} = ${node.left.name}), ${helperName} ${shortCircuitOperator} ((${node.left.name} = ${code.slice(node.right.start, node.right.end)}), ${buildMarkCommittedExpression([bindingName], markCommittedFnName)}, ${node.left.name}))`,
      );
      return true;
    }

    addReplacement(
      node.start,
      node.end,
      `((${code.slice(node.start, node.end)}), ${buildMarkCommittedExpression([bindingName], markCommittedFnName)}, ${node.left.name})`,
    );
    return true;
  };

  const unwrapParenthesizedExpression = (node) => {
    let current = node;
    while (current?.type === "ParenthesizedExpression") {
      current = current.expression;
    }
    return current;
  };

  for (const statement of ast.body ?? []) {
    if (statement.type !== "ExpressionStatement") {
      continue;
    }

    const expression = unwrapParenthesizedExpression(statement.expression);
    if (!expression) {
      continue;
    }

    if (
      expression.type === "UpdateExpression" &&
      expression.argument.type === "Identifier"
    ) {
      instrumentUpdateExpression(expression, expression.argument);
      continue;
    }

    if (expression.type === "AssignmentExpression") {
      instrumentAssignmentExpression(expression);
    }
  }

  return replacements;
}

function instrumentCurrentBindings(
  code,
  ast,
  currentBindings,
  priorBindings,
  markCommittedFnName,
) {
  if (currentBindings.length === 0) {
    return code;
  }

  const replacements = [];

  for (const stmt of ast.body ?? []) {
    if (stmt.type === "VariableDeclaration") {
      replacements.push({
        start: stmt.start,
        end: stmt.end,
        text: instrumentVariableDeclarationSource(
          code,
          stmt,
          markCommittedFnName,
        ),
      });
      continue;
    }

    if (stmt.type === "FunctionDeclaration" && stmt.id) {
      replacements.push({
        start: stmt.start,
        end: stmt.end,
        // Keep function source text stable for things like `foo.toString()`.
        // Pre-declaration uses are tracked separately by instrumenting the
        // top-level expressions that actually read the hoisted function value.
        text: `${code.slice(stmt.start, stmt.end)}\n;${markCommittedFnName}(${JSON.stringify(stmt.id.name)});`,
      });
      continue;
    }

    if (stmt.type === "ClassDeclaration" && stmt.id) {
      replacements.push({
        start: stmt.start,
        end: stmt.end,
        text: `${code.slice(stmt.start, stmt.end)}\n;${markCommittedFnName}(${JSON.stringify(stmt.id.name)});`,
      });
      continue;
    }

    if (
      stmt.type === "ForStatement" &&
      stmt.init &&
      stmt.init.type === "VariableDeclaration" &&
      stmt.init.kind === "var"
    ) {
      replacements.push({
        start: stmt.start,
        end: stmt.end,
        text: `${code.slice(stmt.start, stmt.init.start)}${instrumentVariableDeclarationSource(
          code,
          stmt.init,
          markCommittedFnName,
        )}${code.slice(stmt.init.end, stmt.end)}`,
      });
      continue;
    }

    if (
      (stmt.type === "ForInStatement" || stmt.type === "ForOfStatement") &&
      stmt.left &&
      stmt.left.type === "VariableDeclaration" &&
      stmt.left.kind === "var"
    ) {
      const names = stmt.left.declarations.flatMap((decl) =>
        collectPatternBindingNames(decl.id),
      );
      if (names.length > 0) {
        const guardName = nextInternalBindingName();
        replacements.push({
          start: stmt.start,
          end: stmt.end,
          // Mark top-level `for...in` / `for...of` vars on the first body
          // execution instead of every iteration. This keeps hot loops cheap
          // after the first pass while still preserving vars for the common
          // case where the loop actually ran before a later throw.
          //
          // The tradeoff is that `for (var x of []) {}` in a failed cell will
          // not carry `x` forward as `undefined`, because the body never runs
          // and the one-time marker never fires. We accept that edge case:
          // `var` is redeclarable, and the only lost state is an unassigned
          // `undefined` from an empty top-level loop in a cell that later
          // fails.
          text: `let ${guardName} = true;\n${code.slice(
            stmt.start,
            stmt.body.start,
          )}${instrumentLoopBody(
            code,
            stmt.body,
            names,
            guardName,
            markCommittedFnName,
          )}`,
        });
      }
    }
  }

  return applyReplacements(code, replacements);
}

async function buildModuleSource(code) {
  const meriyah = await meriyahPromise;
  const ast = meriyah.parseModule(code, {
    next: true,
    module: true,
    ranges: true,
    loc: false,
    disableWebCompat: true,
  });
  const currentBindings = collectBindings(ast);
  const priorBindings = previousModule ? previousBindings : [];
  const helperDeclarations = [];
  const markCommittedFnName = nextInternalBindingName();
  const markPreludeCompletedFnName = nextInternalBindingName();
  helperDeclarations.push(
    // `import.meta` is syntax-level and cannot be shadowed by user bindings
    // like `const globalThis = ...`, so alias the marker helper through it
    // once in the prelude and use that stable local binding everywhere.
    // Then delete the raw import.meta hooks so user code cannot spoof
    // committed bindings by calling them directly.
    `const ${markCommittedFnName} = import.meta.__obuInternalMarkCommittedBindings;`,
    `const ${markPreludeCompletedFnName} = import.meta.__obuInternalMarkPreludeCompleted;`,
    "delete import.meta.__obuInternalMarkCommittedBindings;",
    "delete import.meta.__obuInternalMarkPreludeCompleted;",
  );
  const writeInstrumentedCode = applyReplacements(
    code,
    collectFutureVarWriteReplacements(code, ast, {
      helperDeclarations,
      markCommittedFnName,
    }),
  );
  const instrumentedAst = meriyah.parseModule(writeInstrumentedCode, {
    next: true,
    module: true,
    ranges: true,
    loc: false,
    disableWebCompat: true,
  });
  const resultCode = instrumentLastExpressionResult(
    writeInstrumentedCode,
    instrumentedAst,
  );
  const resultAst =
    resultCode === writeInstrumentedCode
      ? instrumentedAst
      : meriyah.parseModule(resultCode, {
          next: true,
          module: true,
          ranges: true,
          loc: false,
          disableWebCompat: true,
        });
  const instrumentedCode = instrumentCurrentBindings(
    resultCode,
    resultAst,
    currentBindings,
    priorBindings,
    markCommittedFnName,
  );

  let prelude = "";
  if (previousModule && priorBindings.length) {
    // Recreate carried bindings before running user code in this new cell.
    prelude += 'import * as __prev from "@prev";\n';
    prelude += priorBindings
      .map((b) => {
        const keyword =
          b.kind === "var" ? "var" : b.kind === "const" ? "const" : "let";
        return `${keyword} ${b.name} = __prev.${b.name};`;
      })
      .join("\n");
    prelude += "\n";
  }
  if (helperDeclarations.length > 0) {
    prelude += `${helperDeclarations.join("\n")}\n`;
  }
  prelude += `${markPreludeCompletedFnName}();\n`;

  const mergedBindings = new Map();
  for (const binding of priorBindings) {
    mergedBindings.set(binding.name, binding.kind);
  }
  for (const binding of currentBindings) {
    mergedBindings.set(binding.name, binding.kind);
  }
  // Export the merged binding set so the next cell can import it through @prev.
  const exportNames = Array.from(mergedBindings.keys());
  const exportStmt = exportNames.length
    ? `\nexport { ${exportNames.join(", ")} };`
    : "";

  const nextBindings = Array.from(mergedBindings, ([name, kind]) => ({
    name,
    kind,
  }));
  return {
    source: `${prelude}${instrumentedCode}${exportStmt}`,
    currentBindings,
    nextBindings,
    priorBindings,
  };
}

function canReadCommittedBinding(module, binding) {
  if (
    !module ||
    binding.kind === "var" ||
    binding.kind === "function"
  ) {
    return false;
  }

  return tryReadBindingValue(module, binding.name).ok;
}
// Failed cells keep prior bindings plus the current-cell bindings whose
// initialization definitely ran before the throw. That means:
// - lexical bindings (`const` / `let` / `class`) can fall back to namespace
//   readability, which preserves names whose initialization already completed
//   even when a later step in the same declarator throws
// - `var` / `function` bindings only persist when an explicit declaration-site
//   or write-site marker fired, so unreached hoisted bindings do not become
//   ghost bindings in later cells
function collectCommittedBindings(
  module,
  priorBindings,
  currentBindings,
  committedCurrentBindingNames,
) {
  const mergedBindings = new Map();
  let committedCurrentBindingCount = 0;

  for (const binding of priorBindings) {
    mergedBindings.set(binding.name, binding.kind);
  }

  for (const binding of currentBindings) {
    if (
      committedCurrentBindingNames.has(binding.name) ||
      canReadCommittedBinding(module, binding)
    ) {
      mergedBindings.set(binding.name, binding.kind);
      committedCurrentBindingCount += 1;
    }
  }

  return {
    bindings: Array.from(mergedBindings, ([name, kind]) => ({ name, kind })),
    committedCurrentBindingCount,
  };
}

function send(message) {
  process.stdout.write(JSON.stringify(message));
  process.stdout.write("\n");
}

send({
  type: "native_pipe_handshake",
  token: nativePipeAuthToken,
});
send({
  type: "ready",
});

function sendNativePipeRequest(op, payload = {}) {
  const id = `native-pipe-${nativePipeRequestCounter++}`;
  send({
    type: "native_pipe_request",
    id,
    token: nativePipeAuthToken,
    op,
    ...payload,
  });
  return new Promise((resolve, reject) => {
    pendingNativePipeRequests.set(id, (message) => {
      if (!message.ok) {
        reject(new Error(message.error || "native pipe request failed"));
        return;
      }
      resolve(message.result);
    });
  });
}

function nativePipeBytesToBase64(data) {
  if (Buffer.isBuffer(data)) {
    return data.toString("base64");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "base64",
    );
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("base64");
  }
  throw new Error("native pipe write expected bytes");
}

function createPrivilegedNativePipeConnection(connectionId) {
  const state = {
    listeners: {
      data: new Set(),
      close: new Set(),
      error: new Set(),
    },
  };
  nativePipeConnections.set(connectionId, state);

  return Object.freeze({
    write(data) {
      void sendNativePipeRequest("write", {
        connection_id: connectionId,
        data_base64: nativePipeBytesToBase64(data),
      }).catch(() => {});
    },
    on(event, listener) {
      if (
        event !== "data" &&
        event !== "close" &&
        event !== "error"
      ) {
        throw new Error(`unsupported native pipe event: ${String(event)}`);
      }
      if (typeof listener !== "function") {
        throw new Error("native pipe event listener must be a function");
      }
      state.listeners[event].add(listener);
    },
    off(event, listener) {
      if (
        event !== "data" &&
        event !== "close" &&
        event !== "error"
      ) {
        throw new Error(`unsupported native pipe event: ${String(event)}`);
      }
      state.listeners[event].delete(listener);
    },
    end() {
      void sendNativePipeRequest("close", {
        connection_id: connectionId,
      }).catch(() => {});
      nativePipeConnections.delete(connectionId);
    },
  });
}

const privilegedNativePipeBridge = Object.freeze({
  async createConnection(pipePath) {
    if (typeof pipePath !== "string" || pipePath.length === 0) {
      throw new Error("native pipe path must be a non-empty string");
    }
    const result = await sendNativePipeRequest("connect", { path: pipePath });
    const connectionId =
      result &&
      typeof result === "object" &&
      typeof result.connection_id === "string"
        ? result.connection_id
        : null;
    if (!connectionId) {
      throw new Error("native pipe connect returned an invalid connection id");
    }
    return createPrivilegedNativePipeConnection(connectionId);
  },
});

function formatErrorMessage(error) {
  if (error && typeof error === "object" && "message" in error) {
    return error.message ? String(error.message) : String(error);
  }
  return String(error);
}

function sendFatalExecResultSync(kind, error) {
  if (!activeExecId) {
    return;
  }
  const payload = {
    type: "exec_result",
    id: activeExecId,
    ok: false,
    output: "",
    error: `obu-node-repl kernel ${kind}: ${formatErrorMessage(error)}; kernel reset. Catch or handle async errors (including Promise rejections and EventEmitter 'error' events) to avoid kernel termination.`,
  };
  try {
    fs.writeSync(process.stdout.fd, `${JSON.stringify(payload)}\n`);
  } catch {
    // Best effort only; the host will still surface stdout EOF diagnostics.
  }
}

function getAsyncExecState() {
  const execState = execContextStorage.getStore();
  if (
    !execState ||
    typeof execState.id !== "string" ||
    !execState.id
  ) {
    throw new Error("obu-node-repl exec context not found");
  }
  return execState;
}

function getCurrentExecState() {
  const execState = getAsyncExecState();
  // AsyncLocalStorage preserves the originating store for late callbacks, even
  // after the surrounding exec has already finished. Most helpers still require
  // an active exec because their results attach to the current tool call.
  if (execState.id !== activeExecId) {
    throw new Error("obu-node-repl exec context not found");
  }
  return execState;
}

function isActiveExecState(execState) {
  return execState.id === activeExecId;
}

function scheduleFatalExit(kind, error) {
  if (fatalExitScheduled) {
    process.exitCode = 1;
    return;
  }
  fatalExitScheduled = true;
  sendFatalExecResultSync(kind, error);

  try {
    fs.writeSync(
      process.stderr.fd,
      `obu-node-repl kernel ${kind}: ${formatErrorMessage(error)}\n`,
    );
  } catch {
    // ignore
  }

  // The host will observe stdout EOF, reset kernel state, and restart on demand.
  setImmediate(() => {
    process.exit(1);
  });
}

function formatLog(args) {
  return args
    .map((arg) =>
      typeof arg === "string" ? arg : inspect(arg, { depth: 4, colors: false }),
    )
    .join(" ");
}

function appendOutputEvent(outputEvents, kind, text) {
  outputEvents.push({ kind, text });
}

function renderOutputEvents(outputEvents) {
  let output = "";
  for (const event of outputEvents) {
    output += event.text;
    if (event.kind === "line") {
      output += "\n";
    }
  }
  if (
    outputEvents.length > 0 &&
    outputEvents[outputEvents.length - 1].kind === "line" &&
    output.endsWith("\n")
  ) {
    output = output.slice(0, -1);
  }
  return output;
}

function serializeResultValue(value) {
  if (typeof value === "undefined") {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return inspect(value, { depth: 6, colors: false });
  }
}

function ocuDisplay(value) {
  let execState;
  try {
    execState = getCurrentExecState();
  } catch {
    return;
  }
  if (execState.finalized) {
    return;
  }

  const atMs = Math.round(performance.now() - execState.startedAt);
  let payloadType;
  let payload;
  if (value && typeof value === "object" && value.__obuImage === true) {
    payloadType = "image";
    payload = { mime_type: value.mime_type, data: value.data };
  } else if (typeof value === "string") {
    payloadType = "text";
    payload = value;
  } else {
    payloadType = "json";
    try {
      payload = JSON.parse(JSON.stringify(value));
    } catch {
      payloadType = "text";
      payload = String(value);
    }
  }

  send({
    type: "display",
    exec_id: execState.id,
    at_ms: atMs,
    payload_type: payloadType,
    value: payload,
  });
}

function withCapturedConsole(ctx, outputEvents, fn) {
  const original = ctx.console ?? console;
  const captured = {
    ...original,
    log: (...args) => {
      appendOutputEvent(outputEvents, "line", formatLog(args));
    },
    info: (...args) => {
      appendOutputEvent(outputEvents, "line", formatLog(args));
    },
    warn: (...args) => {
      appendOutputEvent(outputEvents, "line", formatLog(args));
    },
    error: (...args) => {
      appendOutputEvent(outputEvents, "line", formatLog(args));
    },
    debug: (...args) => {
      appendOutputEvent(outputEvents, "line", formatLog(args));
    },
  };
  ctx.console = captured;
  return fn().finally(() => {
    ctx.console = original;
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toByteArray(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function encodeByteImage(bytes, mimeType) {
  if (bytes.byteLength === 0) {
    throw new Error("nodeRepl.emitImage expected non-empty bytes");
  }
  if (typeof mimeType !== "string" || !mimeType) {
    throw new Error("nodeRepl.emitImage expected a non-empty mimeType");
  }
  const image_url = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  return { image_url };
}

function rejectUnexpectedObjectKeys(value, allowedKeys) {
  const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpectedKeys.length > 0) {
    throw new Error("nodeRepl.emitImage received an unsupported value");
  }
}

function normalizeEmitImageUrl(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("nodeRepl.emitImage expected a non-empty image_url");
  }
  if (!/^data:/i.test(value)) {
    throw new Error("nodeRepl.emitImage only accepts data URLs");
  }
  return value;
}

function parseByteImageValue(value) {
  if (!isPlainObject(value) || !("bytes" in value)) {
    return null;
  }
  rejectUnexpectedObjectKeys(value, ["bytes", "mimeType"]);
  const bytes = toByteArray(value.bytes);
  if (!bytes) {
    throw new Error(
      "nodeRepl.emitImage expected bytes to be Buffer, Uint8Array, ArrayBuffer, or ArrayBufferView",
    );
  }
  return encodeByteImage(bytes, value.mimeType);
}

function normalizeEmitImageValue(value) {
  if (typeof value === "string") {
    return { image_url: normalizeEmitImageUrl(value) };
  }

  const byteImage = parseByteImageValue(value);
  if (byteImage) {
    return byteImage;
  }

  if (!isPlainObject(value)) {
    throw new Error("nodeRepl.emitImage received an unsupported value");
  }

  throw new Error("nodeRepl.emitImage received an unsupported value");
}

let currentRequestMeta = null;
let currentResponseMeta = null;
let currentFormElicitationSupported = false;

function normalizeResponseMetaValue(value) {
  if (!isPlainObject(value)) {
    throw new Error("nodeRepl.setResponseMeta expected a plain object");
  }
  return structuredClone(value);
}

function makeRejectedThenable(error) {
  return {
    then(onFulfilled, onRejected) {
      return Promise.reject(error).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.reject(error).catch(onRejected);
    },
    finally(onFinally) {
      return Promise.reject(error).finally(onFinally);
    },
  };
}

function trackExecBackgroundOperation(execState, operation) {
  const observation = { observed: false };
  const trackedOperation = operation.then(
    () => ({ ok: true, error: null, observation }),
    (error) => ({ ok: false, error, observation }),
  );
  execState.pendingBackgroundTasks.add(trackedOperation);
  return {
    then(onFulfilled, onRejected) {
      observation.observed = true;
      return operation.then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      observation.observed = true;
      return operation.catch(onRejected);
    },
    finally(onFinally) {
      observation.observed = true;
      return operation.finally(onFinally);
    },
  };
}

async function drainExecBackgroundTasks(execState) {
  while (execState.pendingBackgroundTasks.size > 0) {
    const backgroundTasks = [...execState.pendingBackgroundTasks];
    execState.pendingBackgroundTasks.clear();
    const backgroundResults = await Promise.all(backgroundTasks);
    const firstUnhandledBackgroundError = backgroundResults.find(
      (result) => !result.ok && !result.observation.observed,
    );
    if (firstUnhandledBackgroundError) {
      throw firstUnhandledBackgroundError.error;
    }
  }
}

function rejectUnexpectedElicitationRequestKeys(value) {
  const unexpectedKeys = Object.keys(value).filter(
    (key) =>
      key !== "message" && key !== "meta" && key !== "requestedSchema",
  );
  if (unexpectedKeys.length > 0) {
    throw new Error("nodeRepl.createElicitation received an unsupported value");
  }
}

function normalizeElicitationMetaValue(value) {
  if (value == null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new Error("nodeRepl.createElicitation meta must be an object");
  }
  return structuredClone(value);
}

function normalizeCreateElicitationRequest(value) {
  if (!isPlainObject(value)) {
    throw new Error("nodeRepl.createElicitation expected a request object");
  }
  rejectUnexpectedElicitationRequestKeys(value);
  if (typeof value.message !== "string" || value.message.trim().length === 0) {
    throw new Error("nodeRepl.createElicitation expected a non-empty message");
  }
  return {
    message: value.message,
    requested_schema:
      value.requestedSchema == null
        ? {
            type: "object",
            properties: {},
          }
        : structuredClone(value.requestedSchema),
    meta: normalizeElicitationMetaValue(value.meta),
  };
}

function createElicitation(request) {
  let execState;
  try {
    execState = getCurrentExecState();
    if (!currentFormElicitationSupported) {
      throw new Error(
        "nodeRepl.createElicitation is unavailable because the MCP client does not support form elicitation",
      );
    }
  } catch (error) {
    return makeRejectedThenable(error);
  }

  const operation = (async () => {
    const normalized = normalizeCreateElicitationRequest(await request);
    const id = `${execState.id}-elicitation-${elicitationCounter++}`;
    send({
      type: "elicit",
      id,
      exec_id: execState.id,
      message: normalized.message,
      requested_schema: normalized.requested_schema,
      meta: normalized.meta,
    });
    return new Promise((resolve, reject) => {
      pendingElicitations.set(id, (res) => {
        if (!res.ok) {
          reject(new Error(res.error || "createElicitation failed"));
          return;
        }
        resolve({
          action: res.action,
          content: res.content ?? null,
          _meta: res._meta ?? null,
        });
      });
    });
  })();

  return trackExecBackgroundOperation(execState, operation);
}

function withSuspendedTimeout(fn) {
  let execState;
  try {
    execState = getCurrentExecState();
    if (typeof fn !== "function") {
      throw new Error("privilegedNodeRepl.withSuspendedTimeout expected a function");
    }
  } catch (error) {
    return makeRejectedThenable(error);
  }

  const operation = (async () => {
    send({
      type: "suspend_timeout",
      exec_id: execState.id,
    });
    try {
      return await fn();
    } finally {
      send({
        type: "resume_timeout",
        exec_id: execState.id,
      });
    }
  })();

  return trackExecBackgroundOperation(execState, operation);
}

function authenticatedFetch(input, init) {
  let execState;
  try {
    execState = getAsyncExecState();
  } catch (error) {
    return makeRejectedThenable(error);
  }
  const promise = (async () => {
    if (typeof Request !== "function" || typeof Response !== "function") {
      throw new Error("nodeRepl.fetch requires Request and Response globals");
    }
    const request = new Request(await input, init);
    const body = Buffer.from(await request.arrayBuffer());
    const id = `${execState.id}-authenticated-fetch-${authenticatedFetchCounter++}`;
    const requestPayload = {
      method: request.method,
      url: request.url,
      headers: Array.from(request.headers.entries()).map(([name, value]) => ({
        name,
        value,
      })),
    };
    if (body.length > 0) {
      requestPayload.body_base64 = body.toString("base64");
    }
    send({
      type: "authenticated_fetch",
      id,
      exec_id: execState.id,
      request: requestPayload,
    });
    return new Promise((resolve, reject) => {
      pendingAuthenticatedFetch.set(id, (res) => {
        if (!res.ok) {
          reject(new Error(res.error || "nodeRepl.fetch failed"));
          return;
        }
        if (!res.response) {
          reject(new Error("nodeRepl.fetch did not return a response"));
          return;
        }
        resolve(responseFromHost(res.response));
      });
    });
  })();
  return isActiveExecState(execState)
    ? trackExecBackgroundOperation(execState, promise)
    : promise;
}

function responseFromHost(response) {
  const status = Number(response.status);
  const body =
    response.body_base64 && ![204, 205, 304].includes(status)
      ? Buffer.from(response.body_base64, "base64")
      : null;
  return new Response(body, {
    headers: (response.headers ?? []).map((header) => [
      header.name,
      header.value,
    ]),
    status,
    statusText: response.status_text ?? "",
  });
}

const nodeRepl = Object.freeze({
  cwd,
  homeDir,
  tmpDir,
  computerUse: Object.freeze({
    serviceAppPath: computerUseServiceAppPath,
  }),
  get requestMeta() {
    return currentRequestMeta;
  },
  get createElicitation() {
    return createElicitation;
  },
  fetch(input, init) {
    return authenticatedFetch(input, init);
  },
  write(text) {
    const execState = getCurrentExecState();
    if (typeof text !== "string") {
      throw new Error("nodeRepl.write expected a string");
    }
    appendOutputEvent(execState.outputEvents, "write", text);
  },
  setResponseMeta(meta) {
    getCurrentExecState();
    const normalized = normalizeResponseMetaValue(meta);
    currentResponseMeta = currentResponseMeta
      ? { ...currentResponseMeta, ...normalized }
      : normalized;
  },
  emitImage(imageLike) {
    let execState;
    try {
      execState = getCurrentExecState();
    } catch (error) {
      return makeRejectedThenable(error);
    }
    const operation = (async () => {
      const normalized = normalizeEmitImageValue(await imageLike);
      const id = `${execState.id}-emit-image-${emitImageCounter++}`;
      const payload = {
        type: "emit_image",
        id,
        exec_id: execState.id,
        image_url: normalized.image_url,
      };
      send(payload);
      return new Promise((resolve, reject) => {
        pendingEmitImage.set(id, (res) => {
          if (!res.ok) {
            reject(new Error(res.error || "emitImage failed"));
            return;
          }
          resolve();
        });
      });
    })();
    return trackExecBackgroundOperation(execState, operation);
  },
});

const obuRepl = Object.freeze({
  get requestMeta() {
    return currentRequestMeta;
  },
  discoverBackends() {
    return currentBackends.map((backend) => ({ ...backend }));
  },
  discoverBackendDiagnostics() {
    return currentBackendDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  },
});

/**
 * @typedef {typeof nodeRepl} NodeRepl
 * @typedef {NodeRepl & {
 *   withSuspendedTimeout<T>(fn: () => T | Promise<T>): Promise<T>,
 * }} PrivilegedNodeRepl
 */

/** @type {PrivilegedNodeRepl} */
const privilegedNodeRepl = Object.freeze(
  Object.create(nodeRepl, {
    withSuspendedTimeout: {
      configurable: false,
      enumerable: true,
      value: withSuspendedTimeout,
      writable: false,
    },
  }),
);

defineLockedGlobal("nodeRepl", nodeRepl);
defineLockedGlobal("obuRepl", obuRepl);
defineLockedGlobal("display", ocuDisplay);
defineLockedGlobal("tmpDir", tmpDir);

async function ensureObuSdkBootstrap() {
  if (Object.prototype.hasOwnProperty.call(context, "agent")) {
    return;
  }
  if (!ocuSdkBootstrapPromise) {
    ocuSdkBootstrapPromise = (async () => {
      let sdkEntrypointUrl;
      try {
        sdkEntrypointUrl = getObuSdkEntrypointUrl();
      } catch (error) {
        if (isObuSdkNotFoundError(error)) {
          return;
        }
        throw error;
      }

      const source = `
const ocuSdk = await import(${JSON.stringify(sdkEntrypointUrl)});
const { agent } = await ocuSdk.setupObuRuntime({});
Object.defineProperty(globalThis, "agent", {
  value: agent,
  writable: false,
  configurable: false,
  enumerable: true,
});
Object.defineProperty(globalThis, "help", {
  value: () => agent.help(),
  writable: false,
  configurable: false,
  enumerable: true,
});
`;
      const bootstrapIdentifier = path.join(cwd, ".obu_node_repl_sdk_bootstrap.mjs");
      const bootstrapModule = new SourceTextModule(source, {
        context,
        identifier: bootstrapIdentifier,
        initializeImportMeta(meta, mod) {
          setImportMeta(meta, mod, true);
        },
        importModuleDynamically(specifier, referrer) {
          return importResolved(resolveSpecifier(specifier, referrer?.identifier));
        },
      });
      await bootstrapModule.link(() => {
        throw new Error("SDK bootstrap does not support static imports");
      });
      await bootstrapModule.evaluate();
    })();
  }
  try {
    await ocuSdkBootstrapPromise;
  } finally {
    if (!Object.prototype.hasOwnProperty.call(context, "agent")) {
      ocuSdkBootstrapPromise = null;
    }
  }
}

async function handleExec(message) {
  clearLocalFileModuleCaches();
  const execId =
    typeof message.id === "string"
      ? message.id
      : typeof message.exec_id === "string"
        ? message.exec_id
        : `exec-${crypto.randomUUID()}`;
  activeExecId = execId;
  currentRequestMeta =
    message.request_meta && typeof message.request_meta === "object"
      ? deepFreeze(structuredClone(message.request_meta))
      : null;
  currentFormElicitationSupported =
    message.form_elicitation_supported === true;
  const execState = {
    id: execId,
    startedAt: performance.now(),
    finalized: false,
    pendingBackgroundTasks: new Set(),
    outputEvents: [],
  };

  let module = null;
  /** @type {Binding[]} */
  let currentBindings = [];
  /** @type {Binding[]} */
  let nextBindings = [];
  /** @type {Binding[]} */
  let priorBindings = previousBindings;
  let moduleLinked = false;
  let preludeCompleted = false;
  const committedCurrentBindingNames = new Set();
  const markCommittedBindings = (...names) => {
    for (const name of names) {
      committedCurrentBindingNames.add(name);
    }
  };
  const markPreludeCompleted = () => {
    preludeCompleted = true;
  };

  try {
    context.__obuLastResult = undefined;
    const code =
      typeof message.code === "string"
        ? message.code
        : typeof message.source === "string"
          ? message.source
          : "";
    const builtSource = await buildModuleSource(code);
    const source = builtSource.source;
    currentBindings = builtSource.currentBindings;
    nextBindings = builtSource.nextBindings;
    priorBindings = builtSource.priorBindings;
    let output = "";

    await execContextStorage.run(execState, async () => {
      await withCapturedConsole(context, execState.outputEvents, async () => {
        await ensureObuSdkBootstrap();
        const cellIdentifier = path.join(
          cwd,
          `.obu_node_repl_cell_${cellCounter++}.mjs`,
        );
        module = new SourceTextModule(source, {
          context,
          identifier: cellIdentifier,
          initializeImportMeta(meta, mod) {
            setImportMeta(meta, mod, true);
            meta.__obuInternalMarkCommittedBindings = markCommittedBindings;
            meta.__obuInternalMarkPreludeCompleted = markPreludeCompleted;
          },
          importModuleDynamically(specifier, referrer) {
            return importResolved(resolveSpecifier(specifier, referrer?.identifier));
          },
        });

        await module.link(async (specifier) => {
          if (specifier === "@prev" && previousModule) {
            const exportNames = previousBindings.map((b) => b.name);
            // Build a synthetic module snapshot of the prior cell's exports.
            // This is the bridge that carries values from cell N to cell N+1.
            const synthetic = new SyntheticModule(
              exportNames,
              function initSynthetic() {
                for (const binding of previousBindings) {
                  this.setExport(
                    binding.name,
                    previousModule.namespace[binding.name],
                  );
                }
              },
              { context },
            );
            return synthetic;
          }
          throw new Error(
            `Top-level static import "${specifier}" is not supported in obu-node-repl. Use await import("${specifier}") instead.`,
          );
        });
        moduleLinked = true;

        await module.evaluate();
        await drainExecBackgroundTasks(execState);
        output = renderOutputEvents(execState.outputEvents);
      });
    });

    previousModule = module;
    previousBindings = nextBindings;
    execState.finalized = true;

    send({
      type: "exec_result",
      id: execId,
      exec_id: execId,
      ok: true,
      output,
      stdout: output,
      stderr: "",
      result: serializeResultValue(context.__obuLastResult),
      duration_ms: Math.round(performance.now() - execState.startedAt),
      error: null,
      response_meta: currentResponseMeta,
    });
  } catch (error) {
    execState.finalized = true;
    const { bindings: committedBindings, committedCurrentBindingCount } =
      collectCommittedBindings(
      moduleLinked ? module : null,
      priorBindings,
      currentBindings,
      committedCurrentBindingNames,
    );
    // Preserve the last successfully linked module across link-time failures.
    // A module whose link step failed cannot safely back @prev because reading
    // its namespace throws before evaluation ever begins. Likewise, if a
    // linked module failed before its prelude recreated carried bindings, keep
    // the old module so @prev still points at the last cell whose prelude and
    // body actually established the carried values. Once the prelude has run,
    // promote the failed module even if it only updated existing bindings.
    if (
      module &&
      moduleLinked &&
      (committedCurrentBindingCount > 0 ||
        (preludeCompleted && priorBindings.length > 0))
    ) {
      previousModule = module;
      previousBindings = committedBindings;
    }
    send({
      type: "exec_result",
      id: execId,
      exec_id: execId,
      ok: false,
      output: "",
      stdout: "",
      stderr: "",
      result: null,
      duration_ms: Math.round(performance.now() - execState.startedAt),
      error: error && error.message ? error.message : String(error),
      response_meta: currentResponseMeta,
    });
  } finally {
    if (activeExecId === execId) {
      activeExecId = null;
    }
    delete context.__obuLastResult;
    currentRequestMeta = null;
    currentResponseMeta = null;
    currentFormElicitationSupported = false;
  }
}

function handleEmitImageResult(message) {
  const resolver = pendingEmitImage.get(message.id);
  if (resolver) {
    pendingEmitImage.delete(message.id);
    resolver(message);
  }
}

function handleElicitationResult(message) {
  const resolver = pendingElicitations.get(message.id);
  if (resolver) {
    pendingElicitations.delete(message.id);
    resolver(message);
  }
}

function handleAuthenticatedFetchResult(message) {
  const resolver = pendingAuthenticatedFetch.get(message.id);
  if (resolver) {
    pendingAuthenticatedFetch.delete(message.id);
    resolver(message);
  }
}

function handleNativePipeResponse(message) {
  const resolver = pendingNativePipeRequests.get(message.id);
  if (resolver) {
    pendingNativePipeRequests.delete(message.id);
    resolver(message);
  }
}

function handleNativePipeData(message) {
  const connection = nativePipeConnections.get(message.connection_id);
  const data = Buffer.from(message.data_base64, "base64");
  for (const listener of connection?.listeners.data ?? []) {
    listener(data);
  }
}

function handleNativePipeClosed(message) {
  const connection = nativePipeConnections.get(message.connection_id);
  if (!connection) {
    return;
  }
  nativePipeConnections.delete(message.connection_id);
  if (message.error) {
    const error = new Error(message.error);
    for (const listener of connection.listeners.error) {
      void Promise.resolve()
        .then(() => listener(error))
        .catch(() => {});
    }
  }
  for (const listener of connection.listeners.close) {
    void Promise.resolve()
      .then(() => listener())
      .catch(() => {});
  }
}

function setBackendInventory(message) {
  currentBackends = normalizeBackends(message.backends);
  currentBackendDiagnostics = normalizeBackendDiagnostics(
    message.backend_diagnostics ?? message.backendDiagnostics,
  );
}

let queue = Promise.resolve();
let pendingInputSegments = [];

process.on("uncaughtException", (error) => {
  scheduleFatalExit("uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  scheduleFatalExit("unhandled rejection", reason);
});

function handleInputLine(line) {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === "exec") {
    queue = queue.then(() => handleExec(message));
    return;
  }
  if (message.type === "add_module_dir" || message.type === "add_node_module_dir") {
    addModuleSearchBase(message.path);
    return;
  }
  if (message.type === "set_backend_inventory") {
    setBackendInventory(message);
    return;
  }
  if (message.type === "emit_image_result") {
    handleEmitImageResult(message);
    return;
  }
  if (message.type === "elicitation_result") {
    handleElicitationResult(message);
    return;
  }
  if (message.type === "authenticated_fetch_result") {
    handleAuthenticatedFetchResult(message);
    return;
  }
  if (message.type === "native_pipe_response") {
    handleNativePipeResponse(message);
    return;
  }
  if (message.type === "native_pipe_data") {
    handleNativePipeData(message);
    return;
  }
  if (message.type === "native_pipe_closed") {
    handleNativePipeClosed(message);
    return;
  }
}

function takePendingInputFrame() {
  if (pendingInputSegments.length === 0) {
    return null;
  }

  // Keep raw stdin chunks queued until a full JSONL frame is ready so we only
  // assemble the frame bytes once.
  const frame =
    pendingInputSegments.length === 1
      ? pendingInputSegments[0]
      : Buffer.concat(pendingInputSegments);
  pendingInputSegments = [];
  return frame;
}

function handleInputFrame(frame) {
  if (!frame) {
    return;
  }

  if (frame[frame.length - 1] === 0x0d) {
    frame = frame.subarray(0, frame.length - 1);
  }
  handleInputLine(frame.toString("utf8"));
}

process.stdin.on("data", (chunk) => {
  const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let segmentStart = 0;
  let frameEnd = input.indexOf(0x0a);
  while (frameEnd !== -1) {
    pendingInputSegments.push(input.subarray(segmentStart, frameEnd));
    handleInputFrame(takePendingInputFrame());
    segmentStart = frameEnd + 1;
    frameEnd = input.indexOf(0x0a, segmentStart);
  }
  if (segmentStart < input.length) {
    pendingInputSegments.push(input.subarray(segmentStart));
  }
});

process.stdin.on("end", () => {
  handleInputFrame(takePendingInputFrame());
});
