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
  eventFamilies?: InputBypassEventFamily[];
  sessionId?: string;
  turnId?: string;
  reason?: string;
};

type CaptureSuppressionMessage = {
  type: "OBU_CAPTURE_SUPPRESSION";
  active: boolean;
  token: string;
};

type CursorMessage =
  | CursorMoveMessage
  | CursorHideMessage
  | TakeoverStateMessage
  | CursorEventMessage
  | ContentPingMessage
  | InputBypassMessage
  | CaptureSuppressionMessage;

type Point = { x: number; y: number };
type WaterRipple = {
  xRatio: number;
  yRatio: number;
  startedAt: number;
  duration: number;
  amplitude: number;
  wavelength: number;
  speed: number;
  phase: number;
  decay: number;
  scaleX: number;
  scaleY: number;
  driftX: number;
  driftY: number;
  driftSpeed: number;
};
type InputBypassEventFamily = "pointer" | "wheel" | "touch" | "keyboard" | "text";

const SHORT_MOVE_THRESHOLD = 196;
const RESTING_ROTATION_DEG = -44;
const ARRIVAL_TIMEOUT_MS = 650;
const INPUT_BYPASS_DEFAULT_MS = 450;
const INPUT_BYPASS_MAX_MS = 1_000;
const CAPTURE_SUPPRESSION_TTL_MS = 60_000;
const CURSOR_SIZE_PX = 42;
const CURSOR_TIP_ORIGIN_PX = 4;
const CLICK_PULSE_SIZE_PX = 36;
const TAKEOVER_OVERLAY_BACKGROUND =
  "linear-gradient(118deg, rgba(14, 165, 233, 0.1), rgba(37, 99, 235, 0.14) 46%, rgba(6, 182, 212, 0.1))";
const WATER_GRID_PX = 28;
const WATER_FRAME_INTERVAL_MS = 56;
const WATER_MAX_RIPPLES = 7;
const WATER_LEVELS = [0.34, 0.52] as const;
const REDUCED_MOTION = matchMediaSafe("(prefers-reduced-motion: reduce)");
const OVERLAY_ROOT_ID = "obu-agent-overlay-root";
const INSTALL_KEY = "__OBU_CURSOR_CONTENT_SCRIPT_INSTALLED__";
const HANDLER_KEY = "__OBU_CURSOR_CONTENT_SCRIPT_HANDLE_MESSAGE__";
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
let overlay: HTMLCanvasElement | null = null;
let cursor: HTMLDivElement | null = null;
let cursorGlyph: HTMLDivElement | null = null;
let pulseLayer: HTMLDivElement | null = null;
let activeTakeover = false;
let lockInputs = false;
let lockInstalled = false;
let currentPoint: Point = initialCursorPoint();
let targetPoint: Point = { ...currentPoint };
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
let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
let waterFrame: number | undefined;
let waterCanvasWidth = 0;
let waterCanvasHeight = 0;
let waterCanvasDpr = 1;
let waterLastDraw = 0;
let waterNextRippleAt = 0;
const waterRipples: WaterRipple[] = [];
const inputBypassUntilByFamily = new Map<InputBypassEventFamily, number>();
const captureSuppressionTimers = new Map<string, ReturnType<typeof setTimeout>>();

const installState = globalThis as typeof globalThis & Record<string, unknown>;
Object.defineProperty(installState, HANDLER_KEY, {
  value: (message: unknown) => handleCursorMessage(message),
  configurable: true,
  enumerable: false,
  writable: false,
});

