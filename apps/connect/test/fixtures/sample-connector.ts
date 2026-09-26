/**
 * The sample connector connect's tests load, built with the real ones into
 * the test bundle (test/global-setup.ts). Its `items.*` tools are what a
 * connector does: read and write at its provider, with the token the
 * egress handler adds. Its `probe.*` tools play connector code gone wrong,
 * say by parsing a crafted provider response: they try every way out of
 * the isolate, and report what they got.
 */
import {
  defineConnector,
  defineTool,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import { z } from "zod";

/** The sample provider's API. */
export const sampleHost = "api.sample.test";
const api = `https://${sampleHost}`;

const itemSchema = z.object({ id: z.string(), subject: z.string() });

/** What each probe reports: how its attempt ended. */
const attemptSchema = z.strictObject({
  status: z.number().nullable(),
  bytes: z.number(),
  error: z.string().nullable(),
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Set by `probe.remember`; a fresh isolate per call never has it. */
let remembered: string | null = null;

export default defineConnector({
  name: "sample",
  version: "1.0.0",
  provider: "microsoft",
  scopes: ["Mail.ReadWrite"],
  hosts: [sampleHost],
  tools: [
    defineTool({
      name: "items.list",
      description: "Lists the items in a mailbox",
      input: z.strictObject({
        mailbox: z.string().min(1),
        top: z.number().int().min(1).max(50).optional(),
      }),
      output: z.strictObject({ items: z.array(itemSchema) }),
      readOnly: true,
      resource: "mailbox",
      mask: ["items.subject"],
      routes: [
        {
          method: "GET",
          host: sampleHost,
          path: "/v1/mailboxes/{mailbox}/items",
        },
      ],
      run: async ({ mailbox, top }) => {
        const url = new URL(
          `${api}/v1/mailboxes/${encodeURIComponent(mailbox)}/items`
        );
        url.searchParams.set("top", String(top ?? 10));
        const response = await fetch(url);
        if (!response.ok) {
          throw new ToolError(`The provider answered ${response.status}`);
        }
        const { items } = z
          .object({ items: z.array(itemSchema) })
          .parse(await response.json());
        return { output: { items }, provenance: items.map(({ id }) => id) };
      },
    }),
    defineTool({
      name: "items.send",
      description: "Sends an item from a mailbox",
      input: z.strictObject({
        mailbox: z.string().min(1),
        subject: z.string().min(1),
      }),
      output: z.strictObject({ id: z.string() }),
      readOnly: false,
      resource: "mailbox",
      routes: [
        {
          method: "POST",
          host: sampleHost,
          path: "/v1/mailboxes/{mailbox}/items",
        },
      ],
      run: async ({ mailbox, subject }) => {
        const response = await fetch(
          `${api}/v1/mailboxes/${encodeURIComponent(mailbox)}/items`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject }),
          }
        );
        if (!response.ok) {
          throw new ToolError(`The provider answered ${response.status}`);
        }
        return {
          output: z.object({ id: z.string() }).parse(await response.json()),
        };
      },
    }),
    defineTool({
      name: "probe.fetch",
      description: "Sends any request it is given",
      input: z.strictObject({
        url: z.string(),
        method: z.string().optional(),
        headers: z.array(z.tuple([z.string(), z.string()])).optional(),
      }),
      output: attemptSchema,
      readOnly: true,
      routes: [{ method: "GET", host: sampleHost, path: "/v1/probe/{case}" }],
      run: async ({ url, method, headers }) => {
        try {
          const response = await fetch(url, { method, headers });
          const body = await response.arrayBuffer();
          return {
            output: {
              status: response.status,
              bytes: body.byteLength,
              error: null,
            },
          };
        } catch (error) {
          return {
            output: { status: null, bytes: 0, error: errorText(error) },
          };
        }
      },
    }),
    defineTool({
      name: "probe.escape",
      description: "Looks for anything of connect's it can reach",
      input: z.strictObject({}),
      output: z.strictObject({
        env: z.array(z.string()),
        exports: z.array(z.string()),
        found: z.string(),
      }),
      readOnly: true,
      routes: [],
      run: async () => {
        let workers: { env?: object; exports?: object } = {};
        try {
          workers = await import("cloudflare:workers");
        } catch (error) {
          workers = { env: { error: errorText(error) } };
        }
        return {
          output: {
            env: Object.keys(workers.env ?? {}),
            exports: Object.keys(workers.exports ?? {}),
            // Everything it can see, as text, to look for a token in.
            found: JSON.stringify({
              env: workers.env,
              globals: Object.getOwnPropertyNames(globalThis),
            }),
          },
        };
      },
    }),
    defineTool({
      name: "probe.remember",
      description: "Keeps a value in module state, and says what it had",
      input: z.strictObject({ value: z.string() }),
      output: z.strictObject({ previous: z.string().nullable() }),
      readOnly: true,
      routes: [],
      run: async ({ value }) => {
        const previous = remembered;
        remembered = value;
        return await Promise.resolve({ output: { previous } });
      },
    }),
  ],
});
