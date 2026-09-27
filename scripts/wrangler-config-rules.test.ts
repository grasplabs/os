import { describe, expect, it } from "vite-plus/test";

import { wranglerConfigErrors } from "./wrangler-config-rules.ts";

const file = "apps/example/wrangler.jsonc";

/** A config that follows every rule, as JSONC with a comment and trailing commas. */
const compliant = `{
  // A Worker.
  "name": "example",
  "preview_urls": false,
  "observability": {
    "redact_query_string": true,
    "logs": { "invocation_logs": false },
  },
}`;

/**
 * `compliant` with `changes` merged over its top level; a key set to
 * undefined is left out.
 */
const configWith = (changes: Record<string, unknown>): string =>
  JSON.stringify({
    name: "example",
    preview_urls: false,
    observability: {
      redact_query_string: true,
      logs: { invocation_logs: false },
    },
    ...changes,
  });

describe("wrangler config rules", () => {
  it("accept a config that follows every rule", () => {
    expect(wranglerConfigErrors(file, compliant)).toStrictEqual([]);
  });

  it("refuse a config without preview_urls false, and an env that turns preview URLs on", () => {
    expect({
      missing: wranglerConfigErrors(
        file,
        configWith({ preview_urls: undefined })
      ),
      on: wranglerConfigErrors(file, configWith({ preview_urls: true })),
      envOn: wranglerConfigErrors(
        file,
        configWith({ env: { staging: { preview_urls: true } } })
      ),
      envOff: wranglerConfigErrors(
        file,
        configWith({ env: { staging: { preview_urls: false } } })
      ),
    }).toStrictEqual({
      missing: [`${file}: set preview_urls to false.`],
      on: [`${file}: set preview_urls to false.`],
      envOn: [`${file} (env staging): set preview_urls to false.`],
      envOff: [],
    });
  });

  it("refuse invocation logs or unredacted query strings, at the top level or in an env that sets its own observability", () => {
    expect({
      missing: wranglerConfigErrors(
        file,
        configWith({ observability: undefined })
      ),
      envLogs: wranglerConfigErrors(
        file,
        configWith({
          env: {
            staging: {
              observability: {
                redact_query_string: true,
                logs: { invocation_logs: true },
              },
            },
          },
        })
      ),
    }).toStrictEqual({
      missing: [
        `${file}: set observability.logs.invocation_logs to false.`,
        `${file}: set observability.redact_query_string to true.`,
      ],
      envLogs: [
        `${file} (env staging): set observability.logs.invocation_logs to false.`,
      ],
    });
  });

  it("refuse a TOML config", () => {
    expect(
      wranglerConfigErrors("apps/example/wrangler.toml", 'name = "example"')
    ).toStrictEqual([
      "apps/example/wrangler.toml: use wrangler.jsonc, as every Worker here does.",
    ]);
  });
});
