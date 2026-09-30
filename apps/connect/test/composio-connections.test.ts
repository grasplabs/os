import { composioConsentText } from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  StartToolkitConnection,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeComposioApi } from "./composio-api.ts";
import {
  agentFor,
  auditEvents,
  callAs,
  clientOrigin,
  connectWith,
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

/**
 * Cleanups at Composio connect still has to try, emptied before each test
 * of the file, so each counts its own.
 */
const composioCleanups = () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM composio_cleanups").run();
  });
  return {
    left: async (): Promise<number> => {
      const counted = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM composio_cleanups"
      ).first<{ n: number }>();
      return counted?.n ?? 0;
    },
  };
};

const { left: cleanupsLeft } = composioCleanups();

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
const back = async (person: ConnectionPerson, state: string) =>
  await exports.default.finishConnection({ person, state });

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

/** Nothing connect made is left at Composio. */
const nothingHeld = { authConfigs: 0, accounts: 0, servers: 0 };

/** Runs `run` as if `minutes` had passed. */
const afterMinutes = async (
  minutes: number,
  run: () => Promise<void>
): Promise<void> => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + minutes * 60_000);
  try {
    await run();
  } finally {
    clock.mockRestore();
  }
};

/** How many Composio flows of `person` are under way. */
const flowsOf = async (person: ConnectionPerson): Promise<number> => {
  const counted = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM composio_flows WHERE user_id = ?"
  )
    .bind(person.userId)
    .first<{ n: number }>();
  return counted?.n ?? 0;
};

/**
 * Runs `run` while every `when` (`BEFORE INSERT`, …) write to
 * `composio_cleanups` fails, as a D1 write can.
 */
const withTrigger = async <Result>(
  when: "BEFORE INSERT" | "BEFORE UPDATE" | "BEFORE DELETE",
  run: () => Promise<Result>
): Promise<Result> => {
  await env.DB.prepare(
    `CREATE TRIGGER fail_cleanups ${when} ON composio_cleanups BEGIN SELECT RAISE(ABORT, 'D1 failed'); END`
  ).run();
  try {
    return await run();
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_cleanups").run();
  }
};

