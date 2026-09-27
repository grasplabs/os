import { composioConsentText } from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  StartToolkitConnection,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { startToolkitConnection } from "../src/composio-connections.ts";
import { composioServer } from "../src/connections.ts";
import { connections } from "../src/db/schema.ts";
import { fakeComposioApi } from "./composio-api.ts";
import {
  agentFor,
  auditEvents,
  callAs,
  clientOrigin,
  outcome,
  someone,
} from "./connect.ts";

// Connecting a Composio toolkit: an admin consents to Composio holding its
// tokens, connects at Composio's auth link, and comes back with one shared
// connection, to an MCP server Composio made for that toolkit's auth
// config, that one account and only the tools the admin allowed. Calls on
// it reach only those tools, with connect's key; its consent is in the
// audit log with who gave it; and whatever didn't finish is deleted at
// Composio again.

const contacts = ["contact-1", "contact-2"];

const composio = fakeComposioApi(
  [
    {
      slug: "hubspot",
      name: "HubSpot",
      tools: [
        { slug: "HUBSPOT_LIST_CONTACTS" },
        { slug: "HUBSPOT_CREATE_CONTACT" },
        { slug: "HUBSPOT_DELETE_CONTACT" },
      ],
    },
  ],
  {
    mcpTools: [
      {
        name: "HUBSPOT_LIST_CONTACTS",
        // As Composio's tools do: naming no resources read.
        run: () => ({ output: { contacts } }),
      },
      {
        name: "HUBSPOT_CREATE_CONTACT",
        run: () => ({ output: { id: "contact-3" } }),
      },
      {
        name: "HUBSPOT_DELETE_CONTACT",
        run: () => ({ output: { deleted: true } }),
      },
    ],
  }
);

const { events } = auditEvents();

const allowed = ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_CONTACT"];

/** A call of `action` on `connectionId`, with a fresh idempotency key. */
const call = (connectionId: string, action: string) => ({
  connectionId,
  action,
  input: {},
  idempotencyKey: crypto.randomUUID(),
});

type Start = Omit<StartToolkitConnection, "person">;

/** Starts connecting HubSpot for `person`, as core does. */
const start = async (
  person: ConnectionPerson,
  options: Partial<Start> = {}
): Promise<string> => {
  const { url } = await exports.default.startToolkitConnection({
    person,
    composio: true,
    toolkit: "hubspot",
    tools: allowed,
    consent: composioConsentText,
    origin: clientOrigin,
    returnTo: "/connections",
    ...options,
  });
  return url;
};

/** Composio sending `person`'s browser back to core with the flow's state. */
const back = async (
  person: ConnectionPerson,
  state: string,
  composioOn = true
) =>
  await exports.default.finishConnection({
    person,
    state,
    composio: composioOn,
  });

/** Connects HubSpot end to end for the admin `person`. */
const connectHubSpot = async (person: ConnectionPerson): Promise<string> => {
  const { state } = composio.authorize(await start(person));
  const { connectionId } = await back(person, state);
  return connectionId;
};

/** The connection as connect's registry holds it. */
const stored = async (connectionId: string) =>
  await env.DB.prepare(
    "SELECT provider, scope, server_kind AS serverKind, server, account_id AS accountId, composio_server_id AS serverId, tools FROM connections WHERE id = ?"
  )
    .bind(connectionId)
    .first<{
      provider: string;
      scope: string;
      serverKind: string;
      server: string;
      accountId: string;
      serverId: string;
      tools: string;
    }>();

/** What connect made at Composio and didn't delete. */
const heldAtComposio = () => ({
  authConfigs: composio.state.holds.authConfigs.size,
  accounts: composio.state.holds.accounts.size,
  servers: composio.state.holds.servers.size,
});

/** Writes connect asked Composio for (anything but reading). */
const composioWrites = () =>
  composio.state.requests.filter(({ method }) => method !== "GET");

