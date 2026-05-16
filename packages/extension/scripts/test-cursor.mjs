import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

class EventTarget {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(message) {
    const responses = [];
    for (const listener of this.listeners) {
      listener(message, {}, (response) => responses.push(response));
    }
    return responses;
  }
}

class FakeElement {
  style = {};
  dataset = {};
  children = [];
  parent = null;
  shadowChildren = [];

  append(child) {
    child.parent = this;
    this.children.push(child);
  }

  attachShadow() {
    return {
      append: (child) => {
        child.parent = this;
        this.shadowChildren.push(child);
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
const documentElement = new FakeElement();

globalThis.document = {
  documentElement,
  createElement() {
    return new FakeElement();
  },
};
globalThis.chrome = {
  runtime: {
    onMessage: runtimeMessages,
  },
};

await import(`${pathToFileURL(path.join(packageRoot, "dist", "cursor.js")).href}?test=${Date.now()}`);

assert.equal(runtimeMessages.emit({ type: "IGNORED" }).length, 0);

let responses = runtimeMessages.emit({ type: "OBU_CURSOR_MOVE", x: 10.2, y: 20.8, sequence: 1 });
assert.deepEqual(responses, [{ ok: true, sequence: 1 }]);
assert.equal(documentElement.children.length, 1);
let host = documentElement.children[0];
assert.equal(host.style.position, "fixed");
assert.equal(host.style.transform, "translate(10px, 21px)");
assert.equal(host.shadowChildren.length, 1);
assert.equal(host.shadowChildren[0].dataset.sequence, "1");

responses = runtimeMessages.emit({ type: "OBU_CURSOR_MOVE", x: 30, y: 40 });
assert.deepEqual(responses, [{ ok: true, sequence: undefined }]);
assert.equal(documentElement.children.length, 1);
host = documentElement.children[0];
assert.equal(host.style.transform, "translate(30px, 40px)");
assert.equal(host.shadowChildren[0].dataset.sequence, "");

responses = runtimeMessages.emit({ type: "OBU_CURSOR_HIDE" });
assert.deepEqual(responses, [{ ok: true }]);
assert.equal(documentElement.children.length, 0);

runtimeMessages.emit({ type: "OBU_CURSOR_MOVE", x: 1, y: 2, sequence: 2 });
assert.equal(documentElement.children.length, 1);
assert.equal(documentElement.children[0].style.transform, "translate(1px, 2px)");
