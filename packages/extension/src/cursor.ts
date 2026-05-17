(() => {
type CursorMoveMessage = {
  type: "OBU_CURSOR_MOVE";
  x: number;
  y: number;
  sequence?: number;
  sessionId?: string;
  turnId?: string;
};

type CursorHideMessage = {
  type: "OBU_CURSOR_HIDE";
};

type TakeoverStateMessage = {
  type: "OBU_TAKEOVER_STATE";
  active: boolean;
  lockInputs?: boolean;
  sessionId?: string;
  turnId?: string;
  reason?: string;
};

type CursorEventMessage = {
  type: "OBU_CURSOR_EVENT";
  kind: "press" | "release" | "click";
  x?: number;
  y?: number;
  button?: string;
  sequence?: number;
  sessionId?: string;
  turnId?: string;
};

type ContentPingMessage = {
  type: "OBU_CONTENT_PING";
};

type InputBypassMessage = {
  type: "OBU_INPUT_BYPASS";
  durationMs?: number;
  sessionId?: string;
  turnId?: string;
  reason?: string;
};

type CursorMessage =
  | CursorMoveMessage
  | CursorHideMessage
  | TakeoverStateMessage
  | CursorEventMessage
  | ContentPingMessage
  | InputBypassMessage;

type Point = { x: number; y: number };

const SHORT_MOVE_THRESHOLD = 196;
const RESTING_ROTATION_DEG = -44;
const ARRIVAL_TIMEOUT_MS = 650;
const INPUT_BYPASS_DEFAULT_MS = 450;
const INPUT_BYPASS_MAX_MS = 1_000;
const TAKEOVER_OVERLAY_BLUR = "blur(1.35px) saturate(1.06)";
const TAKEOVER_OVERLAY_BACKGROUND = [
  "radial-gradient(circle at 18% 24%, rgba(125, 211, 252, 0.34) 0 1px, transparent 1.9px)",
  "radial-gradient(circle at 76% 18%, rgba(191, 219, 254, 0.24) 0 1.15px, transparent 2.3px)",
  "radial-gradient(circle at 34% 78%, rgba(56, 189, 248, 0.22) 0 1px, transparent 2px)",
  "radial-gradient(circle at 84% 70%, rgba(147, 197, 253, 0.2) 0 1.35px, transparent 2.4px)",
  "linear-gradient(118deg, rgba(14, 165, 233, 0.1), rgba(37, 99, 235, 0.16) 46%, rgba(6, 182, 212, 0.1))",
].join(", ");
const TAKEOVER_OVERLAY_BACKGROUND_SIZE = "170px 170px, 230px 230px, 290px 290px, 360px 360px, 100% 100%";
const TAKEOVER_OVERLAY_BACKGROUND_POSITION = "0 0, 44px 28px, 16px 78px, 92px 18px, 0 0";
const REDUCED_MOTION = matchMediaSafe("(prefers-reduced-motion: reduce)");
const INSTALL_KEY = "__OBU_CURSOR_CONTENT_SCRIPT_INSTALLED__";
const SCRIPT_EVENT = "__OBU_CURSOR_MESSAGE__";
const TOP_FRAME = isTopFrame();
const LOCK_EVENTS = [
  "pointerdown",
  "pointerup",
  "pointermove",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "wheel",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "keydown",
  "keyup",
  "beforeinput",
] as const;

let host: HTMLDivElement | null = null;
let overlay: HTMLDivElement | null = null;
let cursor: HTMLDivElement | null = null;
let cursorGlyph: HTMLDivElement | null = null;
let pulseLayer: HTMLDivElement | null = null;
let activeTakeover = false;
let lockInputs = false;
let lockInstalled = false;
let currentPoint: Point = { x: 24, y: 24 };
let targetPoint: Point = { x: 24, y: 24 };
let lastSessionId: string | undefined;
let lastTurnId: string | undefined;
let animationFrame: number | undefined;
let animationStartedAt = 0;
let animationDuration = 0;
let animationSequence: number | undefined;
let animationSessionId: string | undefined;
let animationTurnId: string | undefined;
let animationFrom: Point = { x: 24, y: 24 };
let animationTo: Point = { x: 24, y: 24 };
let animationControl: Point | undefined;
let thinkingFrame: number | undefined;
let thinkingStartedAt = 0;
let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
let inputBypassUntil = 0;

const installState = globalThis as typeof globalThis & Record<string, unknown>;
if (!installState[INSTALL_KEY]) {
  installState[INSTALL_KEY] = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleCursorMessage(message, sendResponse);
  });
  windowTarget()?.addEventListener(SCRIPT_EVENT, (event) => {
    handleCursorMessage((event as CustomEvent).detail);
  });
}

