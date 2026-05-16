import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const builtCursor = await readFile(path.join(packageRoot, "dist", "cursor.js"), "utf8");
assert.doesNotMatch(builtCursor, /\bexport\s*\{\s*\}/);
assert.match(builtCursor, /(?:^|\n)\(\(\) => \{/);

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
    for (const row of this.listeners) {
      if (row.type === type) row.listener(event);
    }
  }
}

class FakeElement {
  style = {};
  dataset = {};
  children = [];
  parent = null;
  shadowChildren = [];

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
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
assert.equal(host.style.position, "fixed");
assert.equal(host.shadowChildren.length, 3);
assert.equal(host.shadowChildren[0].style.opacity, "1");

const blocked = fakeDomEvent();
documentEvents.emitDom("click", blocked);
assert.equal(blocked.defaultPrevented, true);
assert.equal(blocked.stopped, true);

responses = runtimeMessages.emit({ type: "OBU_INPUT_BYPASS", durationMs: 100, sessionId: "session", turnId: "turn" });
assert.deepEqual(responses, [{ ok: true }]);
const bypassed = fakeDomEvent();
documentEvents.emitDom("click", bypassed);
assert.equal(bypassed.defaultPrevented, false);
assert.equal(bypassed.stopped, false);
await new Promise((resolve) => setTimeout(resolve, 120));
const blockedAfterBypass = fakeDomEvent();
documentEvents.emitDom("click", blockedAfterBypass);
assert.equal(blockedAfterBypass.defaultPrevented, true);
assert.equal(blockedAfterBypass.stopped, true);

responses = runtimeMessages.emit({ type: "OBU_CURSOR_MOVE", x: 10.2, y: 20.8, sequence: 1, sessionId: "session", turnId: "turn" });
assert.deepEqual(responses, [{ ok: true, sequence: 1 }]);
host = documentElement.children[0];
const cursor = host.shadowChildren[2];
assert.equal(cursor.style.transform, "translate3d(10px, 21px, 0)");
assert.match(cursor.children[0].style.transform, /rotate\(-44\.00deg\)/);
await waitFor(() => sentRuntimeMessages.some((message) => message.type === "OBU_CURSOR_ARRIVED" && message.sequence === 1));

responses = runtimeMessages.emit({ type: "OBU_CURSOR_EVENT", kind: "release", x: 10, y: 21, button: "left" });
assert.deepEqual(responses, [{ ok: true, kind: "release", sequence: undefined }]);
assert.equal(host.shadowChildren[1].children.length, 0);

responses = runtimeMessages.emit({ type: "OBU_CURSOR_EVENT", kind: "click", x: 10, y: 21, button: "left" });
assert.deepEqual(responses, [{ ok: true, kind: "click", sequence: undefined }]);
assert.equal(host.shadowChildren[1].children.length, 1);

responses = runtimeMessages.emit({ type: "OBU_CURSOR_HIDE" });
assert.deepEqual(responses, [{ ok: true }]);
assert.equal(documentElement.children.length, 0);

const unblocked = fakeDomEvent();
documentEvents.emitDom("click", unblocked);
assert.equal(unblocked.defaultPrevented, false);
assert.equal(unblocked.stopped, false);

runtimeMessages.emit({ type: "OBU_CURSOR_MOVE", x: 1, y: 2, sequence: 2 });
assert.equal(documentElement.children.length, 1);
assert.equal(documentElement.children[0].shadowChildren[2].style.transform, "translate3d(1px, 2px, 0)");

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