if (!installState[INSTALL_KEY]) {
  installState[INSTALL_KEY] = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleCursorMessage(message, sendResponse);
  });
  void chrome.runtime.sendMessage({ type: "OBU_CONTENT_READY", topFrame: TOP_FRAME }).catch(() => undefined);
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
  if (message.type === "OBU_CAPTURE_SUPPRESSION") {
    setCaptureSuppression(message);
    sendResponse?.({ ok: true, suppressed: captureSuppressionTimers.size > 0 });
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
  clearArrivalTimer();

  if (REDUCED_MOTION) {
    currentPoint = targetPoint;
    renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
    notifyArrived();
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
  clearArrivalTimer();
  animationFrame = undefined;
  activeTakeover = false;
  lockInputs = false;
  inputBypassUntilByFamily.clear();
  clearCaptureSuppressions();
  updateInputLock();
  host?.remove();
  host = null;
  overlay = null;
  cursor = null;
  cursorGlyph = null;
  pulseLayer = null;
  clearWaterOverlay();
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
  host.id = OVERLAY_ROOT_ID;
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("data-obu-overlay-root", "true");
  updateCaptureSuppression();
  const shadow = host.attachShadow({ mode: "closed" });

  overlay = document.createElement("canvas");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.opacity = "0";
  overlay.style.background = TAKEOVER_OVERLAY_BACKGROUND;
  overlay.style.mixBlendMode = "screen";
  overlay.style.boxShadow = "inset 0 0 0 1px rgba(8, 145, 178, 0.18)";
  overlay.style.transition = "opacity 160ms ease-out";
  overlay.style.pointerEvents = "none";
  overlay.style.willChange = "opacity";

  pulseLayer = document.createElement("div");
  pulseLayer.style.position = "fixed";
  pulseLayer.style.inset = "0";
  pulseLayer.style.pointerEvents = "none";

  cursor = document.createElement("div");
  cursor.style.position = "fixed";
  cursor.style.left = "0";
  cursor.style.top = "0";
  cursor.style.width = `${CURSOR_SIZE_PX}px`;
  cursor.style.height = `${CURSOR_SIZE_PX}px`;
  cursor.style.pointerEvents = "none";
  cursor.style.transformOrigin = `${CURSOR_TIP_ORIGIN_PX}px ${CURSOR_TIP_ORIGIN_PX}px`;
  cursor.style.willChange = "transform, opacity, filter";
  cursor.style.filter = "drop-shadow(0 10px 20px rgba(15, 23, 42, 0.28))";

  cursorGlyph = document.createElement("div");
  cursorGlyph.style.width = `${CURSOR_SIZE_PX}px`;
  cursorGlyph.style.height = `${CURSOR_SIZE_PX}px`;
  cursorGlyph.style.background = CURSOR_SVG_DATA_URL;
  cursorGlyph.style.backgroundSize = `${CURSOR_SIZE_PX}px ${CURSOR_SIZE_PX}px`;
  cursorGlyph.style.backgroundRepeat = "no-repeat";
  cursorGlyph.style.transformOrigin = `${CURSOR_TIP_ORIGIN_PX}px ${CURSOR_TIP_ORIGIN_PX}px`;
  cursorGlyph.style.willChange = "transform";
  cursor.append(cursorGlyph);

  shadow.append(overlay, pulseLayer, cursor);
  document.documentElement.append(host);
  updateOverlay();
  updateInputLock();
  renderCursor(currentPoint, RESTING_ROTATION_DEG, 1, 1);
}

function updateOverlay(): void {
  if (!overlay) return;
  overlay.style.opacity = activeTakeover ? "1" : "0";
  if (activeTakeover) scheduleWaterFrame();
  else clearWaterOverlay();
}

function setCaptureSuppression(message: CaptureSuppressionMessage): void {
  if (message.active) {
    clearCaptureSuppressionToken(message.token);
    const timer = setTimeout(() => {
      captureSuppressionTimers.delete(message.token);
      updateCaptureSuppression();
    }, CAPTURE_SUPPRESSION_TTL_MS);
    captureSuppressionTimers.set(message.token, timer);
  } else {
    clearCaptureSuppressionToken(message.token);
  }
  updateCaptureSuppression();
}

function updateCaptureSuppression(): void {
  if (!host) return;
  const suppressed = captureSuppressionTimers.size > 0;
  host.style.visibility = suppressed ? "hidden" : "";
  if (suppressed) {
    host.setAttribute("data-obu-capture-suppressed", "true");
  } else {
    host.removeAttribute("data-obu-capture-suppressed");
  }
}

function clearCaptureSuppressionToken(token: string): void {
  const timer = captureSuppressionTimers.get(token);
  if (timer !== undefined) clearTimeout(timer);
  captureSuppressionTimers.delete(token);
}

function clearCaptureSuppressions(): void {
  for (const timer of captureSuppressionTimers.values()) {
    clearTimeout(timer);
  }
  captureSuppressionTimers.clear();
  updateCaptureSuppression();
}

function scheduleWaterFrame(): void {
  if (waterFrame !== undefined || !overlay || !activeTakeover) return;
  if (REDUCED_MOTION) {
    drawWaterOverlay(nowMs());
    return;
  }
  waterFrame = requestFrame(drawWaterOverlay);
}

function clearWaterOverlay(): void {
  if (waterFrame !== undefined) cancelFrame(waterFrame);
  waterFrame = undefined;
  waterRipples.length = 0;
  waterNextRippleAt = 0;
  waterLastDraw = 0;
}

function drawWaterOverlay(now: number): void {
  waterFrame = undefined;
  if (!overlay || !activeTakeover) return;

  if (!REDUCED_MOTION && now - waterLastDraw < WATER_FRAME_INTERVAL_MS) {
    waterFrame = requestFrame(drawWaterOverlay);
    return;
  }

  const surface = prepareWaterCanvas();
  if (!surface) return;
  waterLastDraw = now;

  const { ctx, width, height } = surface;
  ctx.clearRect(0, 0, width, height);
  updateWaterRipples(now, width, height);
  drawWaterContours(ctx, now, width, height);

  if (!REDUCED_MOTION) {
    waterFrame = requestFrame(drawWaterOverlay);
  }
}

function prepareWaterCanvas(): { ctx: CanvasRenderingContext2D; width: number; height: number } | undefined {
  if (!overlay || typeof overlay.getContext !== "function") return undefined;
  const targetWindow = windowTarget();
  const width = Math.max(1, Math.ceil(targetWindow?.innerWidth || document.documentElement.clientWidth || 1024));
  const height = Math.max(1, Math.ceil(targetWindow?.innerHeight || document.documentElement.clientHeight || 768));
  const rawDpr = targetWindow?.devicePixelRatio;
  const dpr = clamp(typeof rawDpr === "number" && Number.isFinite(rawDpr) ? rawDpr : 1, 1, 2);

  if (waterCanvasWidth !== width || waterCanvasHeight !== height || waterCanvasDpr !== dpr) {
    waterCanvasWidth = width;
    waterCanvasHeight = height;
    waterCanvasDpr = dpr;
    overlay.width = Math.ceil(width * dpr);
    overlay.height = Math.ceil(height * dpr);
  }

  const ctx = overlay.getContext("2d");
  if (!ctx) return undefined;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function updateWaterRipples(now: number, width: number, height: number): void {
  for (let index = waterRipples.length - 1; index >= 0; index -= 1) {
    if (now - waterRipples[index].startedAt > waterRipples[index].duration) {
      waterRipples.splice(index, 1);
    }
  }

  if (waterNextRippleAt === 0) {
    for (let index = 0; index < 4; index += 1) {
      waterRipples.push(createWaterRipple(now - index * 620, width, height));
    }
    waterNextRippleAt = now + randomBetween(700, 1_200);
  }

  if (REDUCED_MOTION) return;

  while (now >= waterNextRippleAt && waterRipples.length < WATER_MAX_RIPPLES) {
    waterRipples.push(createWaterRipple(now, width, height));
    waterNextRippleAt = now + randomBetween(760, 1_400);
  }

  if (waterRipples.length >= WATER_MAX_RIPPLES && now >= waterNextRippleAt) {
    waterNextRippleAt = now + randomBetween(620, 1_050);
  }
}

function createWaterRipple(startedAt: number, width: number, height: number): WaterRipple {
  const xBounds = waterRippleXBounds(width > height);
  return {
    xRatio: randomBetween(xBounds.min, xBounds.max),
    yRatio: randomBetween(-0.08, 1.08),
    startedAt,
    duration: randomBetween(3_600, 6_800),
    amplitude: randomBetween(0.52, 0.9),
    wavelength: randomBetween(34, 74),
    speed: randomBetween(2.4, 4.3),
    phase: randomBetween(0, Math.PI * 2),
    decay: randomBetween(210, 380),
    scaleX: randomBetween(0.78, 1.22),
    scaleY: randomBetween(0.84, 1.28),
    driftX: randomBetween(-0.035, 0.035),
    driftY: randomBetween(-0.03, 0.03),
    driftSpeed: randomBetween(0.1, 0.24),
  };
}

function waterRippleXBounds(wide: boolean): { min: number; max: number } {
  if (wide) return { min: -0.05, max: 1.05 };
  return { min: -0.15, max: 1.15 };
}

function drawWaterContours(ctx: CanvasRenderingContext2D, now: number, width: number, height: number): void {
  const cols = Math.ceil(width / WATER_GRID_PX);
  const rows = Math.ceil(height / WATER_GRID_PX);
  const values = new Float32Array((cols + 1) * (rows + 1));

  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      values[row * (cols + 1) + col] = waterHeightAt(col * WATER_GRID_PX, row * WATER_GRID_PX, now, width, height);
    }
  }

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(125, 211, 252, 0.18)";
  ctx.shadowBlur = 5;

  drawWaterContourLevel(ctx, values, cols, rows, WATER_LEVELS[0], "rgba(226, 246, 255, 0.18)", 0.95);
  drawWaterContourLevel(ctx, values, cols, rows, WATER_LEVELS[1], "rgba(248, 252, 255, 0.3)", 1.15);
  ctx.restore();
}

