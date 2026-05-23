import {
  baseDisconnectedStatus,
  canReconnect as nativeCanReconnect,
  cleanupFailedStatus,
  connectingStatus,
  connectFailureStatus,
  disconnectedStatus,
  heartbeatFailureStatus,
  helloAckStatus,
  helloPendingStatus,
  helloTimeoutStatus,
  planReconnect,
  planRestorePendingReconnect,
  stoppedStatus,
  stoppingStatus,
  versionMismatchStatus,
  type NativeHostDiagnosis,
  type NativeHostState,
} from "./lifecycle/native_transport_machine.js";
import type { PendingExtensionUpdate } from "./lifecycle/extension_update_machine.js";
import type { OverlayReleaseDiagnostic, PendingExtensionUpdateTrigger } from "./overlay_coordinator.js";

export type HostStatus = {
  state: NativeHostState;
  message?: string;
  diagnosis?: NativeHostDiagnosis;
  hostVersion?: string;
  deliverableTabs?: number;
  overlayRelease?: OverlayReleaseDiagnostic[];
  retryDelayMs?: number;
  nextRetryAt?: number;
  pendingExtensionUpdate?: PendingExtensionUpdate;
  updatedAt: number;
};

export type NativeTransportDebugLog = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  data?: unknown,
) => void;

export type NativeTransportControllerOptions = {
  hostName: string;
  reconnectAlarmName: string;
  helloTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  initialStatus: HostStatus;
  now(): number;
  scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  connectNative(hostName: string): NativePort;
  createReconnectAlarm(name: string, delayMs: number): void;
  clearReconnectAlarm(name: string): void;
  runtimeLastErrorMessage(): string | undefined;
  appendDebugLog: NativeTransportDebugLog;
  statusLogLevel(status: HostStatus): "debug" | "info" | "warn" | "error";
  normalizeStatus(status: HostStatus): HostStatus;
  persistStatus(status: HostStatus): Promise<void>;
  diagnoseNativeHostFailure(message: string, fallback: NativeHostDiagnosis): NativeHostDiagnosis;
  rejectPending(message: string): void;
  sendRequest(method: string, params?: unknown): Promise<unknown>;
  stopRequestParams(): Promise<unknown>;
  handleNativeApplicationMessage(message: unknown, sourcePort: NativePort): Promise<void>;
  releaseActiveTakeoverForUnavailableHost(reason: NativeHostDiagnosis): Promise<void>;
  stopActiveBrowserControl(): Promise<{ failures?: readonly unknown[] } | void>;
  helloPayload(): Promise<unknown>;
  publishExtensionStatus(): void;
  schedulePendingExtensionUpdateCheck(trigger: PendingExtensionUpdateTrigger): void;
};

export class NativeTransportController {
  private status: HostStatus;
  private port: NativePort | null = null;
  private stopping = false;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs: number;

  constructor(private readonly options: NativeTransportControllerOptions) {
    this.status = options.initialStatus;
    this.reconnectDelayMs = options.reconnectInitialMs;
  }

  currentStatus(): HostStatus {
    return this.status;
  }

  currentPort(): NativePort | null {
    return this.port;
  }

  isStopping(): boolean {
    return this.stopping;
  }

  hasHelloTimer(): boolean {
    return this.helloTimer !== undefined;
  }

  hasReconnectTimer(): boolean {
    return this.reconnectTimer !== undefined;
  }

  hasConnectedPort(): boolean {
    return this.port !== null;
  }

  isCurrentPort(port: NativePort): boolean {
    return this.port === port;
  }

  canReconnect(): boolean {
    return nativeCanReconnect({ stopping: this.stopping, state: this.status.state });
  }

  async bootstrap(storedStatus: unknown, isHostStatus: (value: unknown) => value is HostStatus): Promise<void> {
    if (isHostStatus(storedStatus)) {
      if (storedStatus.state === "stopping" || storedStatus.state === "stopped" || storedStatus.state === "cleanup_failed" || storedStatus.state === "version_mismatch") {
        this.stopping = storedStatus.state === "stopping" || storedStatus.state === "stopped" || storedStatus.state === "cleanup_failed";
        const restoredStatus: HostStatus = {
          state: storedStatus.state,
          message: storedStatus.message
            ?? (storedStatus.state === "version_mismatch" ? "Version mismatch" : storedStatus.state === "stopping" ? "Stopping..." : "Stopped by user"),
          updatedAt: this.options.now(),
        };
        if (storedStatus.state === "version_mismatch") restoredStatus.diagnosis = "version_mismatch";
        await this.setStatus(restoredStatus);
        return;
      }
      if (await this.restorePendingReconnect(storedStatus)) return;
    }
    await this.connect();
  }

  onReconnectAlarm(): void {
    if (!this.canReconnect()) return;
    this.reconnectTimer = undefined;
    void this.connect();
  }

