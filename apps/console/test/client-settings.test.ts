import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { clientHistory, clientSettings } from "../src/clients/queries.ts";
import {
  SettingsError,
  setFeature,
  setRing,
  setSignIn,
} from "../src/clients/settings.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clients, settings } from "../src/db/schema.ts";

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };
const other = { email: "other@grasp.test", sub: "sub-other" };

const signIn = {
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  googleHostedDomain: "acme.test",
};

/** An active client in ring 1, recorded as provisioning records one. */
const recordClient = async (): Promise<string> => {
  const id = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id,
        name: id,
        accountId: crypto.randomUUID().replaceAll("-", ""),
        ring: 1,
        status: "active",
        signIn: JSON.stringify(signIn),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId: id }
  );
  return id;
};

/** Client `clientId`'s audit events of `action`, oldest first. */
const eventsOf = async (clientId: string, action: string) =>
  await db
    .select({
      actor: auditEvents.actor,
      target: auditEvents.target,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    )
    .orderBy(asc(auditEvents.at), asc(sql`rowid`));

/** What `task` was refused with, or `done`. */
const codeOf = async (task: Promise<unknown>): Promise<string> => {
  try {
    await task;
    return "done";
  } catch (error) {
    return error instanceof SettingsError ? error.code : "other";
  }
};

/** Client `clientId`'s record, as the settings change it. */
const recordOf = async (clientId: string) => {
  const [row] = await db
    .select({
      ring: clients.ring,
      signIn: clients.signIn,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  return row;
};

describe("a client's settings", () => {
  it("move a client to another ring, audited once per change, and leave its config as it was", async () => {
    const clientId = await recordClient();

    const changed = [
      await setRing(env, staff, { clientId, ring: 3 }),
      await setRing(env, staff, { clientId, ring: 3 }),
    ];

    expect({
      changed,
      record: await recordOf(clientId),
      events: await eventsOf(clientId, "client.ring"),
      settings: await clientSettings(db, clientId),
    }).toMatchObject({
      changed: [true, false],
      record: {
        ring: 3,
        signIn: JSON.stringify(signIn),
        configChangedAt: null,
      },
      events: [
        {
          actor: staff.email,
          target: null,
          detail: JSON.stringify({ ring: 3 }),
        },
      ],
      settings: { ring: 3 },
    });
  });

  it("switch feature flags one at a time, so two staff switching two at once both land, each audited once and marking the config changed", async () => {
    const clientId = await recordClient();

    const raced = await Promise.all([
      setFeature(env, staff, { clientId, feature: "apps", on: true }),
      setFeature(env, other, { clientId, feature: "knowledge", on: true }),
    ]);
    const afterRace = await recordOf(clientId);
    const again = await setFeature(env, staff, {
      clientId,
      feature: "apps",
      on: true,
    });
    const unchanged = await recordOf(clientId);
    const off = await setFeature(env, staff, {
      clientId,
      feature: "apps",
      on: false,
    });

    const events = await eventsOf(clientId, "client.feature");
    const shown = await clientSettings(db, clientId);
    expect({
      raced,
      again,
      off,
      features: shown?.features,
      marked: afterRace?.configChangedAt instanceof Date,
      // A switch that changes nothing doesn't count as a change.
      sameMark:
        unchanged?.configChangedAt?.getTime() ===
        afterRace?.configChangedAt?.getTime(),
      // The race's two in either order, then switching apps off.
      events: [
        ...events
          .slice(0, 2)
          .toSorted((a, b) => (a.target ?? "").localeCompare(b.target ?? "")),
        ...events.slice(2),
      ].map(({ target, detail }) => ({ target, detail })),
    }).toStrictEqual({
      raced: [true, true],
      again: false,
      off: true,
      features: { apps: false, knowledge: true },
      marked: true,
      sameMark: true,
      events: [
        { target: "apps", detail: JSON.stringify({ on: true }) },
        { target: "knowledge", detail: JSON.stringify({ on: true }) },
        { target: "apps", detail: JSON.stringify({ on: false }) },
      ],
    });
  });

  it("refuse a feature name core couldn't have, and a client that doesn't exist", async () => {
    const clientId = await recordClient();

    const refused = {
      name: await codeOf(
        setFeature(env, staff, { clientId, feature: "Apps!", on: true })
      ),
      client: await codeOf(
        setFeature(env, staff, {
          clientId: "no-such-client",
          feature: "apps",
          on: true,
        })
      ),
      ring: await codeOf(
        setRing(env, staff, { clientId: "no-such-client", ring: 2 })
      ),
    };

    const rows = await db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.clientId, clientId));
    expect({ refused, rows }).toStrictEqual({
      // A name the schema refuses fails before anything is read.
      refused: {
        name: "other",
        client: "unknown_client",
        ring: "unknown_client",
      },
      rows: [],
    });
  });

  it("change a client's sign-in, audited with its domains and IdP but never its admins' emails, and mark its config changed", async () => {
    const clientId = await recordClient();
    const changedTo = {
      domains: ["acme.test", "acme-group.test"],
      admins: ["bo@acme-group.test"],
      entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
    };

    const changed = [
      await setSignIn(env, staff, { clientId, signIn: changedTo }),
      await setSignIn(env, staff, { clientId, signIn: changedTo }),
    ];

    const record = await recordOf(clientId);
    const events = await eventsOf(clientId, "client.sign_in");
    const shown = await clientSettings(db, clientId);
    expect({
      changed,
      signIn: z.unknown().parse(JSON.parse(record?.signIn ?? "null")),
      marked: record?.configChangedAt instanceof Date,
      shown: shown?.signIn,
      events,
      emailsAudited: events.some(
        ({ detail }) => detail?.includes("@") === true
      ),
    }).toStrictEqual({
      changed: [true, false],
      signIn: changedTo,
      marked: true,
      shown: changedTo,
      events: [
        {
          actor: staff.email,
          target: null,
          detail: JSON.stringify({
            domains: "acme.test,acme-group.test",
            admins: 1,
            entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
          }),
        },
      ],
      emailsAudited: false,
    });
  });

  it("refuse a sign-in no first admin could sign in with, or that isn't one, and keep the one it had", async () => {
    const clientId = await recordClient();

    const refused = {
      noAdmin: await codeOf(
        setSignIn(env, staff, {
          clientId,
          signIn: { ...signIn, admins: [] },
        })
      ),
      outside: await codeOf(
        setSignIn(env, staff, {
          clientId,
          signIn: { ...signIn, admins: ["ada@elsewhere.test"] },
        })
      ),
      noIdp: await codeOf(
        setSignIn(env, staff, {
          clientId,
          signIn: { domains: signIn.domains, admins: signIn.admins },
        })
      ),
      garbled: await codeOf(
        setSignIn(env, staff, { clientId, signIn: "acme.test" })
      ),
    };

    expect({
      refused,
      record: await recordOf(clientId),
      events: await eventsOf(clientId, "client.sign_in"),
    }).toStrictEqual({
      refused: {
        noAdmin: "admin_unreachable",
        outside: "admin_unreachable",
        noIdp: "sign_in_invalid",
        garbled: "sign_in_invalid",
      },
      record: {
        ring: 1,
        signIn: JSON.stringify(signIn),
        configChangedAt: null,
      },
      events: [],
    });
  });

  it("list a client's console actions newest first, and no other client's", async () => {
    const clientId = await recordClient();
    const otherClient = await recordClient();
    await setRing(env, staff, { clientId, ring: 2 });
    await setFeature(env, staff, { clientId, feature: "apps", on: true });
    await setRing(env, staff, { clientId: otherClient, ring: 4 });

    const history = await clientHistory(db, clientId);

    expect(history.map(({ action }) => action)).toStrictEqual([
      "client.feature",
      "client.ring",
      "client.create",
    ]);
  });
});
