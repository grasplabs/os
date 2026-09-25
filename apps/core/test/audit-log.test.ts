import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { chainHash } from "../src/audit-chain.ts";

// A fresh log per test; the deployment's own is `auditLog(env)`.
const newLog = () => env.AUDIT_LOG.getByName(crypto.randomUUID());

type Log = ReturnType<typeof newLog>;

const newEvent = (action = "knowledge.read"): AuditEvent => ({
  id: crypto.randomUUID(),
  at: new Date().toISOString(),
  source: "core",
  actor: { type: "person", userId: "user-1" },
  action,
  provenance: [],
  detail: {},
});

const appendThree = async (log: Log): Promise<AuditEvent[]> => {
  const batch = [newEvent("a"), newEvent("b"), newEvent("c")];
  await log.append(batch);
  return batch;
};

/** The log's events, oldest first, as their position and the event. */
const stored = async (log: Log) => {
  const entries = await log.entries();
  return entries.map(({ seq, event }) => ({
    seq,
    event: auditEventSchema.parse(JSON.parse(event)),
  }));
};

/** Changes the log's storage directly, as someone with access to it could. */
const tamper = async (log: Log, ...statements: string[]): Promise<void> => {
  await runInDurableObject(log, (_instance, state) => {
    for (const statement of statements) {
      state.storage.sql.exec(statement);
    }
  });
};

describe("AuditLog", () => {
  it("appends events in order, each chained to the one before", async () => {
    const log = newLog();
    const first = await appendThree(log);
    const second = [newEvent("d")];
    await log.append(second);

    await expect(stored(log)).resolves.toStrictEqual(
      [...first, ...second].map((event, index) => ({ seq: index + 1, event }))
    );
    await expect(log.verify()).resolves.toMatchObject({ ok: true, length: 4 });
  });

  it("verifies an empty log", async () => {
    await expect(newLog().verify()).resolves.toMatchObject({
      ok: true,
      length: 0,
    });
  });

  it("appends an event ID once, however often it is delivered", async () => {
    const log = newLog();
    const event = newEvent();

    await expect(log.append([event, event])).resolves.toStrictEqual({
      appended: 1,
      duplicates: 1,
    });
    // A redelivery, even with other content under the same ID, is dropped.
    await expect(
      log.append([{ ...event, action: "knowledge.deleted" }, newEvent()])
    ).resolves.toStrictEqual({ appended: 1, duplicates: 1 });

    const entries = await stored(log);
    expect(entries.map((entry) => entry.event.action)).toStrictEqual([
      "knowledge.read",
      "knowledge.read",
    ]);
    await expect(log.verify()).resolves.toMatchObject({ ok: true, length: 2 });
  });

  it("appends nothing from a batch that holds a malformed event", async () => {
    const log = newLog();
    const forged = {
      ...newEvent(),
      actor: { type: "admin", userId: "user-1" },
    };

    // Called inside the object: the test pool reports an error thrown across
    // its RPC wrapper as unhandled, even when the caller handles it.
    await runInDurableObject(log, async (instance) => {
      // @ts-expect-error -- the actor type is not one the schema knows
      await expect(instance.append([newEvent(), forged])).rejects.toThrow(
        "Invalid discriminator value"
      );
    });
    await expect(log.entries()).resolves.toStrictEqual([]);
  });

  it("stores only the fields the event schema knows", async () => {
    const log = newLog();
    const event = newEvent();
    // An event that tries to set its own place in the chain.
    const injected = { ...event, seq: 1, prevHash: "0", hash: "0" };

    await log.append([injected]);

    await expect(stored(log)).resolves.toStrictEqual([{ seq: 1, event }]);
    await expect(log.verify()).resolves.toMatchObject({ ok: true, length: 1 });
  });

  it("keeps one chain when appends arrive at the same time", async () => {
    const log = newLog();
    // Called inside the object, as the test pool would otherwise send the
    // calls one at a time.
    await runInDurableObject(log, async (instance) => {
      await Promise.all(
        Array.from(
          { length: 5 },
          async () =>
            await instance.append([newEvent(), newEvent(), newEvent()])
        )
      );
    });
    await expect(log.verify()).resolves.toMatchObject({
      ok: true,
      length: 15,
    });
  });

  it("continues the chain after the object restarts", async () => {
    const log = newLog();
    await appendThree(log);
    await evictDurableObject(log);
    await appendThree(log);
    await expect(log.verify()).resolves.toMatchObject({ ok: true, length: 6 });
  });
});

describe("AuditLog tamper detection", () => {
  it("finds an altered event", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      `UPDATE events SET event = replace(event, '"b"', '"x"') WHERE seq = 2`
    );
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
  });

  it("finds an altered event whose hash was recomputed, at the next event", async () => {
    const log = newLog();
    await appendThree(log);
    await runInDurableObject(log, async (_instance, state) => {
      const [row] = state.storage.sql
        .exec<{ prev_hash: string; event: string }>(
          "SELECT prev_hash, event FROM events WHERE seq = 2"
        )
        .toArray();
      const event = row?.event.replace('"b"', '"x"') ?? "";
      const hash = await chainHash({
        seq: 2,
        prevHash: row?.prev_hash ?? "",
        event,
      });
      state.storage.sql.exec(
        "UPDATE events SET event = ?, hash = ? WHERE seq = 2",
        event,
        hash
      );
    });
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 3,
      reason: "unlinked",
    });
  });

  it("finds a deleted event", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(log, "DELETE FROM events WHERE seq = 2");
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "missing",
    });
  });

  it("finds a deleted event when the positions after it were renumbered", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      "DELETE FROM events WHERE seq = 2",
      "UPDATE events SET seq = 2 WHERE seq = 3"
    );
    await expect(log.verify()).resolves.toMatchObject({
      ok: false,
      brokenAt: 2,
    });
  });

  it("finds reordered events", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      "UPDATE events SET seq = -1 WHERE seq = 2",
      "UPDATE events SET seq = 2 WHERE seq = 3",
      "UPDATE events SET seq = 3 WHERE seq = -1"
    );
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "unlinked",
    });
  });
});