/** Ends the time `person`'s Composio flows had to finish. */
const expireFlowsOf = async (person: ConnectionPerson): Promise<void> => {
  await env.DB.prepare(
    "UPDATE composio_flows SET expires_at = ? WHERE user_id = ?"
  )
    .bind(Date.now() - 1, person.userId)
    .run();
};

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
    expect(
      [...composio.state.holds.authConfigs.values()].map(
        ({ toolkit, managed, name }) => ({
          toolkit,
          managed,
          // Named by the flow's marker, so it can be found without its ID.
          marked: /^grasp-[0-9a-f]{24}$/u.test(name ?? ""),
        })
      )
    ).toStrictEqual([{ toolkit: "hubspot", managed: true, marked: true }]);
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
        toolsHash: await sha256Hex(JSON.stringify(allowed)),
        toolCount: allowed.length,
      },
    });
    // One flow ties the consent to the connection it led to.
    const flowId = consented[0]?.detail.flowId;
    expect(flowId).toStrictEqual(expect.any(String));
    expect(all.at(-1)?.detail).toMatchObject({
      flowId,
      toolsHash: await sha256Hex(JSON.stringify(allowed)),
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
    // Both were asked at once, so their events may be stored in either order.
    const refused = await events();
    expect(
      refused
        .map(({ action, detail }) => `${action} ${String(detail.reason)}`)
        .toSorted()
    ).toStrictEqual([
      "connection.connect connection.staff_not_allowed",
      "connection.connect role.forbidden",
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

  it("isn't offered while connect has no Composio key", async () => {
    const admin = someone("admin");
    await expect(
      outcome(
        connectWith({ COMPOSIO_API_KEY: undefined }).startToolkitConnection({
          person: admin,
          toolkit: "hubspot",
          tools: allowed,
          consent: composioConsentText,
          origin: clientOrigin,
          returnTo: "/connections",
        })
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

  it("stores nothing, and deletes what it made, when Composio fails on the way", async () => {
    const admin = someone("admin");
    const failures = ["POST /mcp/servers", "POST /mcp/servers/generate"];
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
    await expireFlowsOf(admin);
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

  it("hands every flow of an admin removed from the organization over to cleanup at once, however many", async () => {
    const admin = someone("admin");
    const flows = 12;
    const states: string[] = [];
    for (let flow = 0; flow < flows; flow += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      states.push(composio.authorize(await start(admin)).state);
    }
    await exports.default.disconnectPersonal({
      person: null,
      ownerUserIds: [admin.userId],
    });
    const handedOver = {
      flows: await flowsOf(admin),
      cleanups: await cleanupsLeft(),
    };
    // The cron trigger deletes them at Composio, ten a run.
    await exports.default.scheduled();
    await exports.default.scheduled();
    expect({
      handedOver,
      held: heldAtComposio(),
      cleanups: await cleanupsLeft(),
      finished: await outcome(back(admin, states[0] ?? "")),
    }).toStrictEqual({
      handedOver: { flows: 0, cleanups: flows },
      held: nothingHeld,
      cleanups: 0,
      finished: "connection.flow_invalid",
    });
  });

  it("makes nothing at Composio when it can't first record what it will make", async () => {
    const failed = await withTrigger(
      "BEFORE INSERT",
      async () => await outcome(start(someone("admin")))
    );
    expect({
      failed: failed !== "ok",
      held: heldAtComposio(),
      writes: composioWrites(),
      cleanups: await cleanupsLeft(),
    }).toStrictEqual({
      failed: true,
      held: nothingHeld,
      writes: [],
      cleanups: 0,
    });
  });

  it("finds by its marker an auth config whose ID it couldn't record and couldn't delete at once", async () => {
    const admin = someone("admin");
    composio.state.failing = "DELETE /";
    const failed = await withTrigger(
      "BEFORE UPDATE",
      async () => await outcome(start(admin))
    );
    composio.state.failing = undefined;
    const kept = { held: heldAtComposio(), cleanups: await cleanupsLeft() };
    await afterMinutes(6, async () => {
      await exports.default.scheduled();
    });
    expect({
      failed: failed !== "ok",
      kept,
      after: { held: heldAtComposio(), cleanups: await cleanupsLeft() },
    }).toStrictEqual({
      failed: true,
      kept: { held: { ...nothingHeld, authConfigs: 1 }, cleanups: 1 },
      after: { held: nothingHeld, cleanups: 0 },
    });
  });

  it("finds by its marker a server whose ID it couldn't record and couldn't delete at once", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    composio.state.failing = "DELETE /";
    const failed = await withTrigger(
      "BEFORE UPDATE",
      async () => await outcome(back(admin, state))
    );
    composio.state.failing = undefined;
    const kept = heldAtComposio();
    await afterMinutes(6, async () => {
      await exports.default.scheduled();
    });
    expect({
      failed: failed !== "ok",
      kept,
      after: { held: heldAtComposio(), cleanups: await cleanupsLeft() },
    }).toStrictEqual({
      failed: true,
      kept: { authConfigs: 1, accounts: 1, servers: 1 },
      after: { held: nothingHeld, cleanups: 0 },
    });
  });

  it("takes no flow whose cleanup it can't record: nothing is deleted at Composio without a record, and nothing is lost", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    const failed = await withTrigger(
      "BEFORE INSERT",
      async () => await outcome(exports.default.abandonFlow(state))
    );
    const kept = { flows: await flowsOf(admin), held: heldAtComposio() };
    await exports.default.abandonFlow(state);
    expect({
      failed: failed !== "ok",
      kept,
      after: { flows: await flowsOf(admin), held: heldAtComposio() },
    }).toStrictEqual({
      failed: true,
      kept: { flows: 1, held: { ...nothingHeld, authConfigs: 1, accounts: 1 } },
      after: { flows: 0, held: nothingHeld },
    });
  });

  it("leaves a taken flow's cleanup for the cron trigger when nothing gets to act on it", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    // As if the isolate went right after taking it: no key to act with.
    await connectWith({ COMPOSIO_API_KEY: undefined }).abandonFlow(state);
    const kept = await cleanupsLeft();
    await afterMinutes(6, async () => {
      await exports.default.scheduled();
    });
    expect({
      kept,
      held: heldAtComposio(),
      left: await cleanupsLeft(),
    }).toStrictEqual({
      kept: 1,
      held: nothingHeld,
      left: 0,
    });
  });

  it("stores no server URL for another account, or for no one account", async () => {
    const admin = someone("admin");
    const ends = [];
    for (const accountInUrl of ["other", "none"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      const { state } = composio.authorize(await start(admin));
      composio.state.accountInUrl = accountInUrl;
      // oxlint-disable-next-line no-await-in-loop -- one flow at a time
      ends.push(await outcome(back(admin, state)));
      composio.state.accountInUrl = "own";
    }
    expect({ ends, held: heldAtComposio() }).toStrictEqual({
      ends: ["connection.provider_refused", "connection.provider_refused"],
      held: nothingHeld,
    });
  });

  it("reads the role again when the admin comes back: someone no longer an admin can't finish", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    await expect(
      outcome(back({ ...admin, role: "user" }, state))
    ).resolves.toBe("role.forbidden");
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
  });

  it("deletes the auth config it made when starting fails midway, and records no consent", async () => {
    composio.state.failing = "POST /connected_accounts/link";
    await expect(outcome(start(someone("admin")))).resolves.toBe(
      "connection.provider_refused"
    );
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
    const recorded = await events();
    expect(
      recorded.map(({ action, detail }) => [action, detail.outcome])
    ).toStrictEqual([["connection.connect", "failed"]]);
  });

  it("keeps what it couldn't delete without a key, and deletes it once the key is back", async () => {
    const admin = someone("admin");
    const { state } = composio.authorize(await start(admin));
    const withoutKey = connectWith({ COMPOSIO_API_KEY: undefined });
    const finished = await outcome(
      withoutKey.finishConnection({ person: admin, state })
    );
    const kept = { held: heldAtComposio(), cleanups: await cleanupsLeft() };
    // Due once the finish would long be done.
    await afterMinutes(6, async () => {
      await withoutKey.scheduled();
    });
    const stillKept = await cleanupsLeft();
    await afterMinutes(6, async () => {
      await exports.default.scheduled();
    });
    expect({
      finished,
      kept,
      stillKept,
      after: { held: heldAtComposio(), cleanups: await cleanupsLeft() },
    }).toStrictEqual({
      finished: "connection.provider_unavailable",
      kept: {
        held: { ...nothingHeld, authConfigs: 1, accounts: 1 },
        cleanups: 1,
      },
      stillKept: 1,
      after: { held: nothingHeld, cleanups: 0 },
    });
  });

  it("keeps an expired flow's account to delete while connect has no key", async () => {
    const admin = someone("admin");
    composio.authorize(await start(admin));
    await expireFlowsOf(admin);
    await connectWith({ COMPOSIO_API_KEY: undefined }).scheduled();
    await expect(cleanupsLeft()).resolves.toBe(1);
    await afterMinutes(2, async () => {
      await exports.default.scheduled();
    });
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
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
    const result = await callAs(
      inChat,
      call(connectionId, "HUBSPOT_CREATE_CONTACT")
    );
    expect(result.pending?.id).toBeTypeOf("string");
    expect(composio.state.mcp.ran).toStrictEqual([]);
  });

  it("is deleted at Composio when an admin disconnects it, and takes no more calls", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    await expect(
      exports.default.disconnect({ person: admin, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
    await expect(
      outcome(callAs(workflow, call(connectionId, "HUBSPOT_LIST_CONTACTS")))
    ).resolves.toBe("connect.connection_inactive");
  });

  it("is deleted at Composio later when Composio doesn't take it at once, waiting longer after each failure", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    composio.state.failing = "DELETE /connected_accounts/";
    await expect(
      exports.default.disconnect({ person: admin, connectionId })
    ).resolves.toStrictEqual({ revoked: false });
    expect(heldAtComposio()).toStrictEqual({ ...nothingHeld, accounts: 1 });
    // Tried again after a minute, and failing, not again a minute later.
    await afterMinutes(2, async () => {
      await exports.default.scheduled();
    });
    const tried = composio.state.requests.length;
    await afterMinutes(3, async () => {
      await exports.default.scheduled();
    });
    expect(composio.state.requests).toHaveLength(tried);
    composio.state.failing = undefined;
    await afterMinutes(10, async () => {
      await exports.default.scheduled();
    });
    expect(heldAtComposio()).toStrictEqual(nothingHeld);
    await expect(cleanupsLeft()).resolves.toBe(0);
  });

  it("logs a cleanup Composio keeps refusing, once it has failed ten times", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    composio.state.failing = "DELETE /connected_accounts/";
    await exports.default.disconnect({ person: admin, connectionId });
    await env.DB.prepare("UPDATE composio_cleanups SET attempts = 9").run();
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    await afterMinutes(2, async () => {
      await exports.default.scheduled();
    });
    expect(JSON.stringify(errors)).toContain("composio.cleanup_stuck");
    expect(JSON.stringify(errors)).not.toContain(connectionId);
  });

  it("stops taking calls when disconnected, even if clearing its cleanup fails after Composio deleted it", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const revoked = await withTrigger(
      "BEFORE DELETE",
      async () =>
        await exports.default.disconnect({ person: admin, connectionId })
    );
    const inactive = await outcome(
      callAs(workflow, call(connectionId, "HUBSPOT_LIST_CONTACTS"))
    );
    const kept = await cleanupsLeft();
    await afterMinutes(2, async () => {
      await exports.default.scheduled();
    });
    expect({
      revoked,
      inactive,
      held: heldAtComposio(),
      kept,
      left: await cleanupsLeft(),
    }).toStrictEqual({
      revoked: { revoked: true },
      inactive: "connect.connection_inactive",
      held: nothingHeld,
      kept: 1,
      left: 0,
    });
  });

  it("deletes nothing at Composio when its disconnect can't be recorded", async () => {
    const admin = someone("admin");
    const connectionId = await connectHubSpot(admin);
    const failed = await withTrigger(
      "BEFORE INSERT",
      async () =>
        await outcome(
          exports.default.disconnect({ person: admin, connectionId })
        )
    );
    expect({
      failed: failed !== "ok",
      held: heldAtComposio(),
      calls: await outcome(
        callAs(workflow, call(connectionId, "HUBSPOT_LIST_CONTACTS"))
      ),
    }).toStrictEqual({
      failed: true,
      held: { authConfigs: 1, accounts: 1, servers: 1 },
      calls: "ok",
    });
  });

  it("takes no calls while connect has no Composio key", async () => {
    const connectionId = await connectHubSpot(someone("admin"));
    await expect(
      outcome(
        callAs(
          workflow,
          call(connectionId, "HUBSPOT_LIST_CONTACTS"),
          {},
          connectWith({ COMPOSIO_API_KEY: undefined })
        )
      )
    ).resolves.toBe("connect.server_unavailable");
    expect(composio.state.mcp.requests).toBe(0);
  });
});
