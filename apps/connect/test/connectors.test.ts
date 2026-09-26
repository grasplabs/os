import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import bundled from "#connectors";

import { nativeConnector, nativeServer } from "../src/connectors.ts";
import { connections } from "../src/db/schema.ts";
import type { EgressProps } from "../src/egress.ts";
import { providers as providerConfigs } from "../src/providers.ts";
import { accessTokenFor } from "../src/tokens.ts";
import {
  agentFor,
  callAs,
  connectAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { sampleHost } from "./fixtures/sample-connector.ts";
import { fakeProviders } from "./oauth-provider.ts";
import type { ProviderName } from "./oauth-provider.ts";
import { fakeSampleApi } from "./sample-api.ts";

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

/** Calls `action` on the connection as an agent acting for its owner. */
const call = async (
  connection: { id: string; person: ConnectionPerson },
  action: string,
  input: Call["input"],
  extra: Partial<Call> = {}
) =>
  await callAs(agentFor(connection.person.userId), {
    connectionId: connection.id,
    action,
    input,
    ...extra,
  });

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
  input: { url: string; method?: string; headers?: [string, string][] }
): Promise<Attempt> => {
  const { output } = await call(connection, "probe.fetch", input);
  const attempt: unknown = JSON.parse(output);
  if (!isAttempt(attempt)) {
    throw new TypeError("Not a probe's report");
  }
  return attempt;
};

/** A probe's report of a request the egress handler refused. */
const refused = { status: 403, error: null };

/** The output an `action_failed` error carries, as JSON text. */
const failedOutput = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (
      connectErrors.codeOf(error) === "connect.action_failed" &&
      error instanceof Error &&
      "details" in error
    ) {
      return JSON.stringify(error.details);
    }
    throw error;
  }
  throw new Error("The call didn't fail");
};

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

  it("loads in well under a second", async () => {
    const connection = await connectionTo("sample");
    const started = Date.now();
    await call(connection, "items.list", { mailbox: "invoices@acme.test" });
    expect(Date.now() - started).toBeLessThan(1000);
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
      { url: `https://${sampleHost}/v1/probe/ok`, method: "POST" },
      { url: `https://${sampleHost}/v1/probe/ok`, method: "DELETE" },
      // Another action's route.
      { url: `https://${sampleHost}/v1/mailboxes/ceo%40acme.test/items` },
      { url: `https://${sampleHost}/v1/probe/ok/more` },
      { url: `https://${sampleHost}/v1/probe/` },
      { url: `https://${sampleHost}/V1/probe/ok` },
      { url: `https://${sampleHost}/v1/probe/..%2Fmailboxes` },
      { url: `https://${sampleHost}/v1/probe/%2e%2e/mailboxes` },
      { url: `https://${sampleHost}/v1/probe/..%5Cadmin` },
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
    expect(api.sent).toMatchObject([{ path: "/v1/probe/ok?page=2" }]);
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

  it("can't read a response past the size limit", async () => {
    const connection = await connectionTo("sample");
    const flooded = await probe(connection, {
      url: `https://${sampleHost}/v1/probe/flood`,
    });
    expect(flooded.status).toBeNull();
    expect(flooded.error).not.toBeNull();
    await expect(
      probe(connection, {
        url: `https://${sampleHost}/v1/probe/flood-declared`,
      })
    ).resolves.toMatchObject({ status: 502, bytes: 0 });
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
    const lines = logged.join("\n");
    expect(lines).toContain(sampleHost);
    expect(lines).toContain("/v1/mailboxes/{mailbox}/items");
    expect(lines).toContain("egress.refused");
    expect(lines).not.toContain(token);
    expect(lines).not.toContain("invoice");
  });
});

/** Props for the egress handler, as connect sets them for one call. */
const egressProps = (fields: Partial<EgressProps> = {}): EgressProps => ({
  connector: "sample@1.0.0",
  hosts: [sampleHost],
  routes: [{ method: "GET", host: sampleHost, path: "/v1/probe/{case}" }],
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

const connectionRow = async (id: string) => {
  const row = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .get();
  if (row === undefined) {
    throw new Error(`No connection ${id}`);
  }
  return row;
};

describe("every native tool", () => {
  it.each(tools)(
    "$connector $action refuses a second resource selector",
    async ({ connector, provider, action }) => {
      const connection = await connectionTo(connector, provider);
      const server = await nativeServer(
        env,
        await connectionRow(connection.id),
        action
      );
      const tool = await server.tool(action);
      const field = tool?.resourceField ?? "mailbox";
      const declared = new Set(tool?.inputProperties);
      const extra = [`shared${field}`, "target", "userId"].filter(
        (key) => !declared.has(key)
      );
      const inputs = [
        { [field]: "a@acme.test", [extra[0] ?? "x"]: "b@acme.test" },
        {
          [field]: "a@acme.test",
          [extra[1] ?? "y"]: { [field]: "b@acme.test" },
        },
        { [field]: "a@acme.test", [extra[2] ?? "z"]: "b@acme.test" },
      ];
      for (const input of inputs) {
        // oxlint-disable-next-line no-await-in-loop -- one attempt after another
        await expect(
          failedOutput(
            call(connection, action, input, {
              idempotencyKey: crypto.randomUUID(),
            })
          )
        ).resolves.toContain("unrecognized_keys");
      }
      expect(api.sent).toStrictEqual([]);
    }
  );
});
