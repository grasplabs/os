import { i18n } from "@lingui/core";

// Tests read the page's text in English, as written in the code: no
// catalog, so every message is its own source.
i18n.loadAndActivate({ locale: "en", messages: {} });
