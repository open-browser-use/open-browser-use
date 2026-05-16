import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = path.resolve(packageRoot, "../..");
const extensionDir = path.join(packageRoot, "dist");
const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
const extensionId = extensionIdFromKey(manifest.key);

class CdpConnection {
  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const connection = new CdpConnection(socket);
      socket.addEventListener("open", () => resolve(connection), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    this.socket.close();
  }
}

const chrome = findChrome();
if (!chrome) {
  console.log("skipped real-browser takeover test: no Chrome for Testing or Chromium found");
  process.exit(0);
}
if (typeof WebSocket !== "function") {
  throw new Error("global WebSocket is required for the real-browser takeover test");
}

const temp = await mkdtemp(path.join(os.tmpdir(), "obu-extension-takeover-"));
const server = await fixtureServer();
let chromeProcess;
let cdp;
try {
  const profileDir = path.join(temp, "profile");
  await mkdir(profileDir, { recursive: true });
  const url = `http://127.0.0.1:${server.port}/fixture`;
  chromeProcess = spawn(chrome, chromeArgs(profileDir), {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env },
  });
  let chromeStderr = "";
  chromeProcess.stderr.setEncoding("utf8");
  chromeProcess.stderr.on("data", (chunk) => {
    chromeStderr += chunk;
  });

  const websocketUrl = await waitForDevToolsUrl(profileDir).catch((error) => {
    throw new Error(`${error.message}\nChrome stderr:\n${chromeStderr}`);
  });
  cdp = await CdpConnection.open(websocketUrl);
  const pageTarget = await cdp.send("Target.createTarget", { url });
  const pageAttached = await cdp.send("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });
  const pageSession = pageAttached.sessionId;
  await cdp.send("Runtime.enable", {}, pageSession);
  await waitForPageReady(cdp, pageSession);
  const clickPoints = await fixtureClickPoints(cdp, pageSession);

  const extensionTarget = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup.html`,
  });
  const extensionAttached = await cdp.send("Target.attachToTarget", {
    targetId: extensionTarget.targetId,
    flatten: true,
  });
  const extensionSession = extensionAttached.sessionId;
  await cdp.send("Runtime.enable", {}, extensionSession);
  await waitForPageReady(cdp, extensionSession);

  const ping = await sendTabMessage(cdp, extensionSession, url, { type: "OBU_CONTENT_PING" });
  assert.equal(ping.ok, true);

  await sendTabMessage(cdp, extensionSession, url, {
    type: "OBU_TAKEOVER_STATE",
    active: true,
    lockInputs: true,
    sessionId: "real-browser-session",
    turnId: "turn-1",
  });
  await sleep(100);

  await click(cdp, pageSession, clickPoints.main.x, clickPoints.main.y);
  assert.deepEqual(await counts(cdp, pageSession), { main: 0, frame: 0 });

  await sendTabMessage(cdp, extensionSession, url, {
    type: "OBU_INPUT_BYPASS",
    durationMs: 800,
    sessionId: "real-browser-session",
    turnId: "turn-1",
    reason: "real-browser-test",
  });
  await click(cdp, pageSession, clickPoints.main.x, clickPoints.main.y);
  assert.deepEqual(await counts(cdp, pageSession), { main: 1, frame: 0 });

  await sleep(900);
  assert.equal(await dispatchFrameDomClick(cdp, pageSession), false);
  await sleep(100);
  assert.deepEqual(await counts(cdp, pageSession), { main: 1, frame: 0 });

  await sendTabMessage(cdp, extensionSession, url, {
    type: "OBU_INPUT_BYPASS",
    durationMs: 800,
    sessionId: "real-browser-session",
    turnId: "turn-1",
    reason: "real-browser-test",
  });
  assert.equal(await dispatchFrameDomClick(cdp, pageSession), true);
  await sleep(100);
  assert.deepEqual(await counts(cdp, pageSession), { main: 1, frame: 1 });

  await sendTabMessage(cdp, extensionSession, url, { type: "OBU_CURSOR_HIDE" });
  await click(cdp, pageSession, clickPoints.main.x, clickPoints.main.y);
  assert.deepEqual(await counts(cdp, pageSession), { main: 2, frame: 1 });
  console.log("real-browser takeover test passed");
} finally {
  cdp?.close();
  await new Promise((resolve) => server.close(resolve));
  if (chromeProcess) {
    chromeProcess.kill("SIGTERM");
    await waitForExit(chromeProcess, 3000).catch(() => {
      chromeProcess.kill("SIGKILL");
    });
  }
  if (process.env.OBU_KEEP_E2E_TMP !== "1") {
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else {
    console.error(`Preserved takeover browser test temp dir: ${temp}`);
  }
}

function fixtureServer() {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/frame") {
      response.end(`<!doctype html>
<meta charset="utf-8">
<style>body{margin:0}button{position:absolute;left:30px;top:30px;width:100px;height:50px}</style>
<button>Frame</button>
<script>
  document.querySelector("button").addEventListener("click", () => {
    parent.frameClicks += 1;
  });
</script>`);
      return;
    }
    response.end(`<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; }
  #main { position: absolute; left: 40px; top: 40px; width: 120px; height: 60px; }
  iframe { position: absolute; left: 240px; top: 40px; width: 220px; height: 120px; border: 0; }