function drawWaterContourLevel(
  ctx: CanvasRenderingContext2D,
  values: Float32Array,
  cols: number,
  rows: number,
  level: number,
  strokeStyle: string,
  lineWidth: number,
): void {
  ctx.beginPath();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const valueIndex = row * (cols + 1) + col;
      const topLeft = values[valueIndex];
      const topRight = values[valueIndex + 1];
      const bottomLeft = values[valueIndex + cols + 1];
      const bottomRight = values[valueIndex + cols + 2];
      const points = waterContourPoints(col, row, level, topLeft, topRight, bottomRight, bottomLeft);
      if (points.length === 2) {
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
      } else if (points.length === 4) {
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.moveTo(points[2].x, points[2].y);
        ctx.lineTo(points[3].x, points[3].y);
      }
    }
  }

  ctx.stroke();
}

function waterContourPoints(
  col: number,
  row: number,
  level: number,
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
): Point[] {
  const x = col * WATER_GRID_PX;
  const y = row * WATER_GRID_PX;
  const size = WATER_GRID_PX;
  const points: Point[] = [];
  pushWaterContourPoint(points, topLeft, topRight, level, (offset) => ({
    x: x + offset * size,
    y,
  }));
  pushWaterContourPoint(points, topRight, bottomRight, level, (offset) => ({
    x: x + size,
    y: y + offset * size,
  }));
  pushWaterContourPoint(points, bottomLeft, bottomRight, level, (offset) => ({
    x: x + offset * size,
    y: y + size,
  }));
  pushWaterContourPoint(points, topLeft, bottomLeft, level, (offset) => ({
    x,
    y: y + offset * size,
  }));
  return points;
}

