import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import bundled from "#connectors";

import { nativeConnector } from "../src/connectors.ts";
import { connections, connectionTokens } from "../src/db/schema.ts";
import type { EgressProps } from "../src/egress.ts";
import { providers as providerConfigs } from "../src/providers.ts";
import { accessTokenFor } from "../src/tokens.ts";
import {
  agentFor,
  callAs,
  chatOrigin,
  connectAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { sampleHost, storageHost } from "./fixtures/sample-connector.ts";
import { fakeProviders } from "./oauth-provider.ts";
import type { ProviderName } from "./oauth-provider.ts";
import { fakeSampleApi } from "./sample-api.ts";
import { callTool as call, toolError } from "./tool-calls.ts";

// Native connectors run in isolates of their own, and reach their provider
// only through connect's egress handler, which adds the connection's token.
// The ways that could fail come first (threat model R1, R9, Q11, EG1 to
// EG7): connector code reaching a host its manifest doesn't list, or a
// method or path its action doesn't declare; reading the token, connect's
// env or anything else of connect's; sending another connection's token;
// following a redirect elsewhere; setting its own credentials; reading a
// response too large to hold; keeping state from one call for the next.
// The sample connector's `probe.*` tools make each attempt from inside the
// isolate, as connector code gone wrong would.

const providers = fakeProviders();
const api = fakeSampleApi();

/** A person's own Microsoft account, connected to `server`. */
const connectionTo = async (
  server: string,
  provider: ProviderName = "microsoft",
  person: ConnectionPerson = someone()
): Promise<{ id: string; person: ConnectionPerson }> => {
  const id = await connectAccount(
    providers,
    person,
    ownAccount(person, provider)
  );
  await drizzle(env.DB)
    .update(connections)
    .set({ server })
    .where(eq(connections.id, id));
  return { id, person };
};

/** What a probe reports about its attempt. */
interface Attempt {
  status: number | null;
  bytes: number;
  error: string | null;
}

const isAttempt = (value: unknown): value is Attempt =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  "bytes" in value &&
  "error" in value;

/** Has the sample connector's code send a request, and says how it went. */
const probe = async (
  connection: { id: string; person: ConnectionPerson },
  input: {
    url: string;
    method?: string;
    headers?: [string, string][];
    mailbox?: string;
  },
  extra: Partial<Call> = {}
): Promise<Attempt> => {
  const tool = input.mailbox === undefined ? "probe.fetch" : "probe.mailbox";
  const { output } = await call(connection, tool, input, extra);
  const attempt: unknown = JSON.parse(output);
  if (!isAttempt(attempt)) {
    throw new TypeError("Not a probe's report");
  }
  return attempt;
};

/** A probe's report of a request the egress handler refused. */
const refused = { status: 403, error: null };

describe("a native connector", () => {
  it("calls its provider through the egress handler, with the connection's token", async () => {
    const connection = await connectionTo("sample");
    const token = await accessTokenFor(env, connection.id);
    const result = await call(connection, "items.list", {
      mailbox: "invoices@acme.test",
    });
    expect(JSON.parse(result.output)).toStrictEqual({
      items: [{ id: "invoices@acme.test/item-1", subject: "Invoice" }],
    });
    expect(result.provenance).toStrictEqual(["invoices@acme.test/item-1"]);
    expect(api.sent).toMatchObject([
      {
        method: "GET",
        host: sampleHost,
        path: "/v1/mailboxes/invoices%40acme.test/items?top=10",
        headers: { authorization: `Bearer ${token}` },
      },
    ]);
  });

  it("carries out a side effect once for its idempotency key", async () => {
    const connection = await connectionTo("sample");
    const send = async () =>
      await call(
        connection,
        "items.send",
        { mailbox: "invoices@acme.test", subject: "Paid" },
        { idempotencyKey: "run-1:send" }
      );
    const first = await send();
    await expect(send()).resolves.toStrictEqual(first);
    expect(
      api.sent.map(({ method, body }) => ({ method, body }))
    ).toStrictEqual([{ method: "POST", body: '{"subject":"Paid"}' }]);
  });

  it("reads for a restricted context, and holds its side effects before any token is read", async () => {
    const connection = await connectionTo("sample");
    // Any read of this token now refreshes it at the provider.
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ accessExpiresAt: new Date(Date.now() + 1000) })
      .where(eq(connectionTokens.connectionId, connection.id));
    const restricted = { restricted: true, origin: chatOrigin };
    const agent = agentFor(connection.person.userId);
    const mailbox = "invoices@acme.test";
    const held = await Promise.all([
      outcome(
        callAs(
          agent,
          {
            connectionId: connection.id,
            action: "items.send",
            input: { mailbox, subject: "Payroll" },
            idempotencyKey: "run-1:send",
          },
          restricted
        )
      ),
      outcome(
        callAs(
          agentFor(connection.person.userId, "agent-chat", "interactive"),
          {
            connectionId: connection.id,
            action: "items.send",
            input: { mailbox, subject: "Payroll" },
            idempotencyKey: "chat-1:send",
          },
          restricted
        )
      ),
    ]);
    expect({
      held,
      refreshed: providers.tokenRequests("refresh_token"),
      sent: api.sent,
    }).toStrictEqual({
      // A run's fails retryably; chat's comes back as held.
      held: ["connect.held", "ok"],
      refreshed: [],
      sent: [],
    });
    // A read the connector declares still goes out.
    const read = await callAs(
      agent,
      { connectionId: connection.id, action: "items.list", input: { mailbox } },
      restricted
    );
    expect(JSON.parse(read.output)).toStrictEqual({
      items: [{ id: `${mailbox}/item-1`, subject: "Invoice" }],
    });
  });

  it("that says its provider rate limited it frees its key, so a retry writes once", async () => {
    const connection = await connectionTo("sample");
    const send = async () =>
      await outcome(
        call(
          connection,
          "items.send",
          { mailbox: "invoices@acme.test", subject: "Paid" },
          { idempotencyKey: "run-1:send" }
        )
      );
    api.rateLimited = 1;
    const outcomes = [await send(), await send(), await send()];
    expect({ outcomes, written: api.written }).toStrictEqual({
      // Retryable, then carried out, then the stored answer.
      outcomes: ["connect.server_unavailable", "ok", "ok"],
      written: 1,
    });
  });

  it("that says a read failed for a passing cause lets it be retried", async () => {
    const connection = await connectionTo("sample");
    const list = async () =>
      await outcome(
        call(connection, "items.list", { mailbox: "invoices@acme.test" })
      );
    api.failingReads = 1;
    const outcomes = [await list(), await list()];
    expect(outcomes).toStrictEqual(["connect.server_unavailable", "ok"]);
  });

  it("masks a repeated side effect's answer as the repeat's capability says", async () => {
    const connection = await connectionTo("sample");
    const stated = {
      connectionId: connection.id,
      action: "items.send",
      input: { mailbox: "invoices@acme.test", subject: "Paid" },
      idempotencyKey: "run-2:send",
    };
    const send = async (mask: string[]): Promise<unknown> => {
      const { output } = await callAs(
        agentFor(connection.person.userId),
        stated,
        { mask }
      );
      const parsed: unknown = JSON.parse(output);
      return parsed;
    };
    await expect(send([])).resolves.toMatchObject({ subject: "Paid" });
    await expect(send(["subject"])).resolves.toMatchObject({ subject: null });
    // A mask connect can't apply is refused before any repeat is answered.
    await expect(outcome(send(["nonsense"]))).resolves.toBe(
      "connect.mask_unsupported"
    );
    expect(api.sent.map(({ method }) => method)).toStrictEqual(["POST"]);
  });

  it("is held to the resource its capability names", async () => {
    const connection = await connectionTo("sample");
    await expect(
      call(
        connection,
        "items.list",
        { mailbox: "invoices@acme.test" },
        { resource: "invoices@acme.test" }
      )
    ).resolves.toMatchObject({ provenance: ["invoices@acme.test/item-1"] });
    await expect(
      outcome(
        call(
          connection,
          "items.list",
          { mailbox: "ceo@acme.test" },
          { resource: "invoices@acme.test" }
        )
      )
    ).resolves.toBe("connect.resource_out_of_scope");
    expect(api.sent).toHaveLength(1);
  });

  it("loads in a few seconds at most, even on a slow machine", async () => {
    const connection = await connectionTo("sample");
    const started = Date.now();
    await call(connection, "items.list", { mailbox: "invoices@acme.test" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reads no token for a call it refuses or holds", async () => {
    const connection = await connectionTo("sample");
    const google = await connectionTo("sample", "google");
    // Any read of these tokens now refreshes them at the provider.
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ accessExpiresAt: new Date(Date.now() + 1000) });
    const chat = agentFor(
      connection.person.userId,
      "agent-chat",
      "interactive"
    );
    const refusals = await Promise.all([
      outcome(
        call(
          connection,
          "items.list",
          { mailbox: "ceo@acme.test" },
          { resource: "invoices@acme.test" }
        )
      ),
      outcome(
        callAs(chat, {
          connectionId: connection.id,
          action: "items.send",
          input: { mailbox: "invoices@acme.test", subject: "Paid" },
          idempotencyKey: "chat-1:send",
        })
      ),
      // Held for the person to confirm: nothing is sent yet.
      outcome(
        callAs(
          chat,
          {
            connectionId: connection.id,
            action: "items.send",
            input: { mailbox: "invoices@acme.test", subject: "Paid" },
            idempotencyKey: "chat-2:send",
          },
          { origin: chatOrigin }
        )
      ),
      outcome(
        call(connection, "items.send", {
          mailbox: "invoices@acme.test",
          subject: "Paid",
        })
      ),
      outcome(call(connection, "items.delete", { mailbox: "a@acme.test" })),
      outcome(call(google, "items.list", { mailbox: "a@acme.test" })),
    ]);
    expect(refusals).toStrictEqual([
      "connect.resource_out_of_scope",
      "connect.confirmation_required",
      "ok",
      "connect.idempotency_key_required",
      "connect.action_not_found",
      "connect.server_unavailable",
    ]);
    expect(providers.tokenRequests("refresh_token")).toStrictEqual([]);
    // A call that passes reads (and so refreshes) the token.
    await call(connection, "items.list", { mailbox: "invoices@acme.test" });
    expect(providers.tokenRequests("refresh_token")).toHaveLength(1);
  });

  it("isn't loaded for a connector this release doesn't have", async () => {
    const connection = await connectionTo("no-such-connector");
    await expect(
      outcome(call(connection, "items.list", { mailbox: "a@acme.test" }))
    ).resolves.toBe("connect.server_unavailable");
    expect(api.sent).toStrictEqual([]);
  });

  it("never gets another provider's token", async () => {
    // The sample connector is Microsoft's; this connection holds Google's.
    const connection = await connectionTo("sample", "google");
    await expect(
      outcome(call(connection, "items.list", { mailbox: "a@acme.test" }))
    ).resolves.toBe("connect.server_unavailable");
    expect(api.sent).toStrictEqual([]);
  });

  it("isn't loaded for an action it doesn't declare", async () => {
    const connection = await connectionTo("sample");
    await expect(
      outcome(call(connection, "Items.List", { mailbox: "a@acme.test" }))
    ).resolves.toBe("connect.action_not_found");
    expect(api.sent).toStrictEqual([]);
  });

  it("is what each provider's connections run, with the scopes connect asks for", () => {
    for (const config of Object.values(providerConfigs)) {
      const connector = nativeConnector(config.server);
      expect(connector?.manifest.provider).toBe(config.id);
      expect(config.scopes).toStrictEqual(
        expect.arrayContaining([...(connector?.manifest.scopes ?? [])])
      );
    }
  });
});

