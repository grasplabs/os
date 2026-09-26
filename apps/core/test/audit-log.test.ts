import { auditEventMaxBytes, auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { chainHash } from "../src/audit-chain.ts";
import { oversizedFields } from "./audit-events.ts";

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
    await expect(log.verify()).resolves.toMatchObject({
      ok: true,
      through: 4,
      done: true,
    });
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
      through: 0,
      done: true,
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
    await expect(log.verify()).resolves.toMatchObject({
      ok: true,
      through: 1,
      done: true,
    });
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
    const oversized = { ...newEvent(), ...oversizedFields };
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
    await expect(log.verify()).resolves.toMatchObject({
      ok: true,
      through: 1,
      done: true,
    });
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
      through: 15,
      done: true,
    });
  });

  it("continues the chain after the object restarts", async () => {
    const log = newLog();
    await appendThree(log);
    await evictDurableObject(log);
    await appendThree(log);
    await expect(log.verify()).resolves.toMatchObject({
      ok: true,
      through: 6,
      done: true,
    });
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

/** Verifies the whole chain, a step at a time, as an admin's client does. */
const verifyAll = async (log: Log) => {
  let result = await log.verify();
  let steps = 1;
  while (result.ok && !result.done) {
    // Each step starts where the one before it stopped.
    // oxlint-disable-next-line no-await-in-loop
    result = await log.verify(result.through);
    steps += 1;
  }
  return { result, steps };
};

/** Appends `count` events, a batch at a time. */
const appendMany = async (log: Log, count: number): Promise<void> => {
  const batch = 500;
  for (let done = 0; done < count; done += batch) {
    // In order, as the queue delivers them.
    // oxlint-disable-next-line no-await-in-loop
    await log.append(
      Array.from({ length: Math.min(batch, count - done) }, () => newEvent())
    );
  }
};

/** A time after everything the log holds, so all of it is past retention. */
const future = () => new Date(Date.now() + 60_000).toISOString();

/** The object of the stretch an archive moved out. */
const archivedKey = async (log: Log): Promise<string> => {
  const stretch = await log.archive(future());
  if (!stretch) {
    throw new Error("Expected a stretch to be archived");
  }
  return stretch.key;
};

/** The lines of an archived stretch's object. */
const archivedLines = async (key: string): Promise<string[]> => {
  const object = await env.AUDIT_ARCHIVE.get(key);
  const text = (await object?.text()) ?? "";
  return text.trim().split("\n");
};

describe("AuditLog verification in steps", () => {
  it("verifies a long chain over several steps, each from where the last stopped", async () => {
    const log = newLog();
    await appendMany(log, 10_500);

    const { result, steps } = await verifyAll(log);
    expect(result).toMatchObject({ ok: true, through: 10_500, done: true });
    expect(steps).toBe(2);
  });

  it("checks only what comes after the position a step starts from", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      `UPDATE events SET event = replace(event, 'test.a', 'test.x') WHERE seq = 1`
    );

    await expect(log.verify(1)).resolves.toMatchObject({
      ok: true,
      through: 3,
      done: true,
    });
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 1,
      reason: "altered",
    });
  });

  it("takes the hash a step starts from from the log, never from the caller", async () => {
    const log = newLog();
    await appendThree(log);
    // The first entry changed and rehashed: it verifies on its own, but the
    // next one no longer links to it.
    await runInDurableObject(log, async (instance, state) => {
      const [first] = instance.entries();
      if (!first) {
        throw new Error("Expected a first entry");
      }
      const event = first.event.replace("test.a", "test.x");
      const hash = await chainHash({ ...first, event });
      state.storage.sql.exec(
        "UPDATE events SET event = ?, hash = ? WHERE seq = 1",
        event,
        hash
      );
    });

    await expect(log.verify(1)).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "unlinked",
    });
  });

  it("finds a position a step starts from that the log no longer has", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(log, "DELETE FROM events WHERE seq = 2");
    await expect(log.verify(2)).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "missing",
    });
  });
});

describe("AuditLog retention", () => {
  it("archives the oldest entries and still verifies the chain across them", async () => {
    const log = newLog();
    const archived = await appendThree(log);

    const key = await archivedKey(log);
    await expect(log.entries()).resolves.toStrictEqual([]);
    const later = newEvent("test.d");
    await log.append([later]);

    await expect(stored(log)).resolves.toStrictEqual([
      { seq: 4, event: later },
    ]);
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 4, done: true },
      steps: 2,
    });
    // The archive holds the entries as they were stored.
    const lines = await archivedLines(key);
    const entry = z.object({ event: z.string() });
    expect(
      lines.map((line) =>
        auditEventSchema.parse(JSON.parse(entry.parse(JSON.parse(line)).event))
      )
    ).toStrictEqual(archived);
  });

  it("archives nothing the log received after the cutoff", async () => {
    const log = newLog();
    await appendThree(log);
    await expect(
      log.archive(new Date(Date.now() - 60_000).toISOString())
    ).resolves.toBeNull();
    await expect(log.entries()).resolves.toHaveLength(3);
  });

  it("archives a long backlog a stretch at a time, and keeps one chain", async () => {
    const log = newLog();
    await appendMany(log, 700);
    const cutoff = future();

    await expect(log.archive(cutoff)).resolves.toMatchObject({
      from: 1,
      through: 500,
    });
    await expect(log.archive(cutoff)).resolves.toMatchObject({
      from: 501,
      through: 700,
    });
    await expect(log.archive(cutoff)).resolves.toBeNull();
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 700, done: true },
    });
  });

  it("archives each entry once when archives run at the same time", async () => {
    const log = newLog();
    await appendThree(log);
    const cutoff = future();
    await runInDurableObject(log, async (instance) => {
      await Promise.all([instance.archive(cutoff), instance.archive(cutoff)]);
    });
    await log.append([newEvent()]);
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 4, done: true },
    });
  });

  it("writes a stretch again when an archive stopped before recording it", async () => {
    const log = newLog();
    await appendThree(log);
    // What a write left behind when the object stopped: nothing recorded.
    await env.AUDIT_ARCHIVE.put(
      "audit-log/000000000001-000000000003.ndjson",
      "partial"
    );
    await evictDurableObject(log);

    await archivedKey(log);
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 3, done: true },
    });
  });

  it("leaves a broken stretch where it can be found instead of archiving it", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      `UPDATE events SET event = replace(event, 'test.b', 'test.x') WHERE seq = 2`
    );
    await expect(log.archive(future())).resolves.toBeNull();
    await expect(log.entries()).resolves.toHaveLength(3);
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
  });

  it("finds an archived entry that was altered", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    const lines = await archivedLines(key);
    await env.AUDIT_ARCHIVE.put(
      key,
      lines.join("\n").replace("test.b", "test.x")
    );
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
  });

  it("finds an archived stretch that was cut short or deleted", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    const lines = await archivedLines(key);
    await env.AUDIT_ARCHIVE.put(key, lines.slice(0, 2).join("\n"));
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 3,
      reason: "missing",
    });

    await env.AUDIT_ARCHIVE.delete(key);
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 1,
      reason: "missing",
    });
  });

  it("finds an archived stretch rewritten as a chain of its own", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    await log.append([newEvent()]);
    // Another chain of three: it verifies on its own, but doesn't end where
    // this one picks up.
    const other = newLog();
    await appendThree(other);
    const rewritten = await other.entries();
    await env.AUDIT_ARCHIVE.put(
      key,
      rewritten.map((entry) => JSON.stringify(entry)).join("\n")
    );
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 4,
      reason: "unlinked",
    });
  });
});
