import { i18n } from "@lingui/core";
import type { Messages } from "@lingui/core";

// The languages the frontend speaks: English is written in the code, the
// others are catalogs in `locales/<locale>/messages.po` (lingui.config.ts).
// Each is named in its own words, so anyone can find theirs.

export const localeNames = {
  en: "English",
  de: "Deutsch",
  nl: "Nederlands",
  es: "Español",
  fr: "Français",
} as const;

export type Locale = keyof typeof localeNames;

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && Object.hasOwn(localeNames, value);

/** The person's choice, kept for this browser. Not a secret, read by no server. */
const localeCookie = "grasp-locale";
const aYear = 365 * 24 * 60 * 60 * 1000;

const catalogs: Record<Locale, () => Promise<{ messages: Messages }>> = {
  en: async () => await import("./locales/en/messages.po"),
  de: async () => await import("./locales/de/messages.po"),
  nl: async () => await import("./locales/nl/messages.po"),
  es: async () => await import("./locales/es/messages.po"),
  fr: async () => await import("./locales/fr/messages.po"),
};

/** The language the person chose in this browser, if they did. */
const chosenLocale = async (): Promise<Locale | undefined> => {
  try {
    const cookie = await cookieStore.get(localeCookie);
    return isLocale(cookie?.value) ? cookie.value : undefined;
  } catch {
    // Without the Cookie Store API (an older browser), nothing was kept.
    return undefined;
  }
};

/** The first of the browser's languages the frontend speaks. */
const browserLocale = (): Locale | undefined =>
  navigator.languages
    .map((tag) => tag.toLowerCase().split("-")[0])
    .find(isLocale);

/** Loads a language and switches every message to it. */
const activate = async (locale: Locale): Promise<void> => {
  const { messages } = await catalogs[locale]();
  i18n.loadAndActivate({ locale, messages });
  // Screen readers, hyphenation and spell checking follow the page's language.
  document.documentElement.lang = locale;
};

/**
 * Before the first render: the person's choice, else the browser's
 * language, else English. A language that fails to load falls back to
 * English, so the page still says something.
 */
export const startI18n = async (): Promise<void> => {
  const locale = (await chosenLocale()) ?? browserLocale() ?? "en";
  try {
    await activate(locale);
  } catch (error) {
    if (locale === "en") {
      throw error;
    }
    await activate("en");
  }
};

/** Switches to `locale` and keeps the choice in this browser for a year. */
export const chooseLocale = async (locale: Locale): Promise<void> => {
  await activate(locale);
  try {
    await cookieStore.set({
      name: localeCookie,
      value: locale,
      path: "/",
      sameSite: "lax",
      expires: Date.now() + aYear,
    });
  } catch {
    // Without the Cookie Store API the choice lasts until the page reloads.
  }
};
