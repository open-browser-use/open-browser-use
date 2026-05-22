import { Agent } from "./agent.js";
import { ObuError, ERR_PEER_AUTH } from "./errors.js";
import type { Guards } from "./guards.js";
import type { BackendDiscoveryDiagnostic, DiscoveredBackend } from "./browsers.js";
import type { BrowserInfo } from "./types.js";
import { GET_INFO } from "./wire/methods.js";
import { readPipeBridge, readPipeUnavailable, type NativePipeBridge } from "./wire/pipe.js";
import { Transport } from "./wire/transport.js";

export type ConnectedBackend = {
  backend: DiscoveredBackend;
  transport: Transport;
  info: BrowserInfo;
};

export type SetupObuRuntimeOptions = {
  globals?: Record<string, unknown>;
  guards?: Guards;
  /** Test-only injection; production runtime reads `import.meta.__obuNativePipe`. */
  pipeBridge?: NativePipeBridge;
};

export async function setupObuRuntime(
  opts: SetupObuRuntimeOptions = {},
): Promise<{ agent: Agent }> {
  const pipe = opts.pipeBridge ?? readPipeBridge();
  if (!pipe) throw new ObuError(-1, readPipeUnavailable());

  const listBackends = (): DiscoveredBackend[] => {
    const obuRepl = (globalThis as { obuRepl?: { discoverBackends?: unknown } }).obuRepl;
    if (typeof obuRepl?.discoverBackends !== "function") return [];
    return obuRepl.discoverBackends() as DiscoveredBackend[];
  };

  const listBackendDiagnostics = (): BackendDiscoveryDiagnostic[] => {
    const obuRepl = (globalThis as { obuRepl?: { discoverBackendDiagnostics?: unknown } }).obuRepl;
    if (typeof obuRepl?.discoverBackendDiagnostics !== "function") return [];
    return obuRepl.discoverBackendDiagnostics() as BackendDiscoveryDiagnostic[];
  };

  const connectBackend = async (backend: DiscoveredBackend): Promise<ConnectedBackend> => {
    const connection = await createConnection(pipe, backend.socketPath);
    const transport = new Transport(connection);
    const info = await transport.sendRequest<BrowserInfo>(GET_INFO, {}, 10_000);
    return { backend, transport, info };
  };

  const agentOptions = opts.guards ? { guards: opts.guards } : {};
  const agent = new Agent({ listBackends, listBackendDiagnostics, connectBackend }, agentOptions);
  if (opts.globals) opts.globals.agent = agent;
  return { agent };
}

async function createConnection(pipe: NativePipeBridge, socketPath: string) {
  try {
    return await pipe.createConnection(socketPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("auth rejected") || message.includes("capability token") || message.includes("-1100")) {
      throw new ObuError(ERR_PEER_AUTH, message);
    }
    throw error;
  }
}
