import {
  downloadStatusFromChromeState,
  matchingDownloadOwnerIndex,
} from "./lifecycle/download_lifecycle_machine.js";

type DebugLogLevel = "debug" | "info" | "warn" | "error";

export type HistoryItemDto = {
  id?: string;
  url: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
  typedCount?: number;
};

export type DownloadOwner = {
  sessionId: string;
  tabId?: number;
  suggestedFilename?: string;
};

type BrowserDownloadControllerOptions = {
  historySearch(query: {
    text: string;
    maxResults?: number;
    startTime?: number;
    endTime?: number;
  }): Promise<ChromeHistoryItem[]>;
  downloadSearch(query: { id?: number }): Promise<ChromeDownloadItem[]>;
  sendNotification(method: string, params?: unknown): void;
  appendDebugLog(level: DebugLogLevel, event: string, data?: unknown): void;
};

export class BrowserDownloadController {
  private readonly ownersByUrl = new Map<string, DownloadOwner[]>();
  private readonly ownersById = new Map<number, DownloadOwner>();

  constructor(private readonly options: BrowserDownloadControllerOptions) {}

  async getUserHistory(params: unknown): Promise<HistoryItemDto[]> {
    const query = isRecord(params) && typeof params.query === "string" ? params.query : "";
    const maxResults = clampNumber(isRecord(params) ? params.limit : undefined, 50, 1, 500);
    const startTime = optionalNumber(isRecord(params) ? params.from : undefined);
    const endTime = optionalNumber(isRecord(params) ? params.to : undefined);
    const rows = await this.options.historySearch({ text: query, maxResults, startTime, endTime });
    return rows
      .filter((row) => typeof row.url === "string" && row.url.length > 0)
      .map((row) => ({
        id: row.id,
        url: row.url!,
        title: row.title,
        lastVisitTime: row.lastVisitTime,
        visitCount: row.visitCount,
        typedCount: row.typedCount,
      }));
  }

  handleCdpEvent(sessionId: string, tabId: number, method: string, params: unknown): void {
    if (method !== "Page.downloadWillBegin" || !isRecord(params) || typeof params.url !== "string") return;
    this.enqueueDownloadOwner(params.url, {
      sessionId,
      tabId,
      suggestedFilename: typeof params.suggestedFilename === "string" ? params.suggestedFilename : undefined,
    });
  }

  handleDownloadCreated(item: ChromeDownloadItem): void {
    const owner = this.takeDownloadOwner(item);
    if (!owner) return;
    this.options.appendDebugLog("debug", "download.created", { id: item.id, tabId: owner.tabId });
    this.ownersById.set(item.id, owner);
    this.options.sendNotification("onDownloadChange", {
      session_id: owner.sessionId,
      source: owner.tabId === undefined ? undefined : { tabId: owner.tabId },
      id: String(item.id),
      status: "started",
      filename: item.filename,
      url: item.url,
    });
  }

  async handleDownloadChanged(delta: ChromeDownloadDelta): Promise<void> {
    const owner = this.ownersById.get(delta.id);
    if (!owner) return;
    const item = await this.options.downloadSearch({ id: delta.id }).then((rows) => rows[0]).catch(() => undefined);
    const status = downloadStatusFromChromeState(item?.state ?? delta.state?.current);
    if (!status) return;
    this.options.appendDebugLog(status === "failed" ? "warn" : "debug", "download.changed", {
      id: delta.id,
      status,
      tabId: owner.tabId,
    });
    this.options.sendNotification("onDownloadChange", {
      session_id: owner.sessionId,
      source: owner.tabId === undefined ? undefined : { tabId: owner.tabId },
      id: String(delta.id),
      status,
      filename: item?.filename ?? delta.filename?.current,
      url: item?.url ?? delta.url?.current,
      error: item?.error ?? delta.error?.current,
    });
    if (status === "complete" || status === "failed") {
      this.ownersById.delete(delta.id);
    }
  }

  removeDownloadOwnersForTab(tabId: number): void {
    for (const [url, owners] of this.ownersByUrl) {
      const remaining = owners.filter((owner) => owner.tabId !== tabId);
      if (remaining.length === 0) {
        this.ownersByUrl.delete(url);
      } else if (remaining.length !== owners.length) {
        this.ownersByUrl.set(url, remaining);
      }
    }
    for (const [id, owner] of this.ownersById) {
      if (owner.tabId === tabId) this.ownersById.delete(id);
    }
  }

  pendingOwnerCounts(): { byUrl: number; byId: number } {
    return { byUrl: this.ownersByUrl.size, byId: this.ownersById.size };
  }

  private enqueueDownloadOwner(url: string, owner: DownloadOwner): void {
    const queue = this.ownersByUrl.get(url) ?? [];
    queue.push(owner);
    this.ownersByUrl.set(url, queue);
  }

  private takeDownloadOwner(item: ChromeDownloadItem): DownloadOwner | undefined {
    const url = item.url;
    if (typeof url !== "string") return undefined;
    const queue = this.ownersByUrl.get(url);
    if (!queue || queue.length === 0) return undefined;
    const matchingFilenameIndex = matchingDownloadOwnerIndex(queue, item);
    const [owner] = queue.splice(matchingFilenameIndex >= 0 ? matchingFilenameIndex : 0, 1);
    if (queue.length === 0) {
      this.ownersByUrl.delete(url);
    } else {
      this.ownersByUrl.set(url, queue);
    }
    return owner;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
