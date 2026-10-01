import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useLingui } from "@lingui/react/macro";

import { chooseLocale, isLocale, localeNames } from "./i18n.ts";
import type { Locale } from "./i18n.ts";

const languages = Object.entries(localeNames).map(([value, label]) => ({
  value,
  label,
}));

/**
 * The language the product speaks, and a way to change it. Each language
 * is named in its own words, so anyone can find theirs.
 */
export const LanguagePicker = () => {
  const { t, i18n } = useLingui();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  return (
    <Select
      items={languages}
      value={locale}
      onValueChange={(value) => {
        if (isLocale(value)) {
          void chooseLocale(value);
        }
      }}
    >
      <SelectTrigger aria-label={t`Language`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {languages.map((language) => (
          <SelectItem
            key={language.value}
            value={language.value}
            lang={language.value}
          >
            {language.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
