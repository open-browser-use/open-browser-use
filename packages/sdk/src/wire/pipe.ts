export type NativePipeConnectionEvent = "data" | "close" | "error";

export type NativePipeConnection = {
  write(data: Uint8Array): void;
  on(event: NativePipeConnectionEvent, listener: (arg?: unknown) => void): void;
  off(event: NativePipeConnectionEvent, listener: (arg?: unknown) => void): void;
  end(): void;
};

export type NativePipeBridge = {
  createConnection(pipePath: string): Promise<NativePipeConnection>;
};

export function readPipeUnavailable(): string {
  const msg = (import.meta as { __obuNativePipeUnavailableMessage?: unknown })
    .__obuNativePipeUnavailableMessage;
  return typeof msg === "string" && msg.length > 0
    ? msg
    : "privileged native pipe bridge is not available";
}

export function readPipeBridge(): NativePipeBridge | null {
  const bridge = (import.meta as { __obuNativePipe?: unknown }).__obuNativePipe;
  if (
    bridge == null ||
    typeof bridge !== "object" ||
    typeof (bridge as { createConnection?: unknown }).createConnection !== "function"
  ) {
    return null;
  }
  return bridge as NativePipeBridge;
}
