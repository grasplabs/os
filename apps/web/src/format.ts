import { i18n } from "@lingui/core";

/**
 * A list as the page's language joins it: "a, b and c", "a, b und c".
 * Never glued with ", " in a message, where word order differs.
 */
export const formatList = (items: readonly string[]): string =>
  new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(items);
