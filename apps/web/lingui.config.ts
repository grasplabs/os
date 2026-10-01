import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

/**
 * English is written in the code with Lingui's macros; `vp run i18n:extract`
 * collects it into one catalog per language, keyed by the English. Origins
 * without line numbers, so moving code doesn't churn the catalogs.
 */
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "de", "nl", "es", "fr"],
  fallbackLocales: { default: "en" },
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["<rootDir>/src"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "<rootDir>/src/routes/kit.tsx",
      ],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
