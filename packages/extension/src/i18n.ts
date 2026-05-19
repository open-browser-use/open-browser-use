type MessageSubstitution = string | string[];
type LocaleMessage = {
  message: string;
  placeholders?: Record<string, { content?: string }>;
};
type LocaleMessages = Record<string, LocaleMessage>;

export const LANGUAGE_SETTING_KEY = "OBU_LANGUAGE_SETTING";
export const LANGUAGE_AUTO = "auto";

export const SUPPORTED_LOCALES = [
  { code: "ar", nativeName: "العربية" },
  { code: "de", nativeName: "Deutsch" },
  { code: "en", nativeName: "English" },
  { code: "es", nativeName: "Español" },
  { code: "fr", nativeName: "Français" },
  { code: "hi", nativeName: "हिन्दी" },
  { code: "id", nativeName: "Bahasa Indonesia" },
  { code: "it", nativeName: "Italiano" },
  { code: "ja", nativeName: "日本語" },
  { code: "ko", nativeName: "한국어" },
  { code: "nl", nativeName: "Nederlands" },
  { code: "pl", nativeName: "Polski" },
  { code: "pt_BR", nativeName: "Português (Brasil)" },
  { code: "ru", nativeName: "Русский" },
  { code: "tr", nativeName: "Türkçe" },
  { code: "vi", nativeName: "Tiếng Việt" },
  { code: "zh_CN", nativeName: "简体中文" },
  { code: "zh_TW", nativeName: "繁體中文" },
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]["code"];
export type LanguageSetting = typeof LANGUAGE_AUTO | SupportedLocale;

let activeLanguageSetting: LanguageSetting = LANGUAGE_AUTO;
let activeLocale: SupportedLocale | undefined;
let activeMessages: LocaleMessages | undefined;

export async function initI18n(): Promise<void> {
  const setting = await getLanguageSetting();
  activeLanguageSetting = setting;
  if (setting === LANGUAGE_AUTO) {
    activeLocale = undefined;
    activeMessages = undefined;
    return;
  }

  const messages = await loadLocaleMessages(setting);
  activeLocale = messages ? setting : undefined;
  activeMessages = messages;
}

export function getActiveLanguageSetting(): LanguageSetting {
  return activeLanguageSetting;
}

export async function getLanguageSetting(): Promise<LanguageSetting> {
  const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
  if (!storage?.get) return LANGUAGE_AUTO;
  try {
    const result = await storage.get(LANGUAGE_SETTING_KEY);
    const value = result[LANGUAGE_SETTING_KEY];
    return isLanguageSetting(value) ? value : LANGUAGE_AUTO;
  } catch {
    return LANGUAGE_AUTO;
  }
}

export async function setLanguageSetting(setting: LanguageSetting): Promise<void> {
  if (!isLanguageSetting(setting)) throw new Error(`unsupported language setting: ${String(setting)}`);
  const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
  if (!storage?.set) throw new Error("storage API unavailable");
  await storage.set({ [LANGUAGE_SETTING_KEY]: setting });
  await initI18n();
}

export function msg(key: string, substitutions?: MessageSubstitution, fallback = key): string {
  const override = messageFromOverride(key, substitutions);
  if (override.length > 0) return override;
  const value = (globalThis as { chrome?: typeof chrome }).chrome?.i18n?.getMessage(key, substitutions) ?? "";
  return value.length > 0 ? value : fallback;
}

export function msgPlural(baseKey: string, count: number, substitutions: string[], fallback?: string): string {
  const category = pluralCategory(count);
  const localized = msg(`${baseKey}_${category}`, substitutions, "");
  if (localized.length > 0) return localized;
  return msg(`${baseKey}_other`, substitutions, fallback ?? `${baseKey}_${category}`);
}

export function applyDocumentLocale(): void {
  const root = (document as Document & { documentElement?: HTMLElement }).documentElement;
  if (!root) return;
  const locale = activeLocale ?? browserUiLocale();
  root.lang = locale.replace("_", "-");
  root.dir = bidiDirForLocale(locale);
}

export function applyStaticMessages(): void {
  const doc = document as Document & {
    querySelectorAll?: Document["querySelectorAll"];
  };
  doc.querySelectorAll?.("[data-i18n]").forEach((node) => {
    const key = (node as HTMLElement).dataset.i18n;
    if (key) node.textContent = msg(key, undefined, node.textContent ?? key);
  });
  doc.querySelectorAll?.("[data-i18n-aria-label]").forEach((node) => {
    const element = node as HTMLElement;
    const key = element.dataset.i18nAriaLabel;
    if (key) element.setAttribute("aria-label", msg(key, undefined, element.getAttribute("aria-label") ?? key));
  });
  doc.querySelectorAll?.("[data-i18n-title]").forEach((node) => {
    const element = node as HTMLElement;
    const key = element.dataset.i18nTitle;
    if (key) element.setAttribute("title", msg(key, undefined, element.getAttribute("title") ?? key));
  });
}

function messageFromOverride(key: string, substitutions?: MessageSubstitution): string {
  if (activeLocale) {
    if (key === "@@ui_locale") return activeLocale;
    if (key === "@@bidi_dir") return bidiDirForLocale(activeLocale);
  }
  const entry = activeMessages?.[key];
  if (!entry?.message) return "";
  return interpolateMessage(entry, substitutions);
}

function interpolateMessage(entry: LocaleMessage, substitutions?: MessageSubstitution): string {
  const values = Array.isArray(substitutions)
    ? substitutions
    : substitutions === undefined
      ? []
      : [substitutions];
  let message = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const match = /^\$(\d+)$/.exec(placeholder.content ?? "");
    if (!match) continue;
    const value = values[Number(match[1]) - 1] ?? "";
    message = message.replace(new RegExp(`\\$${escapeRegExp(name)}\\$`, "gi"), value);
  }
  return message;
}

async function loadLocaleMessages(locale: SupportedLocale): Promise<LocaleMessages | undefined> {
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (!runtime?.getURL || typeof fetch !== "function") return undefined;
  try {
    const response = await fetch(runtime.getURL(`_locales/${locale}/messages.json`));
    if (!response.ok) return undefined;
    return await response.json() as LocaleMessages;
  } catch {
    return undefined;
  }
}

function pluralCategory(count: number): string {
  const locale = (activeLocale ?? browserUiLocale()).replace("_", "-");
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

function browserUiLocale(): string {
  const chromeApi = (globalThis as { chrome?: typeof chrome }).chrome;
  return chromeApi?.i18n?.getMessage("@@ui_locale") || chromeApi?.i18n?.getUILanguage?.() || "en";
}

function bidiDirForLocale(locale: string): "ltr" | "rtl" {
  return locale.toLowerCase().startsWith("ar") ? "rtl" : "ltr";
}

function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === LANGUAGE_AUTO || SUPPORTED_LOCALES.some((locale) => locale.code === value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
