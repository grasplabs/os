import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { useLingui } from "@lingui/react/macro";
import { LanguagesIcon } from "lucide-react";

import { chooseLocale, isLocale, localeNames } from "./i18n.ts";
import type { Locale } from "./i18n.ts";

const languages = Object.entries(localeNames).map(([value, label]) => ({
  value,
  label,
}));

/**
 * The language the product speaks, as a submenu of the person menu. Each
 * language is named in its own words, so anyone can find theirs.
 */
export const LanguageMenu = () => {
  const { t, i18n } = useLingui();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <LanguagesIcon />
        {t`Language`}
        <span className="text-muted-foreground ml-auto">
          {localeNames[locale]}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value: unknown) => {
            if (isLocale(value)) {
              void chooseLocale(value);
            }
          }}
        >
          {languages.map((language) => (
            <DropdownMenuRadioItem
              key={language.value}
              lang={language.value}
              value={language.value}
            >
              {language.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};