describe("a connector's code", () => {
  it("reaches no host its manifest doesn't list", async () => {
    const connection = await connectionTo("sample");
    const urls = [
      "https://evil.test/v1/probe/ok",
      `https://${sampleHost}.evil.test/v1/probe/ok`,
      "https://sample.test/v1/probe/ok",
      `http://${sampleHost}/v1/probe/ok`,
      `https://${sampleHost}:8443/v1/probe/ok`,
      "https://169.254.169.254/v1/probe/ok",
      "https://127.0.0.1/v1/probe/ok",
      "https://[::1]/v1/probe/ok",
    ];
    for (const url of urls) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      await expect(probe(connection, { url })).resolves.toMatchObject(refused);
    }
    expect(api.sent).toStrictEqual([]);
  });

  it("sends only the method and path its action declares", async () => {
    const connection = await connectionTo("sample");
    const attempts = [
      { url: `https://${sampleHost}/v1/probe/ok`, method: "PUT" },
      { url: `https://${sampleHost}/v1/probe/ok`, method: "DELETE" },
      // Another action's route.
      {
        url: `https://${sampleHost}/v1/mailboxes/ceo%40acme.test/items`,
        method: "POST",
      },
      { url: `https://${sampleHost}/v1/probe/ok/more` },
      { url: `https://${sampleHost}/v1/probe/` },
      { url: `https://${sampleHost}/V1/probe/ok` },
      // Parameters that decode to more than one plain segment.
      ...[
        "..%2Fmailboxes",
        "%2e%2e/mailboxes",
        "..%5Cadmin",
        "%252e%252e%252f",
        "a%00b",
        "a%0D%0Ab",
        "..;",
        "a;x=y",
        "a%3Fb",
        "a%23b",
        "a%3Ab",
        "ok:poke",
        "batch",
        "%24BATCH",
      ].map((segment) => ({
        url: `https://${sampleHost}/v1/probe/${segment}`,
      })),
      // A literal suffix is the declared one, as declared.
      { url: `https://${sampleHost}/v1/probe/item-1:poke` },
      { url: `https://${sampleHost}/v1/probe/item-1%3Apeek` },
      { url: `https://${sampleHost}/v1/probe/:peek` },
    ];
    for (const attempt of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      await expect(probe(connection, attempt)).resolves.toMatchObject(refused);
    }
    expect(api.sent).toStrictEqual([]);
    // What it declares goes out, with its query.
    await expect(
      probe(connection, { url: `https://${sampleHost}/v1/probe/ok?page=2` })
    ).resolves.toStrictEqual({ status: 200, bytes: 2, error: null });
    await probe(connection, {
      url: `https://${sampleHost}/v1/probe/item-1:peek`,
    });
    expect(api.sent.map(({ path }) => path)).toStrictEqual([
      "/v1/probe/ok?page=2",
      "/v1/probe/item-1:peek",
    ]);
  });

  it("reaches only the resource its capability names", async () => {
    const connection = await connectionTo("sample");
    const scoped = async (mailbox: string) =>
      await probe(
        connection,
        {
          mailbox: "invoices@acme.test",
          url: `https://${sampleHost}/v1/mailboxes/${mailbox}/items`,
        },
        { resource: "invoices@acme.test" }
      );
    await expect(scoped("ceo%40acme.test")).resolves.toMatchObject(refused);
    expect(api.sent).toStrictEqual([]);
    await expect(scoped("invoices%40acme.test")).resolves.toMatchObject({
      status: 200,
    });
    expect(api.sent).toHaveLength(1);
  });

  it("can't override the method its action declares", async () => {
    const connection = await connectionTo("sample");
    await probe(connection, {
      url: `https://${sampleHost}/v1/probe/ok`,
      method: "POST",
      headers: [
        ["x-http-method-override", "DELETE"],
        ["x-http-method", "DELETE"],
        ["x-method-override", "DELETE"],
        ["te", "trailers"],
      ],
    });
    expect(api.sent).toHaveLength(1);
    for (const name of [
      "x-http-method-override",
      "x-http-method",
      "x-method-override",
      "te",
    ]) {
      expect(api.sent[0]?.headers).not.toHaveProperty(name);
    }
  });

  it("opens no raw socket", async () => {
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(JSON.stringify(args));
    });
    const connection = await connectionTo("sample");
    const { output } = await call(connection, "probe.socket", {});
    // `opened` may resolve first; the first write or read fails.
    const { error } = z
      .object({ error: z.string().nullable() })
      .parse(JSON.parse(output));
    expect(error).not.toBeNull();
    expect(warned.join("\n")).toMatch(/egress\.refused.*socket/u);
  });

  it("keeps nothing in the Cache API", async () => {
    const connection = await connectionTo("sample");
    const { output } = await call(connection, "probe.cache", {});
    expect(JSON.parse(output)).toMatchObject({ kept: false });
  });

  it("can't read the token, connect's env or anything else of connect's", async () => {
    const connection = await connectionTo("sample");
    const token = await accessTokenFor(env, connection.id);
    const { output } = await call(connection, "probe.escape", {});
    expect(JSON.parse(output)).toMatchObject({ env: [] });
    expect(output).not.toContain(token);
    expect(output).not.toContain("ConnectorEgress");
    expect(output).not.toContain("CAPABILITY_SIGNING_KEY");
    expect(output).not.toContain("TOKEN_ENCRYPTION_KEY");
  });

  it("can't set credentials or headers of its own in place of connect's", async () => {
    const connection = await connectionTo("sample");
    const token = await accessTokenFor(env, connection.id);
    await probe(connection, {
      url: `https://${sampleHost}/v1/probe/ok`,
      headers: [
        ["authorization", "Bearer the-connectors-own"],
        ["proxy-authorization", "Basic c2VjcmV0"],
        ["cookie", "session=stolen"],
      ],
    });
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(api.sent[0]?.headers).not.toHaveProperty("cookie");
    expect(api.sent[0]?.headers).not.toHaveProperty("proxy-authorization");
  });

  it("can't smuggle a header into another", async () => {
    const connection = await connectionTo("sample");
    const attempt = await probe(connection, {
      url: `https://${sampleHost}/v1/probe/ok`,
      headers: [["x-note", "a\r\nauthorization: Bearer the-connectors-own"]],
    });
    expect(attempt.status).toBeNull();
    expect(attempt.error).not.toBeNull();
    expect(api.sent).toStrictEqual([]);
  });

  it("sends each call's own connection's token, never another's", async () => {
    const [anna, ben] = await Promise.all([
      connectionTo("sample"),
      connectionTo("sample"),
    ]);
    const tokens = await Promise.all(
      [anna, ben].map(async ({ id }) => await accessTokenFor(env, id))
    );
    expect(tokens[0]).not.toBe(tokens[1]);
    await Promise.all([
      call(anna, "items.list", { mailbox: "anna@acme.test" }),
      call(ben, "items.list", { mailbox: "ben@acme.test" }),
      call(anna, "items.list", { mailbox: "anna@acme.test" }),
      call(ben, "items.list", { mailbox: "ben@acme.test" }),
    ]);
    const tokenFor = (mailbox: string) =>
      api.sent
        .filter(({ path }) => path.includes(encodeURIComponent(mailbox)))
        .map(({ headers }) => headers.authorization);
    expect(tokenFor("anna@acme.test")).toStrictEqual([
      `Bearer ${tokens[0]}`,
      `Bearer ${tokens[0]}`,
    ]);
    expect(tokenFor("ben@acme.test")).toStrictEqual([
      `Bearer ${tokens[1]}`,
      `Bearer ${tokens[1]}`,
    ]);
  });

  it("follows no redirect, to another host or its own", async () => {
    const connection = await connectionTo("sample");
    for (const path of ["redirect", "redirect-here"]) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      await expect(
        probe(connection, { url: `https://${sampleHost}/v1/probe/${path}` })
      ).resolves.toMatchObject({ status: 502 });
    }
    expect(api.sent.map(({ host }) => host)).toStrictEqual([
      sampleHost,
      sampleHost,
    ]);
  });

  it("follows a download's redirect to its route's storage hosts, once, with nothing of its request", async () => {
    const connection = await connectionTo("sample");
    const download = async (name: string): Promise<unknown> => {
      const { output } = await call(connection, "probe.download", {
        url: `https://${sampleHost}/v1/downloads/${name}`,
        headers: [
          ["x-note", "invoice-4200"],
          ["authorization", "Bearer the-connectors-own"],
          ["cookie", "session=stolen"],
          ["range", "bytes=0-10"],
        ],
      });
      const attempt: unknown = JSON.parse(output);
      return attempt;
    };
    await expect(download("file")).resolves.toStrictEqual({
      status: 200,
      bytes: 4,
      error: null,
    });
    // Any of the route's storage hosts, whatever the deployment's config
    // (DOWNLOAD_HOSTS, no longer read, names only another).
    await expect(download("others")).resolves.toMatchObject({ status: 200 });
    // Another host, and a second redirect: each withheld.
    const withheld = await Promise.all(["elsewhere", "again"].map(download));
    expect(withheld).toMatchObject([{ status: 502 }, { status: 502 }]);
    const followed = api.sent.filter(({ host }) => host !== sampleHost);
    expect(
      followed.map(({ host, path }) => `${host}${path}`).toSorted()
    ).toStrictEqual(
      [
        `${storageHost}/file`,
        "others.storage.test/file",
        `${storageHost}/again`,
      ].toSorted()
    );
    // Neither the token nor any header of the connector's went there.
    expect(followed.map(({ headers }) => Object.keys(headers))).toStrictEqual([
      [],
      [],
      [],
    ]);
  });

  it("can't read a download past the size limit, after its redirect", async () => {
    const connection = await connectionTo("sample");
    const { output } = await call(connection, "probe.download", {
      url: `https://${sampleHost}/v1/downloads/flood`,
    });
    expect(JSON.parse(output)).toMatchObject({ status: null, bytes: 0 });
    expect(JSON.parse(output)).not.toMatchObject({ error: null });
  });

  it("can't read a response past the size limit", async () => {
    const connection = await connectionTo("sample");
    // Counted on the bytes that arrive, whether or not their length is
    // declared up front.
    for (const path of ["flood", "flood-declared"]) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      const flooded = await probe(connection, {
        url: `https://${sampleHost}/v1/probe/${path}`,
      });
      expect(flooded).toMatchObject({ status: null, bytes: 0 });
      expect(flooded.error).not.toBeNull();
    }
    // A response with no body passes, whatever length it claims.
    await expect(
      probe(connection, { url: `https://${sampleHost}/v1/probe/empty` })
    ).resolves.toMatchObject({ status: 204, bytes: 0 });
  });

  it("keeps nothing from one call for the next", async () => {
    const connection = await connectionTo("sample");
    const remember = async (value: string): Promise<unknown> => {
      const { output } = await call(connection, "probe.remember", { value });
      const remembered: unknown = JSON.parse(output);
      return remembered;
    };
    await expect(remember("anna's data")).resolves.toStrictEqual({
      previous: null,
    });
    await expect(remember("ben's data")).resolves.toStrictEqual({
      previous: null,
    });
  });

  it("gets its requests logged by host, method and declared path, never the token", async () => {
    const logged: string[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
    const connection = await connectionTo("sample");
    const token = await accessTokenFor(env, connection.id);
    await call(connection, "items.list", { mailbox: "invoices@acme.test" });
    // Data spelled into a host or method it made up stays out of the logs.
    await probe(connection, {
      url: "https://invoice-total-4200.evil.test/v1/probe/ok",
    });
    await probe(connection, {
      url: `https://${sampleHost}/v1/probe/ok`,
      method: "INVOICE-4200",
    });
    await call(connection, "probe.socket", {});
    const lines = logged.join("\n");
    expect(lines).toMatch(
      /egress\.request.*callId.*api\.sample\.test.*\/v1\/mailboxes\/\{mailbox\}\/items/u
    );
    expect(lines).toMatch(/egress\.refused.*callId.*socket/u);
    expect(lines).not.toContain(token);
    expect(lines).not.toContain("invoice");
  });
});

