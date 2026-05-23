export type DownloadTerminalStatus = "complete" | "failed";

export type DownloadOwnerLike = {
  suggestedFilename?: string;
};

export function downloadStatusFromChromeState(state: unknown): DownloadTerminalStatus | undefined {
  if (state === "complete") return "complete";
  if (state === "interrupted") return "failed";
  return undefined;
}

export function matchingDownloadOwnerIndex(queue: DownloadOwnerLike[], item: { filename?: string }): number {
  if (typeof item.filename !== "string") return -1;
  const filename = downloadBasename(item.filename);
  return queue.findIndex((owner) => {
    if (typeof owner.suggestedFilename !== "string") return false;
    return downloadBasename(owner.suggestedFilename) === filename;
  });
}

export function downloadBasename(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}