describe("connecting a Composio toolkit", () => {
  it("sends the admin to Composio's auth link, to come back to this deployment's callback", async () => {
    const admin = someone("admin");
    const url = await start(admin);
    const [account] = composio.state.holds.accounts.values();
    const callback = new URL(account?.callbackUrl ?? "");
    expect(url).toBe(account?.redirectUrl);
    expect(`${callback.origin}${callback.pathname}`).toBe(
      `${clientOrigin}/api/connections/callback`
    );
    // This deployment's one Composio user, and Composio's own app.
    expect(account?.userId).toBe(new URL(clientOrigin).host);
    expect([...composio.state.holds.authConfigs.values()]).toStrictEqual([
      { toolkit: "hubspot", managed: true },
    ]);
  });

  it("makes one shared connection, to a server scoped to its auth config, its account and the allowed tools", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const { servers, accounts } = composio.state.holds;
    const [serverId = ""] = servers.keys();
    const [accountId = ""] = accounts.keys();
    const server = servers.get(serverId);
    const account = accounts.get(accountId);
    await expect(stored(connectionId)).resolves.toStrictEqual({
      provider: "hubspot",
      scope: "shared",
      serverKind: "composio",
      server: `https://backend.composio.dev/v3/mcp/${serverId}?connected_account_id=${accountId}`,
      accountId,
      serverId,
      tools: JSON.stringify(allowed),
    });
    expect(server).toMatchObject({
      authConfigIds: [account?.authConfigId],
      allowedTools: allowed,
    });
    const listed = await exports.default.listConnections(someone());
    expect(listed.find(({ id }) => id === connectionId)).toMatchObject({
      source: "composio",
      provider: "hubspot",
      scope: "shared",
      connectedBy: admin.userId,
    });
  });

  it("records the admin's consent, with who gave it, then the connection", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    const consented = await events();
    const { connectionId } = await back(admin, state);
    const all = await events();
    expect(consented.map(({ action }) => action)).toStrictEqual([
      "connection.consent",
    ]);
    expect(consented[0]).toMatchObject({
      actor: { type: "person", userId: admin.userId },
      action: "connection.consent",
      detail: {
        provider: "hubspot",
        scope: "shared",
        outcome: "ok",
        tokenHolder: "composio",
        consentHash: await sha256Hex(composioConsentText),
        toolCount: allowed.length,
      },
    });
    expect(all.at(-1)).toMatchObject({
      actor: { type: "person", userId: admin.userId },
      action: "connection.connect",
      target: { type: "connection", id: connectionId },
      detail: { provider: "hubspot", outcome: "ok", tokenHolder: "composio" },
    });
  });

  it("is only for admins, never Grasp staff, and asks Composio nothing for anyone else", async () => {
    const people = [someone("user"), { ...someone("admin"), staff: true }];
    const ends = await Promise.all(
      people.map(async (person) => await outcome(start(person)))
    );
    expect(ends).toStrictEqual([
      "role.forbidden",
      "connection.staff_not_allowed",
    ]);
    expect(composio.state.requests).toStrictEqual([]);
    const refused = await events();
    expect(
      refused.map(({ action, detail }) => [action, detail.reason])
    ).toStrictEqual([
      ["connection.connect", "role.forbidden"],
      ["connection.connect", "connection.staff_not_allowed"],
    ]);
  });

  it("needs the consent, word for word, and only tools the toolkit has", async () => {
    const admin = someone("admin");
    const starts: Partial<Start>[] = [
      { consent: "I agree" },
      { consent: `${composioConsentText} ` },
      { tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_EXPORT_EVERYTHING"] },
      { tools: [] },
      { tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_LIST_CONTACTS"] },
    ];
    const ends = await Promise.all(
      starts.map(async (options) => await outcome(start(admin, options)))
    );
    expect(ends).toStrictEqual(starts.map(() => "connection.invalid"));
    expect(composioWrites()).toStrictEqual([]);
    await expect(events()).resolves.toStrictEqual([]);
  });

  it("isn't offered while the flag is off, or connect has no Composio key", async () => {
    const admin = someone("admin");
    await expect(outcome(start(admin, { composio: false }))).resolves.toBe(
      "connection.provider_unavailable"
    );
    await expect(
      outcome(
        startToolkitConnection(
          { ...env, COMPOSIO_API_KEY: undefined },
          {
            person: admin,
            composio: true,
            toolkit: "hubspot",
            tools: allowed,
            consent: composioConsentText,
            origin: clientOrigin,
            returnTo: "/connections",
          }
        )
      )
    ).resolves.toBe("connection.provider_unavailable");
    expect(composio.state.requests).toStrictEqual([]);
  });

  it("finishes only for the admin who started it, once, and deletes what it made at Composio otherwise", async () => {
    const admin = someone("admin");
    const other = someone("admin");
    const { state } = composio.authorize(await start(admin));
    await expect(outcome(back(other, state))).resolves.toBe(
      "connection.flow_invalid"
    );
    // Spent: not even the admin who started it can finish it now.
    await expect(outcome(back(admin, state))).resolves.toBe(
      "connection.flow_invalid"
    );
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      servers: 0,
    });
  });

  it("doesn't finish when the admin didn't connect at Composio", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin), "FAILED");
    await expect(outcome(back(admin, state))).resolves.toBe(
      "connection.provider_refused"
    );
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      servers: 0,
    });
  });

  it("doesn't finish while the flag is off", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    await expect(outcome(back(admin, state, false))).resolves.toBe(
      "connection.provider_unavailable"
    );
    expect(heldAtComposio().accounts).toBe(0);
  });

  it("stores nothing, and deletes what it made, when Composio fails on the way", async () => {
    const admin = someone("admin");
    const failures = ["/mcp/servers", "/mcp/servers/generate"];
    for (const failing of failures) {
      const { state } = composio.authorize(
        // oxlint-disable-next-line no-await-in-loop -- one flow at a time
        await start(admin)
      );
      composio.state.failing = failing;
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const ended = await outcome(back(admin, state));
      composio.state.failing = undefined;
      expect(ended).toBe("connection.provider_refused");
    }
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      servers: 0,
    });
    const listed = await exports.default.listConnections(admin);
    expect(
      listed.filter(({ connectedBy }) => connectedBy === admin.userId)
    ).toStrictEqual([]);
  });

  it("doesn't store a server Composio says is anywhere but its MCP host", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    composio.state.serverUrlBase = "https://mcp.attacker.example/v3/mcp/";
    await expect(outcome(back(admin, state))).resolves.toBe(
      "connection.provider_refused"
    );
    expect(heldAtComposio().servers).toBe(0);
  });

  it("drops a flow nobody finished in time, and what it made at Composio", async () => {
    const admin = someone("admin");
    // The admin connected at Composio, and never came back.
    const { state } = composio.authorize(await start(admin));
    await env.DB.prepare(
      "UPDATE composio_flows SET expires_at = ? WHERE user_id = ?"
    )
      .bind(Date.now() - 1, admin.userId)
      .run();
    await exports.default.scheduled();
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      servers: 0,
    });
    await expect(outcome(back(admin, state))).resolves.toBe(
      "connection.flow_invalid"
    );
  });

  it("drops the flows of an admin removed from the organization, and what they made at Composio", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    await exports.default.disconnectPersonal({
      person: null,
      ownerUserIds: [admin.userId],
    });
    expect(heldAtComposio().accounts).toBe(0);
    await expect(outcome(back(admin, state))).resolves.toBe(
      "connection.flow_invalid"
    );
  });

  it("deletes what it made at Composio when a flow comes back but can't finish", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    await exports.default.abandonFlow(state);
    expect(heldAtComposio()).toStrictEqual({
      authConfigs: 0,
      accounts: 0,
      servers: 0,
    });
  });
});

