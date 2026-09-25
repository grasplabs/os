import { auditEventMaxBytes, auditEventSchema } from "@grasp-os/shared/audit";
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
  const batch = [newEvent("test.a"), newEvent("test.b"), newEvent("test.c")];
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
    const second = [newEvent("test.d")];
    await log.append(second);

    await expect(stored(log)).resolves.toStrictEqual(
      [...first, ...second].map((event, index) => ({ seq: index + 1, event }))
    );
    await expect(log.verify()).resolves.toMatchObject({ ok: true, length: 4 });
  });

  it("records when it received each event, whatever time the sender claims", async () => {
    const log = newLog();
    const before = new Date().toISOString();
    await log.append([{ ...newEvent(), at: "2000-01-01T00:00:00Z" }]);

    const [entry] = await log.entries();
    const receivedAt = entry?.receivedAt ?? "";
    expect(receivedAt >= before).toBeTruthy();
    expect(receivedAt <= new Date().toISOString()).toBeTruthy();
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
      conflicts: 0,
    });
    // The same ID in capitals is the same event.
    await expect(
      log.append([{ ...event, id: event.id.toUpperCase() }])
    ).resolves.toStrictEqual({ appended: 0, duplicates: 1, conflicts: 0 });

    await expect(stored(log)).resolves.toStrictEqual([{ seq: 1, event }]);
  });

  it("counts a redelivery with other content as a conflict and keeps the first", async () => {
    const log = newLog();
    const event = newEvent();
    await log.append([event]);

    const changed = { ...event, action: "knowledge.deleted" };
    await expect(
      log.append([changed, { ...changed, id: event.id.toUpperCase() }])
    ).resolves.toStrictEqual({ appended: 0, duplicates: 2, conflicts: 2 });

    await expect(stored(log)).resolves.toStrictEqual([{ seq: 1, event }]);
    await expect(log.verify()).resolves.toMatchObject({ ok: true, length: 1 });
  });

  // Called inside the object: the test pool reports an error thrown across
  // its RPC wrapper as unhandled, even when the caller handles it.
  it("appends nothing from a batch that holds a malformed event", async () => {
    const log = newLog();
    const forged = {
      ...newEvent(),
      actor: { type: "admin", userId: "user-1" },
    };

    await runInDurableObject(log, async (instance) => {
      // @ts-expect-error -- the actor type is not one the schema knows
      await expect(instance.append([newEvent(), forged])).rejects.toThrow(
        "Invalid discriminator value"
      );
    });
    await expect(log.entries()).resolves.toStrictEqual([]);
  });

  it("refuses an event over the size cap, however each field is bounded", async () => {
    const log = newLog();
    const provenance = Array.from({ length: 100 }, () => "r".repeat(100));
    const oversized = { ...newEvent(), provenance };
    expect(auditEventSchema.safeParse(oversized).success).toBeTruthy();

    await runInDurableObject(log, async (instance) => {
      await expect(instance.append([newEvent(), oversized])).rejects.toThrow(
        `over ${auditEventMaxBytes} bytes`
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
      `UPDATE events SET event = replace(event, 'test.b', 'test.x') WHERE seq = 2`
    );
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
  });

  it("finds an altered receipt time", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      `UPDATE events SET received_at = '2000-01-01T00:00:00.000Z' WHERE seq = 2`
    );
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
  });

  it("finds an entry that claims another hash format", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(log, "UPDATE events SET version = 2 WHERE seq = 2");
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
  });

  it("finds an altered event whose hash was recomputed, at the next event", async () => {
    const log = newLog();
    await appendThree(log);
    await runInDurableObject(log, async (instance, state) => {
      const [, second] = instance.entries();
      if (!second) {
        throw new Error("Expected a second entry");
      }
      const event = second.event.replace("test.b", "test.x");
      const hash = await chainHash({ ...second, event });
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
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "unlinked",
    });
  });

  it("finds reordered events", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      "UPDATE events SET seq = 100 WHERE seq = 2",
      "UPDATE events SET seq = 2 WHERE seq = 3",
      "UPDATE events SET seq = 3 WHERE seq = 100"
    );
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "unlinked",
    });
  });
});