/** Props for the egress handler, as connect sets them for one call. */
const egressProps = (fields: Partial<EgressProps> = {}): EgressProps => ({
  connector: "sample@1.0.0",
  callId: "call-1",
  hosts: [sampleHost],
  routes: [{ method: "GET", host: sampleHost, path: "/v1/probe/{case}" }],
  values: {},
  token: "a-token-for-one-call",
  expiresAt: Date.now() + 30_000,
  ...fields,
});

describe("the egress handler", () => {
  const url = `https://${sampleHost}/v1/probe/ok`;

  it("sends nothing for a caller without a whole call's props", async () => {
    // As another Worker naming this entrypoint gets it: no call behind it.
    for (const props of [
      egressProps({ token: "" }),
      egressProps({ hosts: [] }),
      egressProps({ expiresAt: Number.NaN }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt after another
      const response = await exports.ConnectorEgress({ props }).fetch(url);
      expect(response.status).toBe(403);
    }
    expect(api.sent).toStrictEqual([]);
  });

  it("closes when the call's time is up", async () => {
    const egress = exports.ConnectorEgress({
      props: egressProps({ expiresAt: Date.now() - 1 }),
    });
    await expect(egress.fetch(url)).resolves.toMatchObject({ status: 403 });
    expect(api.sent).toStrictEqual([]);
  });
});

// The connector contract: a tool may select a resource by its one declared
// property only, and parses its input strictly, so no second selector, at
// the top or nested, gets past it. Connect sees only top-level keys; the
// connector refuses the rest itself, before anything goes out.
const tools = bundled.flatMap(({ manifest }) => {
  const { name, provider, actions } = connectorManifestSchema.parse(manifest);
  return Object.keys(actions).map((action) => ({
    connector: name,
    provider,
    action,
  }));
});

describe("every native tool", () => {
  it.each(tools)(
    "$connector $action refuses a second resource selector",
    async ({ connector, provider, action }) => {
      const connection = await connectionTo(connector, provider);
      const manifest = nativeConnector(connector)?.manifest;
      const tool = manifest?.actions[action];
      const field = tool?.resource ?? "mailbox";
      const declared = new Set(tool?.input);
      const extra = [`shared${field}`, "target", "userId"].filter(
        (key) => !declared.has(key)
      );
      const undeclared = [
        { [field]: "a@acme.test", [extra[0] ?? "x"]: "b@acme.test" },
        {
          [field]: "a@acme.test",
          [extra[1] ?? "y"]: { [field]: "b@acme.test" },
        },
        { [field]: "a@acme.test", [extra[2] ?? "z"]: "b@acme.test" },
      ];
      // Nor nested under a property it does declare.
      const nested = [...declared]
        .filter((other) => other !== field)
        .map((other) => ({
          [field]: "a@acme.test",
          [other]: { [field]: "b@acme.test" },
        }));
      const refusals = await Promise.all(
        [...undeclared, ...nested].map(
          async (input) =>
            await toolError(
              call(connection, action, input, {
                idempotencyKey: crypto.randomUUID(),
              })
            )
        )
      );
      expect(
        refusals
          .slice(0, undeclared.length)
          .every((text) => String(text).includes("unrecognized_keys"))
      ).toBeTruthy();
      expect(
        refusals
          .slice(undeclared.length)
          .every((text) => String(text).includes("Invalid input"))
      ).toBeTruthy();
      expect(api.sent).toStrictEqual([]);
    }
  );
});
