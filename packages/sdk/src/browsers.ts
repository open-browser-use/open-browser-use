import { Browser } from "./browser.js";
import { ObuError, ERR_NO_BACKEND, productErrorData } from "./errors.js";
import { Guards } from "./guards.js";
import type { ConnectedBackend } from "./runtime.js";

export type DiscoveredBackend = {
  type: string;
  name: string;
  socketPath: string;
  metadata?: Record<string, unknown>;
};

export type BackendDiscoveryDiagnostic = {
  source: string;
  reason: string;
};

export type RuntimeConnector = {
  listBackends(): DiscoveredBackend[];
  listBackendDiagnostics?(): BackendDiscoveryDiagnostic[];
  connectBackend(backend: DiscoveredBackend): Promise<ConnectedBackend>;
};

export type BrowserGetOptions = {
  guards?: Guards;
  /**
   * Explicit backend assertion or escape hatch. Chromium-family browser names
   * default to WebExtension because that preserves profile state and takeover.
   */
  requireBackend?: "webextension";
  backend?: "cdp" | "webextension";
};

const CHROMIUM_FAMILY = new Set(["chrome", "edge", "brave", "arc", "chromium", "playwright"]);

export class Browsers {
  constructor(
    private readonly connector: RuntimeConnector,
    private readonly defaultGuards = new Guards(),
  ) {}

  async list(): Promise<DiscoveredBackend[]> {
    return this.connector.listBackends();
  }

  async diagnostics(): Promise<BackendDiscoveryDiagnostic[]> {
    return this.connector.listBackendDiagnostics?.() ?? [];
  }

  async get(idOrKind = "chrome", opts: BrowserGetOptions = {}): Promise<Browser> {
    const backend = selectBackend(
      this.connector.listBackends(),
      idOrKind,
      this.connector.listBackendDiagnostics?.() ?? [],
      opts,
    );
    const connected = await this.connector.connectBackend(backend);
    return new Browser(connected.transport, connected.info, connected.backend, opts.guards ?? this.defaultGuards);
  }
}

export function selectBackend(
  backends: DiscoveredBackend[],
  idOrKind: string,
  diagnostics: BackendDiscoveryDiagnostic[] = [],
  opts: Pick<BrowserGetOptions, "backend" | "requireBackend"> = {},
): DiscoveredBackend {
  if (opts.requireBackend && opts.backend && opts.requireBackend !== opts.backend) {
    throw new Error(`conflicting backend options: requireBackend=${opts.requireBackend} backend=${opts.backend}`);
  }
  const requiredBackend = opts.requireBackend ?? opts.backend;

  if (idOrKind === "cdp") {
    const cdp = backends.find((backend) => backend.type === "cdp" || backend.name === "cdp");
    if (cdp) return cdp;
    throw noBackend(idOrKind, diagnostics, backends);
  }

  const exactSocket = backends.find((backend) => backend.socketPath === idOrKind);
  if (exactSocket) {
    if (requiredBackend && exactSocket.type !== requiredBackend) {
      throw noBackend(idOrKind, diagnostics, [exactSocket]);
    }
    return exactSocket;
  }

  if (requiredBackend === "cdp") {
    const cdp = backends.find((backend) => backend.type === "cdp" && (backend.name === idOrKind || CHROMIUM_FAMILY.has(idOrKind)));
    if (cdp) return cdp;
    throw noBackend(idOrKind, diagnostics, backends);
  }

  if (CHROMIUM_FAMILY.has(idOrKind)) {
    const extension = chooseNewest(chromiumFamilyWebExtensions(backends, idOrKind));
    if (extension) return extension;
    throw noBackend(idOrKind, diagnostics, backends);
  }

  const exactNames = backends.filter((backend) => backend.name === idOrKind);
  if (requiredBackend) {
    const matchingExact = exactNames.filter((backend) => backend.type === requiredBackend);
    if (matchingExact.length === 1) return matchingExact[0]!;
    if (matchingExact.length > 1) return chooseNewest(matchingExact)!;
    throw noBackend(idOrKind, diagnostics, backends);
  }
  if (exactNames.length === 1) return exactNames[0]!;

  if (exactNames.length > 1) return chooseNewest(exactNames)!;

  const byType = backends.find((backend) => backend.type === idOrKind);
  if (byType) return byType;
  throw noBackend(idOrKind, diagnostics, backends);
}

function chromiumFamilyWebExtensions(backends: DiscoveredBackend[], idOrKind: string): DiscoveredBackend[] {
  return backends.filter(
    (backend) =>
      backend.type === "webextension" &&
      ((backend.metadata?.browser_kind === idOrKind) || backend.name === idOrKind),
  );
}

function chooseNewest(backends: DiscoveredBackend[]): DiscoveredBackend | undefined {
  return [...backends].sort((a, b) => {
    const startedDiff = startedAtMs(b) - startedAtMs(a);
    if (startedDiff !== 0) return startedDiff;
    return a.socketPath.localeCompare(b.socketPath);
  })[0];
}

function startedAtMs(backend: DiscoveredBackend): number {
  const value = backend.metadata?.startedAt;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function noBackend(kind: string, diagnostics: BackendDiscoveryDiagnostic[], ignoredBackends: DiscoveredBackend[] = []): ObuError {
  let message = `no backend available for ${kind}`;
  const visibleDiagnostics = diagnostics
    .filter((diagnostic) => diagnostic.source && diagnostic.reason)
    .slice(0, 3)
    .map((diagnostic) => `${diagnostic.source}: ${diagnostic.reason}`);
  if (visibleDiagnostics.length > 0) {
    message += `. Ignored backend descriptors: ${visibleDiagnostics.join("; ")}`;
    if (diagnostics.length > visibleDiagnostics.length) {
      message += `; +${diagnostics.length - visibleDiagnostics.length} more`;
    }
  }
  const ignoredBackendDiagnostics = ignoredBackends
    .slice(0, 5)
    .map((backend) => `${backend.type}:${backend.name}${backend.socketPath ? ` at ${backend.socketPath}` : ""}`);
  if (ignoredBackendDiagnostics.length > 0) {
    message += `. Ignored available backends: ${ignoredBackendDiagnostics.join("; ")}`;
    if (ignoredBackends.length > ignoredBackendDiagnostics.length) {
      message += `; +${ignoredBackends.length - ignoredBackendDiagnostics.length} more`;
    }
  }
  const verifyHint = "obu verify --agent=<agent-id> --browser=<browser> --channel=<extension-channel> --extension-id=<extension-id>";
  const doctorHint = "obu doctor browser --repair";
  message += ". Run obu verify for readiness; use obu doctor browser only for lower-level browser diagnostics.";
  return new ObuError(
    ERR_NO_BACKEND,
    message,
    productErrorData("no_backend", {
      requested_backend: kind,
      diagnostics: visibleDiagnostics,
      ignored_backends: ignoredBackendDiagnostics,
      verify_hint: verifyHint,
      doctor_hint: doctorHint,
    }),
  );
}
