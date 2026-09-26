import { auditEventMaxBytes, auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { canonicalJson } from "@grasp-os/shared/json";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { chainHash } from "../src/audit-chain.ts";
import { archiveRetentionDays } from "../src/audit-log.ts";
import { appendStored, oversizedFields } from "./audit-events.ts";

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

/**
 * Changes the event at `seq` from `from` to `to` and recomputes its hash, as
 * someone who knows the hash format could: the entry verifies on its own.
 */
const rehashed = async (
  log: Log,
  seq: number,
  from: string,
  to: string
): Promise<void> => {
  await runInDurableObject(log, async (instance, state) => {
    const entry = instance.entries().find((candidate) => candidate.seq === seq);
    if (!entry) {
      throw new Error(`Expected an entry at ${seq}`);
    }
    const event = entry.event.replace(from, to);
    const hash = await chainHash({ ...entry, event });
    state.storage.sql.exec(
      "UPDATE events SET event = ?, hash = ? WHERE seq = ?",
      event,
      hash,
      seq
    );
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

  it("logs a receipt time held far behind the last one, but not a small hold", async () => {
    const log = newLog();
    /** Appends with the clock `ms` ahead, then now; whether a hold was logged. */
    const heldAfterJump = async (ms: number): Promise<boolean> => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + ms);
      try {
        await log.append([newEvent()]);
      } finally {
        vi.useRealTimers();
      }
      const warned = vi.spyOn(console, "warn");
      try {
        await log.append([newEvent()]);
        return warned.mock.calls.some(
          ([fields]) =>
            z.object({ event: z.literal("audit.clock_held") }).safeParse(fields)
              .success
        );
      } finally {
        warned.mockRestore();
      }
    };
    await expect(heldAfterJump(60 * 1000)).resolves.toBeFalsy();
    await expect(heldAfterJump(60 * 60 * 1000)).resolves.toBeTruthy();
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
    await rehashed(log, 2, "test.b", "test.x");
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

/**
 * A cutoff after everything the log holds so far, so all of it is past
 * retention, and before anything it receives from now on.
 */
const cutoffNow = async (): Promise<string> => {
  await scheduler.wait(5);
  const cutoff = new Date().toISOString();
  await scheduler.wait(5);
  return cutoff;
};

/** Archives what the log holds now; the key of the stretch it moved out. */
const archivedKey = async (log: Log): Promise<string> => {
  const stretch = await log.archive(await cutoffNow(), 180);
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

/** Where this log archives the stretch from 1 to 3. */
const firstThreeKey = (log: Log) =>
  `audit-log/${log.id.toString()}/000000000001-000000000003.ndjson`;

describe("AuditLog verification in steps", () => {
  it("verifies a long chain over several steps, each from where the last stopped", async () => {
    const log = newLog();
    await appendMany(log, 2500);

    const { result, steps } = await verifyAll(log);
    expect(result).toMatchObject({ ok: true, through: 2500, done: true });
    expect(steps).toBe(3);
    await expect(log.lastFullVerification()).resolves.toMatchObject({
      ok: true,
      through: 2500,
    });
  });

  it("keeps only passes that verified from the first position, without gaps", async () => {
    const log = newLog();
    await appendThree(log);
    await log.verify(1);
    await expect(log.lastFullVerification()).resolves.toBeNull();

    await tamper(
      log,
      `UPDATE events SET event = replace(event, 'test.b', 'test.x') WHERE seq = 2`
    );
    await log.verify();
    await expect(log.lastFullVerification()).resolves.toMatchObject({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
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
    await rehashed(log, 1, "test.a", "test.x");

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

describe("AuditLog search", () => {
  it("never records a receipt time before the one before it", async () => {
    const log = newLog();
    await log.append([newEvent()]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 60 * 60 * 1000);
    try {
      await log.append([newEvent()]);
    } finally {
      vi.useRealTimers();
    }
    const [first, second] = await log.entries();
    expect(second?.receivedAt).toBe(first?.receivedAt);
    await expect(log.verify()).resolves.toMatchObject({ ok: true });
  });

  it("finds the entries in a time range of a large log without reading the rest", async () => {
    const log = newLog();
    await appendMany(log, 12_000);
    const from = await cutoffNow();
    const recent = [newEvent(), newEvent(), newEvent()];
    await log.append(recent);

    // Oldest first, the first read starts at the range: 12 000 entries
    // before it would otherwise fill the read with nothing.
    const page = await log.search({
      filter: { from },
      order: "oldest",
      limit: 100,
    });
    expect(page?.records.map(({ event }) => event?.id)).toStrictEqual(
      recent.map(({ id }) => id)
    );
    expect(page?.next).toBeNull();
  });

  it("returns what it stored byte for byte, with defaults added since", async () => {
    const log = newLog();
    // An event as a release before `provenance` and `detail` had defaults
    // would have stored it.
    const { provenance: _p, detail: _d, ...older } = newEvent("test.older");
    const storedText = canonicalJson(older);
    await appendStored(log, storedText);

    const page = await log.search({ filter: {}, order: "oldest", limit: 10 });
    expect(page?.records).toMatchObject([
      {
        eventJson: storedText,
        event: { ...older, provenance: [], detail: {} },
        verified: true,
      },
    ]);
  });

  it("returns an entry that isn't an event as unverified, and only unfiltered", async () => {
    const log = newLog();
    await appendThree(log);
    await appendStored(log, "not an event");

    const all = await log.search({ filter: {}, order: "newest", limit: 10 });
    expect(all?.records[0]).toMatchObject({
      seq: 4,
      eventJson: "not an event",
      event: null,
      verified: false,
    });
    const filtered = await log.search({
      filter: { actorType: "person" },
      order: "newest",
      limit: 10,
    });
    expect(filtered?.records.map(({ seq }) => seq)).toStrictEqual([3, 2, 1]);
  });

  it("says so when retention archived where a search would read next", async () => {
    const log = newLog();
    await appendThree(log);
    const range = await log.range({});
    await archivedKey(log);
    await expect(
      log.search({ filter: {}, order: "oldest", limit: 10, range })
    ).resolves.toBeNull();
  });
});

describe("AuditLog retention", () => {
  it("archives the oldest entries and still verifies the chain across them", async () => {
    const log = newLog();
    const archived = await appendThree(log);

    const key = await archivedKey(log);
    // The archive is recorded in the chain itself, by the platform.
    await expect(stored(log)).resolves.toMatchObject([
      {
        seq: 4,
        event: {
          actor: { type: "system" },
          action: "audit.archived",
          detail: { from: 1, through: 3, key, retentionDays: 180 },
        },
      },
    ]);
    await log.append([newEvent("test.d")]);
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 5, done: true },
      steps: 2,
    });
    // Under this log's own name, holding the entries as they were stored.
    expect(key).toBe(firstThreeKey(log));
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
      log.archive(new Date(Date.now() - 60_000).toISOString(), 180)
    ).resolves.toBeNull();
    await expect(log.entries()).resolves.toHaveLength(3);
  });

  it("archives a long backlog a stretch at a time, and keeps one chain", async () => {
    const log = newLog();
    await appendMany(log, 700);
    const cutoff = await cutoffNow();

    await expect(log.archive(cutoff, 180)).resolves.toMatchObject({
      from: 1,
      through: 500,
    });
    await expect(log.archive(cutoff, 180)).resolves.toMatchObject({
      from: 501,
      through: 700,
    });
    await expect(log.archive(cutoff, 180)).resolves.toBeNull();
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 702, done: true },
    });
  });

  it("archives each entry once when archives run at the same time", async () => {
    const log = newLog();
    await appendThree(log);
    const cutoff = await cutoffNow();
    await runInDurableObject(log, async (instance) => {
      await Promise.all([
        instance.archive(cutoff, 180),
        instance.archive(cutoff, 180),
      ]);
    });
    await expect(stored(log)).resolves.toHaveLength(1);
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 4, done: true },
    });
  });

  it("verifies what a step read while an archive moves those entries out", async () => {
    const log = newLog();
    await appendMany(log, 1500);
    const cutoff = await cutoffNow();
    // A step reading held entries is under way when the archive starts:
    // both go through, and the step checks every entry it read.
    const [step, stretch] = await runInDurableObject(
      log,
      async (instance) =>
        await Promise.all([instance.verify(), instance.archive(cutoff, 180)])
    );
    expect({ step, stretch }).toMatchObject({
      step: { ok: true, through: 1000, done: false },
      stretch: { from: 1, through: 500 },
    });
    // The next step carries on from there, and the chain still verifies
    // across the archived stretch.
    await expect(log.verify(1000)).resolves.toMatchObject({
      ok: true,
      through: 1501,
      done: true,
    });
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 1501, done: true },
    });
  });

  it("takes up a stretch an archive wrote but stopped before recording", async () => {
    const log = newLog();
    await appendThree(log);
    const entries = await log.entries();
    // Exactly what the archive wrote before the object stopped.
    await env.AUDIT_ARCHIVE.put(
      firstThreeKey(log),
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")
    );
    await evictDurableObject(log);

    await archivedKey(log);
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 4, done: true },
    });
  });

  it("never writes over an object that holds anything else", async () => {
    const log = newLog();
    await appendThree(log);
    await env.AUDIT_ARCHIVE.put(firstThreeKey(log), "someone else's");

    await expect(log.archive(await cutoffNow(), 180)).resolves.toBeNull();
    await expect(log.entries()).resolves.toHaveLength(3);
    const object = await env.AUDIT_ARCHIVE.get(firstThreeKey(log));
    await expect(object?.text()).resolves.toBe("someone else's");
  });

  it("leaves a broken stretch where it can be found instead of archiving it", async () => {
    const log = newLog();
    await appendThree(log);
    await tamper(
      log,
      `UPDATE events SET event = replace(event, 'test.b', 'test.x') WHERE seq = 2`
    );
    await expect(log.archive(await cutoffNow(), 180)).resolves.toBeNull();
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

  it("finds an archived line that isn't an entry", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    const [first, , third] = await archivedLines(key);
    await env.AUDIT_ARCHIVE.put(key, [first, "garbage", third].join("\n"));
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

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Runs `run` with the clock `days` ahead: the log works out what to purge
 * from its own clock and archive retention (365 days in tests).
 */
const inDays = async <T>(days: number, run: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + days * dayMs);
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** Purges as the log would once archive retention has passed. */
const purgeLater = async (log: Log) =>
  await inDays(366, async () => await log.purge());

/** Archives what the log holds now, and then a second stretch. */
const archiveTwoStretches = async (log: Log): Promise<void> => {
  await appendThree(log);
  await archivedKey(log);
  await appendThree(log);
  await archivedKey(log);
};

describe("AuditLog purges", () => {
  it("purges the oldest archived stretch once archive retention has passed, and records it", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    await log.append([newEvent("test.d")]);

    // Not before archive retention has passed.
    await expect(
      inDays(364, async () => await log.purge())
    ).resolves.toBeNull();
    await expect(purgeLater(log)).resolves.toStrictEqual({
      from: 1,
      through: 3,
      key,
    });
    await expect(env.AUDIT_ARCHIVE.get(key)).resolves.toBeNull();
    // The purge is recorded in the chain itself, by the platform.
    await expect(stored(log)).resolves.toMatchObject([
      { seq: 4, event: { action: "audit.archived" } },
      { seq: 5, event: { action: "test.d" } },
      {
        seq: 6,
        event: {
          actor: { type: "system" },
          action: "audit.purged",
          detail: { from: 1, through: 3, key },
        },
      },
    ]);
  });

  it("works out archive retention from deployment config only, and purges nothing without it", () => {
    expect(archiveRetentionDays({})).toBeUndefined();
    // Below the floor, above the ceiling, or not whole days: none.
    for (const days of ["30", "364", "3651", "400.5", "a year"]) {
      expect(
        archiveRetentionDays({ AUDIT_ARCHIVE_RETENTION_DAYS: days })
      ).toBeUndefined();
    }
    expect(archiveRetentionDays({ AUDIT_ARCHIVE_RETENTION_DAYS: "730" })).toBe(
      730
    );
  });

  it("refuses an archive retention shorter than retention, as it's an event's total age", () => {
    const logged = vi.spyOn(console, "error").mockReturnValue();
    try {
      // Events would be purged before they were archived.
      expect(
        archiveRetentionDays({
          AUDIT_RETENTION_DAYS: "800",
          AUDIT_ARCHIVE_RETENTION_DAYS: "700",
        })
      ).toBeUndefined();
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "config.invalid",
          var: "AUDIT_ARCHIVE_RETENTION_DAYS",
        })
      );
    } finally {
      logged.mockRestore();
    }
    expect(
      archiveRetentionDays({
        AUDIT_RETENTION_DAYS: "800",
        AUDIT_ARCHIVE_RETENTION_DAYS: "800",
      })
    ).toBe(800);
    // Nor any while retention itself is invalid.
    expect(
      archiveRetentionDays({
        AUDIT_RETENTION_DAYS: "7",
        AUDIT_ARCHIVE_RETENTION_DAYS: "730",
      })
    ).toBeUndefined();
  });

  it("verifies a purged stretch as purged, and the chain across it", async () => {
    const log = newLog();
    await appendThree(log);
    await archivedKey(log);
    await log.append([newEvent("test.d")]);
    await purgeLater(log);

    // Reported as purged, not missing, and the chain carries on after it.
    await expect(log.verify()).resolves.toMatchObject({
      ok: true,
      through: 3,
      purged: true,
      done: false,
    });
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, through: 6, done: true },
    });
    await expect(log.lastFullVerification()).resolves.toMatchObject({
      ok: true,
      through: 6,
      purgedThrough: 3,
    });
  });

  it("purges oldest first, one stretch at a time", async () => {
    const log = newLog();
    await archiveTwoStretches(log);

    await expect(purgeLater(log)).resolves.toMatchObject({
      from: 1,
      through: 3,
    });
    await expect(purgeLater(log)).resolves.toMatchObject({
      from: 4,
      through: 7,
    });
    await expect(purgeLater(log)).resolves.toBeNull();
    // Two purged stretches, then the entries the log holds.
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, done: true },
      steps: 3,
    });
    await expect(log.lastFullVerification()).resolves.toMatchObject({
      ok: true,
      purgedThrough: 7,
    });
  });

  it("deletes a purged stretch's object on a later purge when its delete failed", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);

    const refused = vi
      .spyOn(env.AUDIT_ARCHIVE, "delete")
      .mockRejectedValueOnce(new Error("R2 unavailable"));
    try {
      await expect(purgeLater(log)).resolves.toMatchObject({ from: 1 });
    } finally {
      refused.mockRestore();
    }
    // Recorded as purged, but its object is still there.
    await expect(env.AUDIT_ARCHIVE.get(key)).resolves.not.toBeNull();
    await expect(log.verify()).resolves.toMatchObject({ purged: true });

    // Nothing more to purge, but the object goes this time.
    await expect(purgeLater(log)).resolves.toBeNull();
    await expect(env.AUDIT_ARCHIVE.get(key)).resolves.toBeNull();
  });

  it("deletes a purged stretch's object even when the next purge fails", async () => {
    const log = newLog();
    await archiveTwoStretches(log);
    const key = firstThreeKey(log);
    const refused = vi
      .spyOn(env.AUDIT_ARCHIVE, "delete")
      .mockRejectedValueOnce(new Error("R2 unavailable"));
    try {
      await expect(purgeLater(log)).resolves.toMatchObject({ from: 1 });
    } finally {
      refused.mockRestore();
    }
    await expect(env.AUDIT_ARCHIVE.get(key)).resolves.not.toBeNull();

    // The read of the next stretch's object fails, so it isn't purged,
    // but the object of the stretch purged before still goes.
    const unreadable = vi
      .spyOn(env.AUDIT_ARCHIVE, "get")
      .mockRejectedValueOnce(new Error("R2 unavailable"));
    try {
      await expect(purgeLater(log)).rejects.toThrow("R2 unavailable");
    } finally {
      unreadable.mockRestore();
    }
    await expect(env.AUDIT_ARCHIVE.get(key)).resolves.toBeNull();
    await expect(purgeLater(log)).resolves.toMatchObject({ from: 4 });
  });

  it("throws a failed purge's own error, and logs when its deletes fail too", async () => {
    const log = newLog();
    await archiveTwoStretches(log);
    const refused = vi
      .spyOn(env.AUDIT_ARCHIVE, "delete")
      .mockRejectedValueOnce(new Error("R2 unavailable"));
    try {
      await purgeLater(log);
    } finally {
      refused.mockRestore();
    }
    // The read of the next stretch's object fails, and so does recording
    // that the stretch purged before was deleted.
    await tamper(
      log,
      "CREATE TRIGGER archives_down BEFORE UPDATE ON archives BEGIN SELECT RAISE(ABORT, 'storage down'); END"
    );
    const unreadable = vi
      .spyOn(env.AUDIT_ARCHIVE, "get")
      .mockRejectedValueOnce(new Error("R2 unavailable"));
    const logged = vi.spyOn(console, "error").mockReturnValue();
    try {
      await expect(purgeLater(log)).rejects.toThrow("R2 unavailable");
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ event: "audit.purge_cleanup_failed" })
      );
      expect(JSON.stringify(logged.mock.calls)).toContain("storage down");
    } finally {
      unreadable.mockRestore();
      logged.mockRestore();
      await tamper(log, "DROP TRIGGER archives_down");
    }
  });

  it("records a purge once when purges run at the same time", async () => {
    const log = newLog();
    await appendThree(log);
    await archivedKey(log);

    const purged = await inDays(
      366,
      async () =>
        await runInDurableObject(
          log,
          async (instance) =>
            await Promise.all([instance.purge(), instance.purge()])
        )
    );
    expect(purged.filter((stretch) => stretch !== null)).toHaveLength(1);
    const events = await stored(log);
    expect(
      events.filter(({ event }) => event.action === "audit.purged")
    ).toHaveLength(1);
    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: true, done: true },
    });
  });

  it("reports a stretch purged while a step reads its object as purged, not broken", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    // The step's read of the object arrives only after the purge deleted it.
    const purgedMeanwhile = Promise.withResolvers<null>();
    const get = env.AUDIT_ARCHIVE.get.bind(env.AUDIT_ARCHIVE);
    const reads = vi
      .spyOn(env.AUDIT_ARCHIVE, "get")
      .mockImplementationOnce(async () => await purgedMeanwhile.promise)
      .mockImplementation(async (name: string) => await get(name));
    try {
      const step = log.verify();
      await purgeLater(log);
      await expect(env.AUDIT_ARCHIVE.get(key)).resolves.toBeNull();
      purgedMeanwhile.resolve(null);
      await expect(step).resolves.toMatchObject({
        ok: true,
        through: 3,
        purged: true,
      });
    } finally {
      reads.mockRestore();
    }
  });

  it("never purges a stretch that doesn't verify, so its break stays found", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    const lines = await archivedLines(key);
    await env.AUDIT_ARCHIVE.put(
      key,
      lines.join("\n").replace("test.b", "test.x")
    );

    await expect(purgeLater(log)).resolves.toBeNull();
    await expect(env.AUDIT_ARCHIVE.get(key)).resolves.not.toBeNull();
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 2,
      reason: "altered",
    });
  });

  it("never purges a stretch deleted outside the product, which stays missing", async () => {
    const log = newLog();
    await appendThree(log);
    const key = await archivedKey(log);
    await env.AUDIT_ARCHIVE.delete(key);

    await expect(purgeLater(log)).resolves.toBeNull();
    await expect(log.verify()).resolves.toStrictEqual({
      ok: false,
      brokenAt: 1,
      reason: "missing",
    });
  });

  it("finds a purged stretch that no longer links to the chain before it", async () => {
    const log = newLog();
    await archiveTwoStretches(log);
    await purgeLater(log);
    await purgeLater(log);
    // The second stretch's recorded link, changed after its purge.
    await tamper(
      log,
      `UPDATE archives SET prev_hash = '${"f".repeat(64)}' WHERE first_seq = 4`
    );

    await expect(verifyAll(log)).resolves.toMatchObject({
      result: { ok: false, brokenAt: 4, reason: "unlinked" },
    });
  });
});