describe("a Composio connection", () => {
  const workflow = agentFor("user-anna");

  it("runs an allowed tool with connect's key, known by its toolkit and tool when it names no resources", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    const result = await callAs(
      workflow,
      call(connectionId, "HUBSPOT_LIST_CONTACTS")
    );
    expect(JSON.parse(result.output)).toStrictEqual({ contacts });
    expect(result.provenance).toStrictEqual(["hubspot/HUBSPOT_LIST_CONTACTS"]);
    expect(composio.state.mcp.ran).toStrictEqual([
      { tool: "HUBSPOT_LIST_CONTACTS", input: {} },
    ]);
    expect(composio.state.mcp.requests).toBeGreaterThan(0);
    expect(composio.state.mcp.unkeyed).toBe(0);
  });

  it("refuses a tool the admin didn't allow, without reaching Composio", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    await expect(
      outcome(callAs(workflow, call(connectionId, "HUBSPOT_DELETE_CONTACT")))
    ).resolves.toBe("connect.action_not_found");
    expect(composio.state.mcp.requests).toBe(0);
    const recorded = await events();
    const refused = recorded.find(({ action }) => action === "connection.call");
    expect(refused?.detail).toMatchObject({
      action: "HUBSPOT_DELETE_CONTACT",
      outcome: "refused",
      reason: "connect.action_not_found",
    });
  });

  it("holds a write from chat for the person to confirm", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    await expect(
      outcome(callAs(inChat, call(connectionId, "HUBSPOT_CREATE_CONTACT")))
    ).resolves.toBe("connect.confirmation_required");
    expect(composio.state.mcp.ran).toStrictEqual([]);
  });

  it("is deleted at Composio when an admin disconnects it, and takes no more calls", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    await expect(
      exports.default.disconnect({ person: admin, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    expect(heldAtComposio()).toMatchObject({ accounts: 0, servers: 0 });
    await expect(
      outcome(callAs(workflow, call(connectionId, "HUBSPOT_LIST_CONTACTS")))
    ).resolves.toBe("connect.connection_inactive");
  });

  it("takes no calls while connect has no Composio key", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    const connection = await drizzle(env.DB)
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .get();
    if (connection === undefined) {
      throw new Error("Expected the connection");
    }
    expect(() =>
      composioServer({ ...env, COMPOSIO_API_KEY: undefined }, connection)
    ).toThrow(/didn't take the call/u);
  });
});
