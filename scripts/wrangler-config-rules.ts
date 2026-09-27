/**
 * The rules every Worker's wrangler config (and any env in it that sets its
 * own) must follow, as a pure check over one config's text:
 * - turns off the platform's own log line per invocation, and
 * - redacts query strings, which carry OAuth codes and states and bearer
 *   links, so request URLs and secrets stay out of Workers Logs (threat
 *   model R17);
 * - turns off preview URLs, which would serve every uploaded version,
 *   older ones included, at an address of its own;
 * - is wrangler.jsonc, never TOML.
 * `check-wrangler-configs.ts` runs it on every wrangler config in the repo.
 */

// Strings are matched first, so a `//` or `,}` inside one is kept.
const COMMENT = /(?<string>"(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;
const TRAILING_COMMA = /(?<string>"(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/gu;

const keepStrings = (_match: string, string?: string): string => string ?? "";

/** Wrangler's JSONC: JSON with comments and trailing commas. */
export const parseJsonc = (text: string): unknown =>
  JSON.parse(
    text.replace(COMMENT, keepStrings).replace(TRAILING_COMMA, keepStrings)
  );

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const observabilityErrors = (
  where: string,
  observability: unknown
): string[] => [
  ...(field(field(observability, "logs"), "invocation_logs") === false
    ? []
    : [`${where}: set observability.logs.invocation_logs to false.`]),
  ...(field(observability, "redact_query_string") === true
    ? []
    : [`${where}: set observability.redact_query_string to true.`]),
];

const previewUrlErrors = (where: string, previewUrls: unknown): string[] =>
  previewUrls === false ? [] : [`${where}: set preview_urls to false.`];

/** What `file`'s config, whose text is `text`, breaks of the rules above. */
export const wranglerConfigErrors = (file: string, text: string): string[] => {
  if (file.endsWith(".toml")) {
    return [`${file}: use wrangler.jsonc, as every Worker here does.`];
  }
  const config = parseJsonc(text);
  const errors = [
    ...observabilityErrors(file, field(config, "observability")),
    ...previewUrlErrors(file, field(config, "preview_urls")),
  ];
  // An environment that sets its own observability or preview_urls replaces
  // the top level's.
  const envs = field(config, "env") ?? {};
  for (const name of Object.keys(envs)) {
    const env = field(envs, name);
    const where = `${file} (env ${name})`;
    const observability = field(env, "observability");
    if (observability !== undefined) {
      errors.push(...observabilityErrors(where, observability));
    }
    const previewUrls = field(env, "preview_urls");
    if (previewUrls !== undefined) {
      errors.push(...previewUrlErrors(where, previewUrls));
    }
  }
  return errors;
};
