import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const builtCursor = await readFile(path.join(packageRoot, "dist", "cursor.js"), "utf8");
assert.doesNotMatch(builtCursor, /\bexport\s*\{\s*\}/);
assert.match(builtCursor, /(?:^|\n)\(\(\) => \{/);
assert.doesNotMatch(builtCursor, /__OBU_CURSOR_MESSAGE__/);

class EventTarget {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  addEventListener(type, listener) {
    this.listeners.push({ type, listener });
  }

  removeEventListener(type, listener) {
    this.listeners = this.listeners.filter((row) => row.type !== type || row.listener !== listener);
  }

  emit(message) {
    const responses = [];
    for (const listener of this.listeners) {
      if (typeof listener === "function") listener(message, {}, (response) => responses.push(response));
    }
    return responses;
  }

  emitDom(type, event) {
    if (event && typeof event === "object" && event.type === undefined) event.type = type;
    for (const row of this.listeners) {
      if (row.type === type) row.listener(event);
    }
  }
}

class FakeElement {
  style = {};
  dataset = {};
  attributes = new Map();
  children = [];
  parent = null;
  shadowChildren = [];
  id = "";

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  attachShadow() {
    return {
      append: (...children) => {
        for (const child of children) {
          child.parent = this;
          this.shadowChildren.push(child);
        }
      },
    };
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

const runtimeMessages = new EventTarget();
const documentEvents = new EventTarget();
const windowEvents = new EventTarget();
const documentElement = new FakeElement();
const sentRuntimeMessages = [];
let timerId = 1;
const timers = new Map();

globalThis.document = {
  documentElement,
  createElement() {
    return new FakeElement();
  },
  addEventListener: (...args) => documentEvents.addEventListener(...args),
  removeEventListener: (...args) => documentEvents.removeEventListener(...args),
};
globalThis.addEventListener = (...args) => windowEvents.addEventListener(...args);
globalThis.removeEventListener = (...args) => windowEvents.removeEventListener(...args);
globalThis.innerWidth = 1024;
globalThis.innerHeight = 768;
globalThis.matchMedia = () => ({ matches: true });
globalThis.requestAnimationFrame = (callback) => {
  const id = timerId++;
  const timer = setTimeout(() => {
    timers.delete(id);
    callback(Date.now());
  }, 1);
  timers.set(id, timer);
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
};
globalThis.chrome = {
  runtime: {
    onMessage: runtimeMessages,
    async sendMessage(message) {
      sentRuntimeMessages.push(message);
      return { ok: true };
    },
  },
};

await import(`${pathToFileURL(path.join(packageRoot, "dist", "cursor.js")).href}?test=${Date.now()}`);

await waitFor(() => sentRuntimeMessages.some((message) => message.type === "OBU_CONTENT_READY" && message.topFrame === true));
assert.equal(runtimeMessages.emit({ type: "IGNORED" }).length, 0);
assert.deepEqual(runtimeMessages.emit({ type: "OBU_CONTENT_PING" }), [{ ok: true }]);

let responses = runtimeMessages.emit({
  type: "OBU_TAKEOVER_STATE",
  active: true,
  lockInputs: true,
  sessionId: "session",
  turnId: "turn",
});
assert.deepEqual(responses, [{ ok: true, active: true, lockInputs: true }]);
assert.equal(documentElement.children.length, 1);
let host = documentElement.children[0];
assert.equal(host.id, "obu-agent-overlay-root");
assert.equal(host.getAttribute("aria-hidden"), "true");
assert.equal(host.getAttribute("data-obu-overlay-root"), "true");
assert.equal(host.style.position, "fixed");
assert.equal(host.shadowChildren.length, 4);
assert.equal(host.shadowChildren[0].textContent, "");
const overlay = host.shadowChildren[1];
assert.equal(overlay.style.opacity, "1");
assert.match(overlay.style.background, /linear-gradient/);
assert.doesNotMatch(overlay.style.background, /conic-gradient/);
assert.doesNotMatch(overlay.style.background, /polygon/);
assert.equal(overlay.style.mixBlendMode, "screen");
assert.equal(overlay.style.backdropFilter, undefined);
assert.equal(overlay.style.webkitBackdropFilter, undefined);
assert.equal(overlay.style.pointerEvents, "none");
assert.equal(overlay.style.imageRendering, undefined);
assert.equal(overlay.style.animation, undefined);

responses = runtimeMessages.emit({ type: "OBU_CAPTURE_SUPPRESSION", active: true, token: "shot-1" });
assert.deepEqual(responses, [{ ok: true, suppressed: true }]);
assert.equal(host.style.visibility, "hidden");
assert.equal(host.getAttribute("data-obu-capture-suppressed"), "true");
responses = runtimeMessages.emit({ type: "OBU_CAPTURE_SUPPRESSION", active: true, token: "shot-2" });
assert.deepEqual(responses, [{ ok: true, suppressed: true }]);
responses = runtimeMessages.emit({ type: "OBU_CAPTURE_SUPPRESSION", active: false, token: "shot-1" });
assert.deepEqual(responses, [{ ok: true, suppressed: true }]);
assert.equal(host.style.visibility, "hidden");
responses = runtimeMessages.emit({ type: "OBU_CAPTURE_SUPPRESSION", active: false, token: "shot-2" });
assert.deepEqual(responses, [{ ok: true, suppressed: false }]);
assert.equal(host.style.visibility, "");
assert.equal(host.getAttribute("data-obu-capture-suppressed"), null);
responses = runtimeMessages.emit({ type: "OBU_CAPTURE_SUPPRESSION", active: true, token: "stale-shot" });
assert.deepEqual(responses, [{ ok: true, suppressed: true }]);
assert.equal(host.style.visibility, "hidden");
responses = runtimeMessages.emit({ type: "OBU_CURSOR_HIDE" });
assert.deepEqual(responses, [{ ok: true }]);
assert.equal(documentElement.children.length, 0);
responses = runtimeMessages.emit({
  type: "OBU_TAKEOVER_STATE",
  active: true,
  lockInputs: true,
  sessionId: "session",
  turnId: "turn",
});
assert.deepEqual(responses, [{ ok: true, active: true, lockInputs: true }]);
host = documentElement.children[0];
assert.equal(host.style.visibility, "");
assert.equal(host.getAttribute("data-obu-capture-suppressed"), null);

const blocked = fakeDomEvent();
documentEvents.emitDom("click", blocked);
assert.equal(blocked.defaultPrevented, true);
assert.equal(blocked.stopped, true);

windowEvents.emitDom("__OBU_CURSOR_MESSAGE__", { detail: { type: "OBU_CURSOR_HIDE" } });
assert.equal(documentElement.children.length, 1);
const blockedAfterForgedHide = fakeDomEvent();
documentEvents.emitDom("click", blockedAfterForgedHide);
assert.equal(blockedAfterForgedHide.defaultPrevented, true);
assert.equal(blockedAfterForgedHide.stopped, true);

windowEvents.emitDom("__OBU_CURSOR_MESSAGE__", {
  detail: { type: "OBU_INPUT_BYPASS", durationMs: 100, eventFamilies: ["pointer"] },
});
const blockedAfterForgedBypass = fakeDomEvent();
documentEvents.emitDom("click", blockedAfterForgedBypass);
assert.equal(blockedAfterForgedBypass.defaultPrevented, true);
assert.equal(blockedAfterForgedBypass.stopped, true);

responses = runtimeMessages.emit({
  type: "OBU_INPUT_BYPASS",
  durationMs: 100,
  eventFamilies: ["pointer"],
  sessionId: "session",
  turnId: "turn",
});
assert.deepEqual(responses, [{ ok: true }]);
const bypassed = fakeDomEvent();
documentEvents.emitDom("click", bypassed);
assert.equal(bypassed.defaultPrevented, false);
assert.equal(bypassed.stopped, false);
const keyboardDuringPointerBypass = fakeDomEvent();
documentEvents.emitDom("keydown", keyboardDuringPointerBypass);
assert.equal(keyboardDuringPointerBypass.defaultPrevented, true);
assert.equal(keyboardDuringPointerBypass.stopped, true);
await new Promise((resolve) => setTimeout(resolve, 120));
const blockedAfterBypass = fakeDomEvent();
documentEvents.emitDom("click", blockedAfterBypass);
assert.equal(blockedAfterBypass.defaultPrevented, true);
assert.equal(blockedAfterBypass.stopped, true);
responses = runtimeMessages.emit({
  type: "OBU_INPUT_BYPASS",
  durationMs: 100,
  eventFamilies: ["keyboard"],
  sessionId: "session",
  turnId: "turn",
});
assert.deepEqual(responses, [{ ok: true }]);
const pointerDuringKeyboardBypass = fakeDomEvent();
documentEvents.emitDom("click", pointerDuringKeyboardBypass);
assert.equal(pointerDuringKeyboardBypass.defaultPrevented, true);
assert.equal(pointerDuringKeyboardBypass.stopped, true);
const keyboardBypassed = fakeDomEvent();
documentEvents.emitDom("keydown", keyboardBypassed);
assert.equal(keyboardBypassed.defaultPrevented, false);
assert.equal(keyboardBypassed.stopped, false);

responses = runtimeMessages.emit({ type: "OBU_CURSOR_MOVE", x: 10.2, y: 20.8, sequence: 1, sessionId: "session", turnId: "turn" });
assert.deepEqual(responses, [{ ok: true, sequence: 1 }]);
host = documentElement.children[0];
const cursor = host.shadowChildren[3];
assert.equal(cursor.style.transform, "translate3d(10px, 21px, 0)");
assert.match(cursor.children[0].style.transform, /rotate\(-44\.00deg\)/);
await waitFor(() => sentRuntimeMessages.some((message) => message.type === "OBU_CURSOR_ARRIVED" && message.sequence === 1));

responses = runtimeMessages.emit({ type: "OBU_CURSOR_EVENT", kind: "release", x: 10, y: 21, button: "left" });
assert.deepEqual(responses, [{ ok: true, kind: "release", sequence: undefined }]);
assert.equal(host.shadowChildren[2].children.length, 0);

responses = runtimeMessages.emit({ type: "OBU_CURSOR_EVENT", kind: "click", x: 10, y: 21, button: "left" });
assert.deepEqual(responses, [{ ok: true, kind: "click", sequence: undefined }]);
assert.equal(host.shadowChildren[2].children.length, 1);

responses = runtimeMessages.emit({ type: "OBU_CURSOR_HIDE" });
assert.deepEqual(responses, [{ ok: true }]);
assert.equal(documentElement.children.length, 0);

const unblocked = fakeDomEvent();
documentEvents.emitDom("click", unblocked);
assert.equal(unblocked.defaultPrevented, false);
assert.equal(unblocked.stopped, false);

responses = runtimeMessages.emit({ type: "OBU_TAKEOVER_STATE", active: true });
assert.deepEqual(responses, [{ ok: true, active: true, lockInputs: true }]);
const blockedByDefault = fakeDomEvent();
documentEvents.emitDom("click", blockedByDefault);
assert.equal(blockedByDefault.defaultPrevented, true);
assert.equal(blockedByDefault.stopped, true);
responses = runtimeMessages.emit({ type: "OBU_CURSOR_HIDE" });
assert.deepEqual(responses, [{ ok: true }]);
assert.equal(documentElement.children.length, 0);

runtimeMessages.emit({ type: "OBU_CURSOR_MOVE", x: 1, y: 2, sequence: 2 });
assert.equal(documentElement.children.length, 1);
assert.equal(documentElement.children[0].shadowChildren[3].style.transform, "translate3d(1px, 2px, 0)");

function fakeDomEvent() {
  return {
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
