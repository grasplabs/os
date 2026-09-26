/**
 * Keeps request URLs and secrets out of Workers Logs (threat model R17).
 * Every Worker's wrangler config must turn off the platform's own line per
 * invocation and redact query strings, which carry OAuth codes and states
 * and bearer links. It must also turn off preview URLs, which would serve
 * every uploaded version, older ones included, at an address of its own.
 * Checks every wrangler config in the repo, so a new Worker can't miss it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Strings are matched first, so a `//` or `,}` inside one is kept.
const COMMENT = /(?<string>"(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu;
const TRAILING_COMMA = /(?<string>"(?:[^"\\]|\\.)*")|,(?=\s*[}\]])/gu;

const keepStrings = (_match: string, string?: string): string => string ?? "";

/** Wrangler's JSONC: JSON with comments and trailing commas. */
const parseJsonc = (text: string): unknown =>
  JSON.parse(
    text.replace(COMMENT, keepStrings).replace(TRAILING_COMMA, keepStrings)
  );

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const configs = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "*wrangler.json",
    "*wrangler.jsonc",
    "*wrangler.toml",
  ],
  { encoding: "utf-8" }
)
  .split("\n")
  .filter(Boolean);

const errors: string[] = [];

const check = (where: string, observability: unknown): void => {
  if (field(field(observability, "logs"), "invocation_logs") !== false) {
    errors.push(`${where}: set observability.logs.invocation_logs to false.`);
  }
  if (field(observability, "redact_query_string") !== true) {
    errors.push(`${where}: set observability.redact_query_string to true.`);
  }
};

const checkPreviewUrls = (where: string, previewUrls: unknown): void => {
  if (previewUrls !== false) {
    errors.push(`${where}: set preview_urls to false.`);
  }
};

for (const file of configs) {
  if (file.endsWith(".toml")) {
    errors.push(`${file}: use wrangler.jsonc, as every Worker here does.`);
    continue;
  }
  const config = parseJsonc(readFileSync(file, "utf-8"));
  check(file, field(config, "observability"));
  checkPreviewUrls(file, field(config, "preview_urls"));
  // An environment that sets its own observability or preview_urls replaces
  // the top level's.
  const envs = field(config, "env") ?? {};
  for (const name of Object.keys(envs)) {
    const env = field(envs, name);
    const observability = field(env, "observability");
    if (observability !== undefined) {
      check(`${file} (env ${name})`, observability);
    }
    const previewUrls = field(env, "preview_urls");
    if (previewUrls !== undefined) {
      checkPreviewUrls(`${file} (env ${name})`, previewUrls);
    }
  }
}

if (errors.length > 0) {
  console.error(
    `Workers must keep request URLs out of Workers Logs (threat model R17) and serve no preview URLs:\n${errors.map((line) => `  ${line}`).join("\n")}`
  );
  process.exit(1);
}
