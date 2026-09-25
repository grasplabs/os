/**
 * Stands in for the types of `@xmldom/xmldom` 0.8, which the SSO plugin's SAML
 * library names in its own types. Those start with `/// <reference lib="dom" />`,
 * which would load the browser's globals into core's types (a `crypto`
 * without Workers' `timingSafeEqual`, `window`, `document`). Core never uses
 * SAML's XML parser, so these two names are all it needs to know.
 */
export interface DOMParser {
  parseFromString: (source: string, mimeType?: string) => unknown;
}

export type Options = Record<string, unknown>;