function handleCursorMessage(message: unknown, sendResponse?: (response?: unknown) => void): void {
  if (!isCursorMessage(message)) return;
  if (message.type === "OBU_CONTENT_PING") {
    sendResponse?.({ ok: true });
    return;
  }
  if (message.type === "OBU_INPUT_BYPASS") {
    allowInputBypass(message);
    sendResponse?.({ ok: true });
    return;
  }
  if (message.type === "OBU_CURSOR_HIDE") {
    hideCursor();
    sendResponse?.({ ok: true });
    return;
  }
  if (message.type === "OBU_TAKEOVER_STATE") {
    setTakeoverState(message);
    sendResponse?.({ ok: true, active: activeTakeover, lockInputs });
    return;
  }
  if (message.type === "OBU_CURSOR_EVENT") {
    handleCursorEvent(message);
    sendResponse?.({ ok: true, kind: message.kind, sequence: message.sequence });
    return;
  }
  moveCursor(message);
  sendResponse?.({ ok: true, sequence: message.sequence });
}

function setTakeoverState(message: TakeoverStateMessage): void {
  activeTakeover = message.active;
  lockInputs = message.active && message.lockInputs !== false;
  lastSessionId = message.sessionId ?? lastSessionId;
  lastTurnId = message.turnId ?? lastTurnId;
  if (!message.active) {
    hideCursor();
    return;
  }
  if (TOP_FRAME) {
    ensureCursor();
    updateOverlay();
  }
  updateInputLock();
}

function moveCursor(message: CursorMoveMessage): void {
  lastSessionId = message.sessionId ?? lastSessionId;
  lastTurnId = message.turnId ?? lastTurnId;
  if (!TOP_FRAME) return;
  ensureCursor();
  targetPoint = { x: message.x, y: message.y };
  animationSequence = message.sequence;
  animationSessionId = message.sessionId ?? lastSessionId;
  animationTurnId = message.turnId ?? lastTurnId;
  stopThinking();
  clearArrivalTimer();

  if (REDUCED_MOTION) {
    currentPoint = targetPoint;
    renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
    notifyArrived();
    startThinking();
    return;
  }

  const distance = dist(currentPoint, targetPoint);
  animationFrom = { ...currentPoint };
  animationTo = { ...targetPoint };
  animationControl = distance > SHORT_MOVE_THRESHOLD ? bezierControl(animationFrom, animationTo) : undefined;
  animationDuration = clamp(distance * (animationControl ? 1.0 : 0.65), 135, animationControl ? 520 : 280);
  animationStartedAt = nowMs();
  if (animationFrame !== undefined) cancelFrame(animationFrame);
  animationFrame = requestFrame(tickMove);
  arrivalTimer = setTimeout(() => {
    currentPoint = { ...targetPoint };
    renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
    notifyArrived();
    startThinking();
  }, ARRIVAL_TIMEOUT_MS);
}

function tickMove(now: number): void {
  const raw = animationDuration <= 0 ? 1 : (now - animationStartedAt) / animationDuration;
  const t = clamp(raw, 0, 1);
  const eased = easeOutQuint(t);
  const point = animationControl
    ? sampleQuadratic(animationFrom, animationControl, animationTo, eased)
    : sampleScoot(animationFrom, animationTo, eased);
  const tangent = animationControl
    ? quadraticTangent(animationFrom, animationControl, animationTo, eased)
    : { x: animationTo.x - animationFrom.x, y: animationTo.y - animationFrom.y };
  const speedStretch = 1 + Math.sin(Math.PI * t) * (animationControl ? 0.10 : 0.18);
  const directionTilt = clamp(tangent.x * 0.04 - tangent.y * 0.025, -18, 18);
  const scootTilt = animationControl ? 0 : Math.sin(Math.PI * t) * directionTilt;
  currentPoint = point;
  renderCursor(point, RESTING_ROTATION_DEG + scootTilt, speedStretch, 1 - Math.sin(Math.PI * t) * 0.04);
  if (t < 1) {
    animationFrame = requestFrame(tickMove);
    return;
  }
  animationFrame = undefined;
  currentPoint = { ...animationTo };
  renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
  clearArrivalTimer();
  notifyArrived();
  startThinking();
}

