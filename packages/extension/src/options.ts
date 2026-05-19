import {
  LANGUAGE_AUTO,
  type LanguageSetting,
  SUPPORTED_LOCALES,
  applyDocumentLocale,
  applyStaticMessages,
  getActiveLanguageSetting,
  initI18n,
  msg,
  setLanguageSetting,
} from "./i18n.js";

const languageSelect = document.querySelector<HTMLSelectElement>("#language-select");
const settingsStatus = document.querySelector<HTMLParagraphElement>("#settings-status");

void start();

async function start(): Promise<void> {
  await initI18n();
  renderSettings();
  languageSelect?.addEventListener("change", () => {
    void saveLanguageSetting();
  });
}

function renderSettings(status?: string): void {
  applyDocumentLocale();
  applyStaticMessages();
  document.title = msg("settingsDocumentTitle");
  renderLanguageOptions();
  if (settingsStatus) settingsStatus.textContent = status ?? "";
}

function renderLanguageOptions(): void {
  if (!languageSelect) return;
  const selected = getActiveLanguageSetting();
  const options = [
    optionElement(LANGUAGE_AUTO, msg("settingsLanguageAuto")),
    ...SUPPORTED_LOCALES.map((locale) => optionElement(locale.code, locale.nativeName)),
  ];
  languageSelect.replaceChildren(...options);
  languageSelect.value = selected;
}

async function saveLanguageSetting(): Promise<void> {
  if (!languageSelect) return;
  const next = languageSelect.value;
  if (!isLanguageSetting(next)) return;
  languageSelect.disabled = true;
  try {
    await setLanguageSetting(next);
    renderSettings(msg("settingsSaved"));
  } catch {
    renderSettings(msg("settingsSaveFailed"));
  } finally {
    languageSelect.disabled = false;
  }
}

function optionElement(value: LanguageSetting, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function isLanguageSetting(value: string): value is LanguageSetting {
  return value === LANGUAGE_AUTO || SUPPORTED_LOCALES.some((locale) => locale.code === value);
}
