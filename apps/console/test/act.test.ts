import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { act, consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clients, settings } from "../src/db/schema.ts";

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A new client's row, with a unique slug and account. */
const newClient = () => {
  const id = `client-${crypto.randomUUID()}`;
  const now = new Date();
  return {
    id,
    name: id,
    accountId: `account-${crypto.randomUUID()}`,
    createdAt: now,
    updatedAt: now,
  };
};

const eventsFor = async (clientId: string) =>
  await db.select().from(auditEvents).where(eq(auditEvents.clientId, clientId));

describe(act, () => {
  it("writes the change and its audit event together", async () => {
    const client = newClient();

    await act(db, staff, [db.insert(clients).values(client)], {
      action: "client.create",
      clientId: client.id,
      target: client.accountId,
      detail: { ring: 1 },
    });

    const [row] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, client.id));
    expect(row).toMatchObject({
      accountId: client.accountId,
      status: "provisioning",
    });
    const events = await eventsFor(client.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: staff.email,
      action: "client.create",
      target: client.accountId,
      detail: JSON.stringify({ ring: 1 }),
    });
    expect(events[0]?.at).toBeInstanceOf(Date);
  });

  it("records the console's own jobs as the system", async () => {
    const client = newClient();

    await act(db, "system", [db.insert(clients).values(client)], {
      action: "client.create",
      clientId: client.id,
    });

    const events = await eventsFor(client.id);
    expect(
      events.map(({ actor, detail }) => ({ actor, detail }))
    ).toStrictEqual([{ actor: "system", detail: null }]);
  });

  it("writes nothing, the event included, when any statement fails", async () => {
    const taken = newClient();
    await db.insert(clients).values(taken);
    const client = newClient();

    // One Cloudflare account is one client: a second client on it fails, and
    // takes the first statement and the event with it.
    await expect(
      act(
        db,
        staff,
        [
          db.insert(clients).values(client),
          db
            .insert(clients)
            .values({ ...newClient(), accountId: taken.accountId }),
        ],
        { action: "client.create", clientId: client.id }
      )
    ).rejects.toThrow("UNIQUE constraint failed");

    await expect(
      db.select().from(clients).where(eq(clients.id, client.id))
    ).resolves.toStrictEqual([]);
    await expect(eventsFor(client.id)).resolves.toStrictEqual([]);
  });

  it("refuses a change to a client that doesn't exist", async () => {
    const clientId = `client-${crypto.randomUUID()}`;

    await expect(
      act(
        db,
        staff,
        [
          db.insert(settings).values({
            clientId,
            key: "FEATURES",
            value: "{}",
            updatedBy: staff.email,
            updatedAt: new Date(),
          }),
        ],
        { action: "setting.update", clientId, target: "FEATURES" }
      )
    ).rejects.toThrow("FOREIGN KEY constraint failed");

    await expect(eventsFor(clientId)).resolves.toStrictEqual([]);
  });

  it("refuses an action that isn't a dotted verb, writing nothing", async () => {
    const client = newClient();

    await expect(
      act(db, staff, [db.insert(clients).values(client)], {
        action: "Created a client",
        clientId: client.id,
      })
    ).rejects.toThrow("Not an audit action");

    await expect(
      db.select().from(clients).where(eq(clients.id, client.id))
    ).resolves.toStrictEqual([]);
  });
});
