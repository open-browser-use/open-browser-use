import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const languageSettingKey = "OBU_LANGUAGE_SETTING";

class FakeElement {
  className = "";
  textContent = "";
  value = "";
  disabled = false;
  children = [];
  dataset = {};
  attributes = new Map();
  listeners = new Map();

  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

const elements = {
  languageSelect: new FakeElement("select"),
  settingsStatus: new FakeElement("p"),
  pageTitle: new FakeElement("h1"),
  pageSubtitle: new FakeElement("p"),
  actionButton: new FakeElement("button"),
  titledHelp: new FakeElement("span"),
};
elements.pageTitle.dataset.i18n = "settingsPageTitle";
elements.pageTitle.textContent = "Settings";
elements.pageSubtitle.dataset.i18n = "settingsPageSubtitle";
elements.pageSubtitle.textContent = "Control how open-browser-use feels in this browser.";
elements.actionButton.dataset.i18nAriaLabel = "settingsLanguageTitle";
elements.actionButton.setAttribute("aria-label", "Language");
elements.titledHelp.dataset.i18nTitle = "settingsLanguageDescription";
elements.titledHelp.setAttribute("title", "Choose the language for extension pages.");

const documentElement = new FakeElement("html");
const staticNodes = [
  elements.pageTitle,
  elements.pageSubtitle,
  elements.actionButton,
  elements.titledHelp,
];

globalThis.document = {
  title: "",
  documentElement,
  querySelector(selector) {
    if (selector === "#language-select") return elements.languageSelect;
    if (selector === "#settings-status") return elements.settingsStatus;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "[data-i18n]") return staticNodes.filter((node) => node.dataset.i18n);
    if (selector === "[data-i18n-aria-label]") return staticNodes.filter((node) => node.dataset.i18nAriaLabel);
    if (selector === "[data-i18n-title]") return staticNodes.filter((node) => node.dataset.i18nTitle);
    return [];
  },
  createElement(tagName) {
    return new FakeElement(tagName);
  },
};

const localeMessages = {
  zh_CN: {
    settingsDocumentTitle: { message: "设置标题" },
    settingsPageTitle: { message: "设置" },
    settingsPageSubtitle: { message: "控制浏览器扩展页面语言。" },
    settingsLanguageTitle: { message: "语言" },
    settingsLanguageDescription: { message: "选择扩展页面语言。" },
    settingsLanguageAuto: { message: "跟随浏览器" },
    settingsSaved: { message: "已保存" },
    settingsSaveFailed: { message: "保存失败" },
  },
  de: {
    settingsDocumentTitle: { message: "Einstellungen" },
    settingsPageTitle: { message: "Einstellungen" },
    settingsPageSubtitle: { message: "Sprache der Erweiterungsseiten steuern." },
    settingsLanguageTitle: { message: "Sprache" },
    settingsLanguageDescription: { message: "Sprache fuer Erweiterungsseiten auswaehlen." },
    settingsLanguageAuto: { message: "Browser verwenden" },
    settingsSaved: { message: "Gespeichert" },
    settingsSaveFailed: { message: "Speichern fehlgeschlagen" },
  },
};

const storage = { [languageSettingKey]: "zh_CN" };
let failNextStorageSet = false;

globalThis.chrome = {
  runtime: {
    getURL(relativePath) {
      return `chrome-extension://test/${relativePath}`;
    },
  },
  storage: {
    local: {
      async get(key) {
        return { [key]: storage[key] };
      },
      async set(values) {
        if (failNextStorageSet) {
          failNextStorageSet = false;
          throw new Error("synthetic storage failure");
        }
        Object.assign(storage, values);
      },
    },
  },
  i18n: {
    getMessage(messageName) {
      if (messageName === "@@ui_locale") return "en";
      if (messageName === "@@bidi_dir") return "ltr";
      return "";
    },
    getUILanguage() {
      return "en-US";
    },
  },
};

globalThis.fetch = async (url) => {
  const locale = /_locales\/([^/]+)\/messages\.json$/.exec(String(url))?.[1];
  const messages = locale ? localeMessages[locale] : undefined;
  return {
    ok: Boolean(messages),
    async json() {
      return messages;
    },
  };
};

await import(`${pathToFileURL(path.join(packageRoot, "dist", "options.js")).href}?test=${Date.now()}`);
await waitFor(() => elements.languageSelect.children.length > 1);

assert.equal(document.title, "设置标题");
assert.equal(documentElement.lang, "zh-CN");
assert.equal(documentElement.dir, "ltr");
assert.equal(elements.pageTitle.textContent, "设置");
assert.equal(elements.pageSubtitle.textContent, "控制浏览器扩展页面语言。");
assert.equal(elements.actionButton.getAttribute("aria-label"), "语言");
assert.equal(elements.titledHelp.getAttribute("title"), "选择扩展页面语言。");
assert.equal(elements.languageSelect.value, "zh_CN");
assert.equal(elements.languageSelect.children[0].value, "auto");
assert.equal(elements.languageSelect.children[0].textContent, "跟随浏览器");
assert.ok(elements.languageSelect.children.some((option) => option.value === "de" && option.textContent === "Deutsch"));

elements.languageSelect.value = "de";
elements.languageSelect.dispatch("change");
await waitFor(() => elements.settingsStatus.textContent === "Gespeichert");
assert.equal(storage[languageSettingKey], "de");
assert.equal(document.title, "Einstellungen");
assert.equal(documentElement.lang, "de");
assert.equal(elements.languageSelect.disabled, false);

failNextStorageSet = true;
elements.languageSelect.value = "fr";
elements.languageSelect.dispatch("change");
await waitFor(() => elements.settingsStatus.textContent === "Speichern fehlgeschlagen");
assert.equal(storage[languageSettingKey], "de");
assert.equal(elements.languageSelect.disabled, false);

elements.languageSelect.value = "unsupported";
elements.settingsStatus.textContent = "unchanged";
elements.languageSelect.dispatch("change");
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(elements.settingsStatus.textContent, "unchanged");
assert.equal(storage[languageSettingKey], "de");

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for options test predicate");
}