function handleCursorEvent(message: CursorEventMessage): void {
  lastSessionId = message.sessionId ?? lastSessionId;
  lastTurnId = message.turnId ?? lastTurnId;
  if (!TOP_FRAME) return;
  ensureCursor();
  if (typeof message.x === "number" && typeof message.y === "number") {
    currentPoint = { x: message.x, y: message.y };
    targetPoint = currentPoint;
  }
  if (message.kind === "press") {
    renderCursor(currentPoint, RESTING_ROTATION_DEG, 0.92, 0.92);
    return;
  }
  renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
  if (message.kind === "click") {
    addPulse(currentPoint);
  }
}

function hideCursor(): void {
  if (animationFrame !== undefined) cancelFrame(animationFrame);
  if (thinkingFrame !== undefined) cancelFrame(thinkingFrame);
  clearArrivalTimer();
  animationFrame = undefined;
  thinkingFrame = undefined;
  activeTakeover = false;
  lockInputs = false;
  inputBypassUntil = 0;
  updateInputLock();
  host?.remove();
  host = null;
  overlay = null;
  cursor = null;
  cursorGlyph = null;
  pulseLayer = null;
}

function ensureCursor(): void {
  if (host && overlay && cursor && cursorGlyph && pulseLayer) {
    updateOverlay();
    updateInputLock();
    return;
  }
  host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "none";
  host.style.contain = "layout style paint";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = takeoverStyleSheet();

  overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.opacity = "0";
  overlay.style.background = TAKEOVER_OVERLAY_BACKGROUND;
  overlay.style.backgroundSize = TAKEOVER_OVERLAY_BACKGROUND_SIZE;
  overlay.style.backgroundPosition = TAKEOVER_OVERLAY_BACKGROUND_POSITION;
  overlay.style.backgroundBlendMode = "screen, screen, screen, screen, normal";
  overlay.style.backdropFilter = TAKEOVER_OVERLAY_BLUR;
  (overlay.style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter = TAKEOVER_OVERLAY_BLUR;
  overlay.style.boxShadow = "inset 0 0 0 1px rgba(125, 211, 252, 0.16), inset 0 0 48px rgba(37, 99, 235, 0.18)";
  overlay.style.transition = "opacity 160ms ease-out";
  overlay.style.pointerEvents = "none";
  overlay.style.willChange = REDUCED_MOTION ? "opacity" : "opacity, background-position";
  overlay.style.animation = REDUCED_MOTION ? "none" : "obu-takeover-particles 14s linear infinite";

  pulseLayer = document.createElement("div");
  pulseLayer.style.position = "fixed";
  pulseLayer.style.inset = "0";
  pulseLayer.style.pointerEvents = "none";

  cursor = document.createElement("div");
  cursor.style.position = "fixed";
  cursor.style.left = "0";
  cursor.style.top = "0";
  cursor.style.width = "32px";
  cursor.style.height = "32px";
  cursor.style.pointerEvents = "none";
  cursor.style.transformOrigin = "3px 3px";
  cursor.style.willChange = "transform, opacity, filter";
  cursor.style.filter = "drop-shadow(0 8px 16px rgba(15, 23, 42, 0.24))";

  cursorGlyph = document.createElement("div");
  cursorGlyph.style.width = "32px";
  cursorGlyph.style.height = "32px";
  cursorGlyph.style.background = cursorSvgDataUrl();
  cursorGlyph.style.backgroundSize = "32px 32px";
  cursorGlyph.style.backgroundRepeat = "no-repeat";
  cursorGlyph.style.transformOrigin = "4px 4px";
  cursorGlyph.style.willChange = "transform";
  cursor.append(cursorGlyph);

  shadow.append(style, overlay, pulseLayer, cursor);
  document.documentElement.append(host);
  updateOverlay();
  updateInputLock();
  renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
}

function takeoverStyleSheet(): string {
  return `
    @keyframes obu-takeover-particles {
      from {
        background-position: ${TAKEOVER_OVERLAY_BACKGROUND_POSITION};
      }
      to {
        background-position: 170px 70px, -90px 118px, 116px -96px, -128px -82px, 0 0;
      }
    }
  `;
}

function updateOverlay(): void {
  if (!overlay) return;
  overlay.style.opacity = activeTakeover ? "1" : "0";
}

function updateInputLock(): void {
  const targetWindow = windowTarget();
  if (lockInputs && !lockInstalled) {
    for (const eventName of LOCK_EVENTS) {
      targetWindow?.addEventListener(eventName, blockHumanInput, { capture: true, passive: false });
      document.addEventListener(eventName, blockHumanInput, { capture: true, passive: false });
    }
    lockInstalled = true;
    return;
  }
  if (!lockInputs && lockInstalled) {
    for (const eventName of LOCK_EVENTS) {
      targetWindow?.removeEventListener(eventName, blockHumanInput, { capture: true });
      document.removeEventListener(eventName, blockHumanInput, { capture: true });
    }
    lockInstalled = false;
  }
}

function blockHumanInput(event: Event): void {
  if (!lockInputs) return;
  if (isInputBypassActive()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function allowInputBypass(message: InputBypassMessage): void {
  lastSessionId = message.sessionId ?? lastSessionId;
  lastTurnId = message.turnId ?? lastTurnId;
  const durationMs = clampNumber(message.durationMs, INPUT_BYPASS_DEFAULT_MS, 1, INPUT_BYPASS_MAX_MS);
  inputBypassUntil = Math.max(inputBypassUntil, nowMs() + durationMs);
}

function isInputBypassActive(): boolean {
  return nowMs() <= inputBypassUntil;
}

function renderCursor(point: Point, rotation: number, scaleX: number, scaleY: number): void {
  if (!cursor || !cursorGlyph) return;
  cursor.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
  cursorGlyph.style.transform = `rotate(${rotation.toFixed(2)}deg) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
}

function addPulse(point: Point): void {
  if (!pulseLayer) return;
  const pulse = document.createElement("div");
  pulse.style.position = "fixed";
  pulse.style.left = `${Math.round(point.x - 14)}px`;
  pulse.style.top = `${Math.round(point.y - 14)}px`;
  pulse.style.width = "28px";
  pulse.style.height = "28px";
  pulse.style.borderRadius = "999px";
  pulse.style.border = "2px solid rgba(56, 189, 248, 0.92)";
  pulse.style.background = "rgba(37, 99, 235, 0.16)";
  pulse.style.boxShadow = "0 0 0 1px rgba(255, 255, 255, 0.8)";
  pulse.style.pointerEvents = "none";
  pulse.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 280ms ease-out";
  pulse.style.transform = "scale(0.4)";
  pulseLayer.append(pulse);
  requestFrame(() => {
    pulse.style.transform = "scale(1.85)";
    pulse.style.opacity = "0";
  });
  setTimeout(() => pulse.remove(), 340);
}

function startThinking(): void {
  stopThinking();
  thinkingStartedAt = nowMs();
  thinkingFrame = requestFrame(tickThinking);
}

function stopThinking(): void {
  if (thinkingFrame !== undefined) cancelFrame(thinkingFrame);
  thinkingFrame = undefined;
}

function tickThinking(now: number): void {
  const t = (now - thinkingStartedAt) / 1000;
  if (t > 1.41) {
    thinkingFrame = undefined;
    renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
    return;
  }
  const envelope = Math.sin((t / 1.41) * Math.PI);
  const carrier = Math.sin((t / 0.66) * Math.PI * 2);
  renderCursor(currentPoint, RESTING_ROTATION_DEG + 8.5 * envelope * carrier, 1, 1);
  thinkingFrame = requestFrame(tickThinking);
}

function notifyArrived(): void {
  void chrome.runtime.sendMessage({
    type: "OBU_CURSOR_ARRIVED",
    sequence: animationSequence,
    sessionId: animationSessionId,
    turnId: animationTurnId,
  }).catch(() => undefined);
}

function clearArrivalTimer(): void {
  if (arrivalTimer !== undefined) clearTimeout(arrivalTimer);
  arrivalTimer = undefined;
}

function sampleScoot(start: Point, end: Point, t: number): Point {
  const base = { x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t) };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const wobble = Math.sin(Math.PI * t) * clamp(distance * 0.035, 3, 9);
  return {
    x: base.x + (-dy / distance) * wobble,
    y: base.y + (dx / distance) * wobble,
  };
}

function bezierControl(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const sign = dx * 0.7 - dy * 0.35 >= 0 ? 1 : -1;
  const offset = clamp(distance * 0.22, 50, 220) * sign;
  const targetWindow = windowTarget();
  const width = targetWindow?.innerWidth || document.documentElement.clientWidth || 1024;
  const height = targetWindow?.innerHeight || document.documentElement.clientHeight || 768;
  return {
    x: clamp(midpoint.x + (-dy / distance) * offset, 20, Math.max(20, width - 20)),
    y: clamp(midpoint.y + (dx / distance) * offset, 20, Math.max(20, height - 20)),
  };
}

function sampleQuadratic(start: Point, control: Point, end: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
    y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
  };
}

function quadraticTangent(start: Point, control: Point, end: Point, t: number): Point {
  return {
    x: 2 * (1 - t) * (control.x - start.x) + 2 * t * (end.x - control.x),
    y: 2 * (1 - t) * (control.y - start.y) + 2 * t * (end.y - control.y),
  };
}

function cursorSvgDataUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <g fill="#ffc400" stroke="#f2a900" stroke-width=".6" stroke-linejoin="round">
      <path d="M8.7 7.1 10.4 1.4c.2-.8 1.3-.8 1.6 0l2 5.6 3.1-2.1c.7-.5 1.5.3 1.1 1l-2.1 4.7a10.3 10.3 0 0 0-6.7-.1L6.5 6.3c-.4-.7.4-1.5 1.1-1l1.1 1.8Z"/>
      <path d="M1.7 6.8c.3-.5.9-.7 1.4-.4l5.3 3.1c.5.3.6.9.3 1.4-.3.5-.9.7-1.4.4L2 8.2c-.5-.3-.6-.9-.3-1.4Z"/>
      <path d="M.9 12.5c.1-.6.6-1 1.2-.9l5.8.7c.6.1 1 .6.9 1.2-.1.6-.6 1-1.2.9l-5.8-.7c-.6-.1-1-.6-.9-1.2Z"/>
      <path d="M20.7 3.1c.5.3.7.9.4 1.4l-3.1 5c-.3.5-.9.7-1.4.4-.5-.3-.7-.9-.4-1.4l3.1-5c.3-.5.9-.7 1.4-.4Z"/>
    </g>
    <path d="M6.5 8.1c-.2-1.4 1.3-2.5 2.6-1.8l21.2 11.3c1.5.8 1.3 3-.3 3.5l-6.7 2 4.6 4.7c.8.9.8 2.2-.1 3l-2.6 2.4c-.9.8-2.3.7-3-.2l-4.6-5.8-3.5 5.2c-1 1.5-3.3 1-3.6-.8L6.5 8.1Z" fill="#0b1118"/>
    <path d="M9 9.6 27.8 19.7l-8.7 2.6 6.3 6.5-1.5 1.4-6.6-8.3-4.8 7.3L9 9.6Z" fill="#f8fbff"/>
    <path d="M9.6 10.8 12.3 27 17.1 20l6.2 7.8" fill="none" stroke="#dfe7ef" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round" opacity=".72"/>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

function matchMediaSafe(query: string): boolean {
  try {
    const targetWindow = windowTarget();
    return Boolean(targetWindow && typeof targetWindow.matchMedia === "function" && targetWindow.matchMedia(query).matches);
  } catch {
    return false;
  }
}

function isTopFrame(): boolean {
  const targetWindow = windowTarget();
  if (!targetWindow) return true;
  try {
    return targetWindow.top === undefined || targetWindow.top === targetWindow;
  } catch {
    return true;
  }
}

function requestFrame(callback: (now: number) => void): number {
  const maybeWindow = windowTarget();
  if (typeof maybeWindow?.requestAnimationFrame === "function") {
    return maybeWindow.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(nowMs()), 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  const maybeWindow = windowTarget();
  if (typeof maybeWindow?.cancelAnimationFrame === "function") {
    maybeWindow.cancelAnimationFrame(handle);
    return;
  }
  globalThis.clearTimeout(handle);
}

function nowMs(): number {
  const maybePerformance = globalThis.performance as { now?: () => number } | undefined;
  return typeof maybePerformance?.now === "function" ? maybePerformance.now() : Date.now();
}

function windowTarget(): Window | undefined {
  const maybeWindow = globalThis as unknown as Partial<Window>;
  return typeof maybeWindow.addEventListener === "function" ? (maybeWindow as Window) : undefined;
}

function isCursorMessage(value: unknown): value is CursorMessage {
  return (
    isCursorMove(value) ||
    isCursorHide(value) ||
    isTakeoverState(value) ||
    isCursorEvent(value) ||
    isContentPing(value) ||
    isInputBypass(value)
  );
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

function isTakeoverState(value: unknown): value is TakeoverStateMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "OBU_TAKEOVER_STATE" &&
    typeof (value as { active?: unknown }).active === "boolean"
  );
}

function isCursorEvent(value: unknown): value is CursorEventMessage {
  if (value === null || typeof value !== "object") return false;
  if ((value as { type?: unknown }).type !== "OBU_CURSOR_EVENT") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "press" || kind === "release" || kind === "click";
}

function isContentPing(value: unknown): value is ContentPingMessage {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === "OBU_CONTENT_PING";
}

function isInputBypass(value: unknown): value is InputBypassMessage {
  return value !== null && typeof value === "object" && (value as { type?: unknown }).type === "OBU_INPUT_BYPASS";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
})();
