type CursorMoveMessage = {
  type: "OBU_CURSOR_MOVE";
  x: number;
  y: number;
  sequence?: number;
};

type CursorHideMessage = {
  type: "OBU_CURSOR_HIDE";
};

type CursorMessage = CursorMoveMessage | CursorHideMessage;

let host: HTMLDivElement | null = null;
let dot: HTMLDivElement | null = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isCursorMessage(message)) return;
  if (message.type === "OBU_CURSOR_HIDE") {
    hideCursor();
    sendResponse({ ok: true });
    return;
  }
  moveCursor(message);
  sendResponse({ ok: true, sequence: message.sequence });
});

function moveCursor(message: CursorMoveMessage): void {
  ensureCursor();
  if (!host || !dot) return;
  host.style.transform = `translate(${Math.round(message.x)}px, ${Math.round(message.y)}px)`;
  dot.dataset.sequence = String(message.sequence ?? "");
}

function hideCursor(): void {
  host?.remove();
  host = null;
  dot = null;
}

function ensureCursor(): void {
  if (host && dot) return;
  host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.width = "0";
  host.style.height = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  host.style.transition = "transform 120ms linear";
  const shadow = host.attachShadow({ mode: "closed" });
  dot = document.createElement("div");
  dot.style.width = "24px";
  dot.style.height = "24px";
  dot.style.marginLeft = "-2px";
  dot.style.marginTop = "-2px";
  dot.style.border = "2px solid #0f172a";
  dot.style.borderRadius = "999px";
  dot.style.background = "rgba(56, 189, 248, 0.72)";
  dot.style.boxShadow = "0 0 0 2px rgba(255, 255, 255, 0.85), 0 6px 16px rgba(15, 23, 42, 0.25)";
  shadow.append(dot);
  document.documentElement.append(host);
}

function isCursorMessage(value: unknown): value is CursorMessage {
  if (isCursorHide(value)) return true;
  return isCursorMove(value);
}

function isCursorMove(value: unknown): value is CursorMoveMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "OBU_CURSOR_MOVE" &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number"
  );
}

function isCursorHide(value: unknown): value is CursorHideMessage {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === "OBU_CURSOR_HIDE";
}

export {};