function pushWaterContourPoint(
  points: Point[],
  start: number,
  end: number,
  level: number,
  pointAt: (offset: number) => Point,
): void {
  if (!crossesLevel(start, end, level)) return;
  points.push(pointAt(interpolateLevel(start, end, level)));
}

function crossesLevel(a: number, b: number, level: number): boolean {
  return (a >= level && b < level) || (a < level && b >= level);
}

function interpolateLevel(a: number, b: number, level: number): number {
  const delta = b - a;
  if (Math.abs(delta) < 0.0001) return 0.5;
  return clamp((level - a) / delta, 0, 1);
}

function waterHeightAt(x: number, y: number, now: number, width: number, height: number): number {
  const seconds = now * 0.001;
  let heightValue = 0;

  for (const ripple of waterRipples) {
    const progress = clamp((now - ripple.startedAt) / ripple.duration, 0, 1);
    if (progress <= 0 || progress >= 1) continue;
    const envelope = Math.sin(Math.PI * progress) ** 0.85;
    const centerX = ripple.xRatio * width + Math.sin(seconds * ripple.driftSpeed + ripple.phase) * ripple.driftX * width;
    const centerY = ripple.yRatio * height + Math.cos(seconds * ripple.driftSpeed + ripple.phase) * ripple.driftY * height;
    const dx = (x - centerX) * ripple.scaleX;
    const dy = (y - centerY) * ripple.scaleY;
    const distance = Math.hypot(dx, dy);
    const decay = Math.exp(-distance / ripple.decay);
    heightValue += Math.sin(distance / ripple.wavelength - seconds * ripple.speed + ripple.phase) *
      ripple.amplitude *
      envelope *
      decay;
  }

  heightValue += Math.sin(x * 0.008 + y * 0.005 - seconds * 0.7) * 0.08;
  heightValue += Math.sin(x * -0.004 + y * 0.01 + seconds * 0.45) * 0.06;
  return heightValue;
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
  if (isInputBypassActive(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function allowInputBypass(message: InputBypassMessage): void {
  lastSessionId = message.sessionId ?? lastSessionId;
  lastTurnId = message.turnId ?? lastTurnId;
  const durationMs = clampNumber(message.durationMs, INPUT_BYPASS_DEFAULT_MS, 1, INPUT_BYPASS_MAX_MS);
  const until = nowMs() + durationMs;
  for (const family of inputBypassFamilies(message.eventFamilies)) {
    inputBypassUntilByFamily.set(family, Math.max(inputBypassUntilByFamily.get(family) ?? 0, until));
  }
}

function isInputBypassActive(event: Event): boolean {
  const family = inputFamilyForEvent(event.type);
  if (!family) return false;
  return nowMs() <= (inputBypassUntilByFamily.get(family) ?? 0);
}

function inputBypassFamilies(value: unknown): InputBypassEventFamily[] {
  if (!Array.isArray(value)) return ["pointer", "wheel", "touch", "keyboard", "text"];
  const families = value.filter(isInputBypassEventFamily);
  return families.length > 0 ? families : ["pointer", "wheel", "touch", "keyboard", "text"];
}

function isInputBypassEventFamily(value: unknown): value is InputBypassEventFamily {
  return value === "pointer" || value === "wheel" || value === "touch" || value === "keyboard" || value === "text";
}

function inputFamilyForEvent(type: string): InputBypassEventFamily | undefined {
  if (type === "wheel") return "wheel";
  if (type.startsWith("touch")) return "touch";
  if (type.startsWith("key")) return "keyboard";
  if (type === "beforeinput") return "text";
  if (
    type.startsWith("pointer") ||
    type.startsWith("mouse") ||
    type === "click" ||
    type === "dblclick" ||
    type === "contextmenu"
  ) {
    return "pointer";
  }
  return undefined;
}

function renderCursor(point: Point, rotation: number, scaleX: number, scaleY: number): void {
  if (!cursor || !cursorGlyph) return;
  cursor.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
  cursorGlyph.style.transform = `rotate(${rotation.toFixed(2)}deg) scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`;
}

function initialCursorPoint(): Point {
  const targetWindow = windowTarget();
  const viewport = targetWindow?.visualViewport;
  const width = typeof viewport?.width === "number" && Number.isFinite(viewport.width)
    ? viewport.width
    : targetWindow?.innerWidth || document.documentElement.clientWidth || 1024;
  const height = typeof viewport?.height === "number" && Number.isFinite(viewport.height)
    ? viewport.height
    : targetWindow?.innerHeight || document.documentElement.clientHeight || 768;
  return {
    x: Math.round(width * 0.5),
    y: Math.round(height * 0.5),
  };
}

function addPulse(point: Point): void {
  if (!pulseLayer) return;
  const pulse = document.createElement("div");
  const pulseOffset = CLICK_PULSE_SIZE_PX / 2;
  pulse.style.position = "fixed";
  pulse.style.left = `${Math.round(point.x - pulseOffset)}px`;
  pulse.style.top = `${Math.round(point.y - pulseOffset)}px`;
  pulse.style.width = `${CLICK_PULSE_SIZE_PX}px`;
  pulse.style.height = `${CLICK_PULSE_SIZE_PX}px`;
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

const CURSOR_SVG_DATA_URL = (() => {
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
})();

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
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
    isInputBypass(value) ||
    isCaptureSuppression(value)
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

function isCaptureSuppression(value: unknown): value is CaptureSuppressionMessage {
  const token = isRecord(value) ? value.token : undefined;
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "OBU_CAPTURE_SUPPRESSION" &&
    typeof (value as { active?: unknown }).active === "boolean" &&
    typeof token === "string" &&
    token.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
})();