  async connect(): Promise<void> {
    if (this.status.state === "connecting" || this.status.state === "hello_pending" || this.status.state === "connected") return;
    this.clearReconnect();
    this.options.appendDebugLog("info", "native.connect.start", { host: this.options.hostName });
    await this.setStatus(connectingStatus(this.options.now()));
    let targetPort: NativePort;
    try {
      targetPort = this.options.connectNative(this.options.hostName);
      this.port = targetPort;
    } catch (error) {
      const message = errorMessage(error);
      this.options.appendDebugLog("error", "native.connect.failed", { message });
      await this.setStatus(connectFailureStatus(
        message,
        this.options.diagnoseNativeHostFailure(message, "native_host_unavailable"),
        this.options.now(),
      ));
      this.scheduleReconnect();
      return;
    }

    targetPort.onMessage.addListener((message) => {
      if (this.port !== targetPort) return;
      void this.handleNativeMessage(message, targetPort);
    });
    targetPort.onDisconnect.addListener(() => {
      const message = this.options.runtimeLastErrorMessage();
      if (this.port !== targetPort) return;
      const wasConnecting = this.status.state === "connecting" || this.status.state === "hello_pending";
      this.port = null;
      this.options.rejectPending(message ?? "native host disconnected");
      this.clearHelloTimeout();
      this.clearHeartbeat();
      if (this.status.state !== "stopped" && this.status.state !== "version_mismatch") {
        const disconnectedMessage = message ?? (wasConnecting ? "native host exited before hello_ack" : "native host disconnected");
        this.options.appendDebugLog(wasConnecting ? "error" : "warn", "native.disconnected", {
          message: disconnectedMessage,
          wasConnecting,
        });
        void this.setStatus(disconnectedStatus({
          message: disconnectedMessage,
          diagnosis: this.options.diagnoseNativeHostFailure(
            disconnectedMessage,
            wasConnecting ? "native_host_crashed" : "native_host_disconnected",
          ),
          wasConnecting,
          now: this.options.now(),
        }));
        void this.options.releaseActiveTakeoverForUnavailableHost(wasConnecting ? "native_host_crashed" : "native_host_disconnected");
        this.scheduleReconnect();
      }
    });

    try {
      targetPort.postMessage(await this.options.helloPayload());
      this.options.appendDebugLog("debug", "native.hello.sent", { host: this.options.hostName });
      await this.setStatus(helloPendingStatus(this.options.now()));
      this.scheduleHelloTimeout(targetPort);
    } catch (error) {
      if (this.port === targetPort) this.port = null;
      try {
        targetPort.disconnect();
      } catch {
        // The hello write already failed; reconnect recovery should not depend on cleanup.
      }
      const message = errorMessage(error);
      this.options.appendDebugLog("error", "native.hello.failed", { message });
      await this.setStatus(connectFailureStatus(
        message,
        this.options.diagnoseNativeHostFailure(message, "native_host_unavailable"),
        this.options.now(),
      ));
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.options.appendDebugLog("info", "control.stop");
    this.stopping = true;
    this.clearReconnect();
    this.clearHelloTimeout();
    this.clearHeartbeat();
    await this.setStatus(stoppingStatus("Stopping...", this.options.now()));
    let cleanupError: unknown;
    let cleanupResult: { failures?: readonly unknown[] } | void = undefined;
    try {
      if (this.port) {
        await withTimeout(
          this.options.sendRequest("stopBrowserControl", await this.options.stopRequestParams()),
          1500,
        ).catch(() => undefined);
        cleanupResult = await this.options.stopActiveBrowserControl();
        this.port.disconnect();
      } else {
        cleanupResult = await this.options.stopActiveBrowserControl();
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      this.options.rejectPending("browser control stopped");
      this.port = null;
      const failures = cleanupResult?.failures ?? [];
      if (cleanupError || failures.length > 0) {
        const message = cleanupError
          ? `Stop cleanup failed: ${errorMessage(cleanupError)}`
          : `Stop cleanup failed for ${failures.length} tab${failures.length === 1 ? "" : "s"}`;
        this.options.appendDebugLog("error", "control.stop.cleanup_failed", { message, failures });
        await this.setStatus(cleanupFailedStatus(message, this.options.now()));
      } else {
        await this.setStatus(stoppedStatus("Stopped by user", this.options.now()));
        this.options.schedulePendingExtensionUpdateCheck("control_stopped");
      }
    }
  }

  async resume(): Promise<void> {
    this.options.appendDebugLog("info", "control.resume");
    this.stopping = false;
    this.clearReconnect();
    await this.setStatus(baseDisconnectedStatus(this.options.now()));
    await this.connect();
  }

  async setStatus(next: HostStatus): Promise<void> {
    this.status = this.options.normalizeStatus(next);
    this.options.appendDebugLog(this.options.statusLogLevel(next), "status.changed", {
      state: this.status.state,
      diagnosis: this.status.diagnosis,
      message: this.status.message,
      retryDelayMs: this.status.retryDelayMs,
      pendingExtensionUpdate: this.status.pendingExtensionUpdate?.version ?? this.status.pendingExtensionUpdate?.state,
    });
    await this.options.persistStatus(this.status);
  }

  private async handleNativeMessage(message: unknown, sourcePort: NativePort): Promise<void> {
    if (isRecord(message) && message.type === "hello_ack") {
      this.clearHelloTimeout();
      this.stopping = false;
      this.reconnectDelayMs = this.options.reconnectInitialMs;
      this.options.appendDebugLog("info", "native.hello.ack", {
        hostVersion: typeof message.host_version === "string" ? message.host_version : undefined,
      });
      await this.setStatus(helloAckStatus(
        typeof message.host_version === "string" ? message.host_version : undefined,
        this.options.now(),
      ));
      this.scheduleHeartbeat();
      this.options.publishExtensionStatus();
      this.options.schedulePendingExtensionUpdateCheck("native_hello_ack");
      return;
    }
    if (isRecord(message) && message.type === "version_mismatch") {
      this.clearHelloTimeout();
      this.clearHeartbeat();
      const mismatchMessage = typeof message.message === "string" ? message.message : "Version mismatch";
      this.options.appendDebugLog("error", "native.version_mismatch", { message: mismatchMessage });
      await this.options.releaseActiveTakeoverForUnavailableHost("version_mismatch");
      await this.setStatus(versionMismatchStatus(mismatchMessage, this.options.now()));
      this.port?.disconnect();
      return;
    }
    await this.options.handleNativeApplicationMessage(message, sourcePort);
  }

  private async restorePendingReconnect(storedStatus: HostStatus): Promise<boolean> {
    const restore = planRestorePendingReconnect({
      storedState: storedStatus.state,
      storedRetryDelayMs: optionalNumber(storedStatus.retryDelayMs),
      storedNextRetryAt: optionalNumber(storedStatus.nextRetryAt),
      reconnectInitialMs: this.options.reconnectInitialMs,
      reconnectMaxMs: this.options.reconnectMaxMs,
      now: this.options.now(),
    });
    if (!restore.shouldRestore) return false;
    this.reconnectDelayMs = restore.nextReconnectDelayMs;
    await this.setStatus({
      ...storedStatus,
      retryDelayMs: restore.retryDelayMs,
      nextRetryAt: restore.nextRetryAt,
      updatedAt: restore.updatedAt,
    });
    this.scheduleReconnectAt(restore.nextRetryAt);
    return true;
  }

  private scheduleHelloTimeout(targetPort: NativePort): void {
    this.clearHelloTimeout();
    this.helloTimer = this.options.scheduleTimer(() => {
      this.helloTimer = undefined;
      if (this.port !== targetPort || (this.status.state !== "connecting" && this.status.state !== "hello_pending")) return;
      this.port = null;
      try {
        targetPort.disconnect();
      } catch {
        // The port is already considered failed; cleanup is best effort.
      }
      this.options.appendDebugLog("error", "native.hello.timeout");
      void this.setStatus(helloTimeoutStatus(this.options.now()));
      this.scheduleReconnect();
    }, this.options.helloTimeoutMs);
  }

  private clearHelloTimeout(): void {
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = this.options.scheduleTimer(() => {
      this.heartbeatTimer = undefined;
      if (this.status.state !== "connected" || !this.port) return;
      void withTimeout(
        this.options.sendRequest("ping"),
        this.options.heartbeatTimeoutMs,
        "native host heartbeat timed out",
      ).then(
        () => this.scheduleHeartbeat(),
        async (error) => {
          const message = errorMessage(error);
          this.options.appendDebugLog("warn", "native.heartbeat.failed", { message });
          const failedPort = this.port;
          this.port = null;
          failedPort?.disconnect();
          this.options.rejectPending(message);
          await this.setStatus(heartbeatFailureStatus({
            message,
            diagnosis: message === "native host heartbeat timed out"
              ? "native_host_heartbeat_timeout"
              : this.options.diagnoseNativeHostFailure(message, "native_host_disconnected"),
            now: this.options.now(),
          }));
          await this.options.releaseActiveTakeoverForUnavailableHost("native_host_heartbeat_timeout");
          this.scheduleReconnect();
        },
      );
    }, this.options.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect(): void {
    const plan = planReconnect({
      stopping: this.stopping,
      state: this.status.state,
      reconnectTimerActive: this.reconnectTimer !== undefined,
      reconnectDelayMs: this.reconnectDelayMs,
      reconnectMaxMs: this.options.reconnectMaxMs,
      now: this.options.now(),
    });
    if (!plan.shouldSchedule) return;
    this.reconnectDelayMs = plan.nextReconnectDelayMs;
    this.options.appendDebugLog("info", "native.reconnect.scheduled", { delayMs: plan.delayMs });
    void this.setStatus({
      ...this.status,
      ...plan.statusPatch,
    });
    this.scheduleReconnectAt(plan.nextRetryAt);
  }

  private scheduleReconnectAt(nextRetryAt: number): void {
    if (!this.canReconnect() || this.reconnectTimer !== undefined) return;
    const delay = Math.max(0, nextRetryAt - this.options.now());
    this.reconnectTimer = this.options.scheduleTimer(() => {
      this.reconnectTimer = undefined;
      if (this.canReconnect()) void this.connect();
    }, delay);
    this.options.createReconnectAlarm(this.options.reconnectAlarmName, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.options.clearReconnectAlarm(this.options.reconnectAlarmName);
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = "timed out"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
