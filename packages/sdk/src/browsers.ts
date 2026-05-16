import { Browser } from "./browser.js";
import { ObuError, ERR_NO_BACKEND } from "./errors.js";
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

const CHROMIUM_FAMILY = new Set(["chrome", "edge", "brave", "arc", "chromium", "playwright"]);

export class Browsers {
  constructor(private readonly connector: RuntimeConnector) {}

  async list(): Promise<DiscoveredBackend[]> {
    return this.connector.listBackends();
  }

  async diagnostics(): Promise<BackendDiscoveryDiagnostic[]> {
    return this.connector.listBackendDiagnostics?.() ?? [];
  }

  async get(idOrKind = "chrome"): Promise<Browser> {
    const backend = selectBackend(
      this.connector.listBackends(),
      idOrKind,
      this.connector.listBackendDiagnostics?.() ?? [],
    );
    const connected = await this.connector.connectBackend(backend);
    return new Browser(connected.transport, connected.info, connected.backend);
  }
}

export function selectBackend(
  backends: DiscoveredBackend[],
  idOrKind: string,
  diagnostics: BackendDiscoveryDiagnostic[] = [],
): DiscoveredBackend {
  if (idOrKind === "cdp") {
    const cdp = backends.find((backend) => backend.type === "cdp" || backend.name === "cdp");
    if (cdp) return cdp;
    throw noBackend(idOrKind, diagnostics);
  }

  const exactSocket = backends.find((backend) => backend.socketPath === idOrKind);
  if (exactSocket) return exactSocket;

  const exactNames = backends.filter((backend) => backend.name === idOrKind);
  if (exactNames.length === 1) return exactNames[0]!;

  if (CHROMIUM_FAMILY.has(idOrKind)) {
    const extension = chooseNewest(
      backends.filter(
        (backend) =>
          backend.type === "webextension" &&
          ((backend.metadata?.browser_kind === idOrKind) || backend.name === idOrKind),
      ),
    );
    if (extension) return extension;
    const cdp = backends.find((backend) => backend.type === "cdp");
    if (cdp) return cdp;
  }

  if (exactNames.length > 1) return chooseNewest(exactNames)!;

  const byType = backends.find((backend) => backend.type === idOrKind);
  if (byType) return byType;
  throw noBackend(idOrKind, diagnostics);
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

function noBackend(kind: string, diagnostics: BackendDiscoveryDiagnostic[]): ObuError {
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
  message += ". Run obu doctor browser for setup diagnostics.";
  return new ObuError(ERR_NO_BACKEND, message);
}