</style>
<script>
  window.mainClicks = 0;
  window.frameClicks = 0;
</script>
<button id="main" onclick="window.mainClicks += 1">Main</button>
<iframe src="/frame"></iframe>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        close: (callback) => server.close(callback),
        port: server.address().port,
      });
    });
  });
}

function findChrome() {
  const explicit = process.env.OBU_WEBEXT_CHROME_BIN || process.env.OBU_CHROME_BIN;
  if (explicit && existsExecutable(explicit)) return explicit;
  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    : ["google-chrome-for-testing", "chromium", "chromium-browser"];
  for (const candidate of candidates) {
    const resolved = candidate.includes("/") ? candidate : which(candidate);
    if (resolved && existsExecutable(resolved)) return resolved;
  }
  if (process.env.OBU_WEBEXT_E2E_AUTO_INSTALL === "1") {
    const result = spawnSync(path.join(repoRoot, "scripts", "ensure-chrome-for-testing.sh"), { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const installed = result.stdout.trim();
    if (installed && existsExecutable(installed)) return installed;
  }
  return undefined;
}

function chromeArgs(profileDir) {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank",
  ];
  if (process.platform === "darwin") args.unshift("--use-mock-keychain");
  if (process.platform === "linux") args.unshift("--no-sandbox");
  if (process.env.OBU_WEBEXT_E2E_HEADLESS === "1") args.unshift("--headless=new");
  return args;
}

async function waitForDevToolsUrl(profileDir) {
  const activePort = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const [port, pathPart] = (await readFile(activePort, "utf8")).trim().split(/\r?\n/);
      if (port && pathPart) return `ws://127.0.0.1:${port}${pathPart}`;
    } catch {
      // Chrome writes this file after startup.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${activePort}`);
}

async function waitForPageReady(connection, sessionId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await connection.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    }, sessionId);
    if (result.result?.value === "complete") return;
    await sleep(50);
  }
  throw new Error("timed out waiting for page readyState=complete");
}

async function sendTabMessage(connection, extensionSession, pageUrl, message) {
  const expression = message.type === "OBU_CONTENT_PING" ? `
new Promise((resolve, reject) => {
  chrome.tabs.query({}, (tabs) => {
    const tab = tabs.find((row) => typeof row.url === "string" && row.url.startsWith(${JSON.stringify(pageUrl)}));
    if (!tab?.id) {
      reject(new Error("fixture tab not found"));
      return;
    }
    chrome.tabs.sendMessage(tab.id, ${JSON.stringify(message)}, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(response);
    });
  });
})` : `
new Promise((resolve, reject) => {
  chrome.tabs.query({}, (tabs) => {
    const tab = tabs.find((row) => typeof row.url === "string" && row.url.startsWith(${JSON.stringify(pageUrl)}));
    if (!tab?.id) {
      reject(new Error("fixture tab not found"));
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      args: ["__OBU_CURSOR_MESSAGE__", ${JSON.stringify(message)}],
      func: (eventName, payload) => {
        globalThis.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
      },
    }).then(() => resolve({ ok: true }), reject);
  });
})`;
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, extensionSession);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "extension message failed");
  }
  return result.result?.value;
}

async function click(connection, sessionId, x, y) {
  await connection.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  }, sessionId);
  await connection.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  }, sessionId);
  await sleep(100);
}

async function dispatchFrameDomClick(connection, sessionId) {
  const result = await connection.send("Runtime.evaluate", {
    expression: `(() => {
      const iframe = document.querySelector("iframe");
      const button = iframe.contentDocument.querySelector("button");
      const event = new iframe.contentWindow.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: iframe.contentWindow,
      });
      return button.dispatchEvent(event);
    })()`,
    returnByValue: true,
  }, sessionId);
  return result.result.value;
}

async function counts(connection, sessionId) {
  const result = await connection.send("Runtime.evaluate", {
    expression: "({ main: window.mainClicks, frame: window.frameClicks })",
    returnByValue: true,
  }, sessionId);
  return result.result.value;
}

async function fixtureClickPoints(connection, sessionId) {
  const result = await connection.send("Runtime.evaluate", {
    expression: `(() => {
      const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      const main = center(document.querySelector("#main").getBoundingClientRect());
      const iframe = document.querySelector("iframe");
      const iframeRect = iframe.getBoundingClientRect();
      const buttonRect = iframe.contentDocument.querySelector("button").getBoundingClientRect();
      return {
        main,
        frame: {
          x: iframeRect.left + buttonRect.left + buttonRect.width / 2,
          y: iframeRect.top + buttonRect.top + buttonRect.height / 2,
        },
      };
    })()`,
    returnByValue: true,
  }, sessionId);
  return result.result.value;
}

function extensionIdFromKey(key) {
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...hash]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 0x0f))}`)
    .join("");
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process exit timeout")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function existsExecutable(file) {
  return spawnSync("test", ["-x", file]).status === 0;
}

function which(command) {
  const result = spawnSync("sh", ["-c", `command -v ${shellQuote(command)}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
