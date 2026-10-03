import { i18n } from "@lingui/core";

/**
 * A list as the page's language joins it: "a, b and c", "a, b und c".
 * Never glued with ", " in a message, where word order differs.
 */
export const formatList = (items: readonly string[]): string =>
  new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(items);

/** A date and time as the page's language writes it, such as "3 Oct 2026, 14:05". */
export const formatDateTime = (value: string | number | Date): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

/** A date as the page's language writes it, such as "3 Oct 2026". */
export const formatDate = (value: string | number | Date): string =>
  new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
    new Date(value)
  );
