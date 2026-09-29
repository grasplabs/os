import type { AuditEvent } from "@grasp-os/shared/audit";
import { auditEventTypeOf } from "@grasp-os/shared/audit-log";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import {
  platformUpdateMaxBytes,
  platformUpdateMaxSkewMs,
  platformUpdatePath,
  platformUpdatePurpose,
  platformUpdateSignatureHeader,
} from "@grasp-os/shared/platform-change";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { recordPlatformUpdate } from "../src/platform-updates.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { routed } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// Platform updates: the every-minute cron records each version of core it
// hasn't seen running as `platform.updated`, with the change the console
// set on it, once per version ever, however many cron runs see it and
// however often versions alternate.

/** A version's metadata as the binding gives it, with an ID of its own. */
const newVersion = (): WorkerVersionMetadata => ({
  id: crypto.randomUUID(),
  tag: "",
  timestamp: "2031-01-02T03:04:05.000Z",
});

const change: PlatformChange = {
  by: "staff@grasp.test",
  what: "release",
  release: "r000123-abcdef0",
  at: "2031-01-02T03:04:00.000Z",
};

/** Core's migrations, as vite.config.ts binds them. */
const migrationsSchema = z.array(
  z.object({ name: z.string(), queries: z.array(z.string()) })
);

/**
 * Core's database, with `first` run just before each batch lands: another
 * cron run's write landing between this run's start and its batch.
 */
const racingDb = (first: (db: D1Database) => unknown): D1Database =>
  new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await Promise.resolve(first(target));
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

/** One structured log line, by its event name. */
const logSchema = z.looseObject({ event: z.string() });

/** The `platform.updated` events recorded for `version`, oldest first. */
const updatesOf = async ({
  id,
}: WorkerVersionMetadata): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === "platform.updated" && event.target?.id === id
  );
};

describe("platform updates", () => {
  it("are recorded once per new version, with the change that made it", async () => {
    const version = newVersion();
    await runCron({ CF_VERSION_METADATA: version, PLATFORM_CHANGE: change });
    await runCron({ CF_VERSION_METADATA: version, PLATFORM_CHANGE: change });

    const updates = await updatesOf(version);
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update?.actor).toStrictEqual({ type: "system" });
    expect(update?.target).toStrictEqual({ type: "version", id: version.id });
    expect(update?.detail).toStrictEqual({
      versionId: version.id,
      versionCreatedAt: version.timestamp,
      by: change.by,
      what: change.what,
      release: change.release,
      changedAt: change.at,
    });
    expect(update && auditEventTypeOf(update)).toBe("platform_update");
  });

  it("take the change from a var set as text, as local dev sets it", async () => {
    const version = newVersion();
    await runCron({
      CF_VERSION_METADATA: version,
      PLATFORM_CHANGE: JSON.stringify(change),
    });

    const [update] = await updatesOf(version);
    expect(update?.detail).toMatchObject({ by: change.by });
  });

  it.each([
    ["missing", undefined],
    ["invalid", { ...change, at: "yesterday" }],
  ])("name an unknown change when the var is %s", async (_case, value) => {
    const version = newVersion();
    await runCron({ CF_VERSION_METADATA: version, PLATFORM_CHANGE: value });

    const [update] = await updatesOf(version);
    expect(update?.detail).toStrictEqual({
      versionId: version.id,
      versionCreatedAt: version.timestamp,
      by: "unknown",
      what: "unknown",
      release: "unknown",
      changedAt: null,
    });
  });

  it("are recorded once per version while two versions alternate, as in a gradual rollout", async () => {
    const earlier = newVersion();
    const later = newVersion();
    await runCron({ CF_VERSION_METADATA: earlier });
    await runCron({ CF_VERSION_METADATA: later });
    await runCron({ CF_VERSION_METADATA: earlier });
    await runCron({ CF_VERSION_METADATA: later });

    await expect(updatesOf(earlier)).resolves.toHaveLength(1);
    await expect(updatesOf(later)).resolves.toHaveLength(1);

    const next = newVersion();
    await runCron({ CF_VERSION_METADATA: next });
    await runCron({ CF_VERSION_METADATA: next });
    await runCron({ CF_VERSION_METADATA: earlier });

    await expect(updatesOf(next)).resolves.toHaveLength(1);
    // A rollback to a version already recorded isn't recorded again here:
    // the console tells core of it instead (a notice, below).
    await expect(updatesOf(earlier)).resolves.toHaveLength(1);
  });

  it("are recorded once when cron runs see a new version at the same time", async () => {
    const version = newVersion();
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        await runCron({ CF_VERSION_METADATA: version });
      })
    );

    await expect(updatesOf(version)).resolves.toHaveLength(1);
  });

  it("are recorded once when another run records the version just before this one's write lands", async () => {
    const version = newVersion();
    const racing = racingDb(async (db) => {
      await recordPlatformUpdate({
        ...env,
        DB: db,
        CF_VERSION_METADATA: version,
      });
    });
    await recordPlatformUpdate({
      ...env,
      DB: racing,
      CF_VERSION_METADATA: version,
    });
    // Drains both runs' outbox into the log.
    await runCron({ CF_VERSION_METADATA: version });

    await expect(updatesOf(version)).resolves.toHaveLength(1);
  });

  it("aren't recorded again for the version the job's first release recorded last", async () => {
    const running = newVersion();
    const next = newVersion();
    const migration = migrationsSchema
      .parse(testBinding("CORE_MIGRATIONS"))
      .find(({ name }) => name.startsWith("0018_"));
    if (migration === undefined) {
      throw new Error("Migration 0018 is missing");
    }
    // As before the migration that adds `platform_versions` ran, with the
    // running version in the one row the first release kept. That row is
    // put back as it was afterwards, so later tests see what they did.
    const oldRow = await env.DB.prepare(
      "SELECT version_id, recorded_at FROM platform_version WHERE id = 1"
    ).first<{ version_id: string; recorded_at: number }>();
    await env.DB.exec(
      "ALTER TABLE platform_versions RENAME TO platform_versions_away"
    );
    try {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO platform_version (id, version_id, recorded_at) VALUES (1, ?, ?)"
      )
        .bind(running.id, Date.now())
        .run();
      await env.DB.batch(
        migration.queries.map((query) => env.DB.prepare(query))
      );

      await runCron({ CF_VERSION_METADATA: running });
      await runCron({ CF_VERSION_METADATA: next });
    } finally {
      await env.DB.exec("DROP TABLE IF EXISTS platform_versions");
      await env.DB.exec(
        "ALTER TABLE platform_versions_away RENAME TO platform_versions"
      );
      await (
        oldRow === null
          ? env.DB.prepare("DELETE FROM platform_version WHERE id = 1")
          : env.DB.prepare(
              "INSERT OR REPLACE INTO platform_version (id, version_id, recorded_at) VALUES (1, ?, ?)"
            ).bind(oldRow.version_id, oldRow.recorded_at)
      ).run();
    }

    await expect(updatesOf(running)).resolves.toHaveLength(0);
    await expect(updatesOf(next)).resolves.toHaveLength(1);
  });

  it("are not recorded without version metadata, as on plain workerd", async () => {
    const before = await allEvents();
    await runCron({ CF_VERSION_METADATA: undefined });

    const after = await allEvents();
    expect(
      after
        .slice(before.length)
        .filter((event) => event.action === "platform.updated")
    ).toStrictEqual([]);
  });

  // The isolate warns once in its life (`warnedMissingTable`), and other
  // files share it (`isolate: false` in vite.config.ts): only this test
  // may take the table away, or the warning here was spent already.
  it("wait for their table, warning once, and record the running version once it exists", async () => {
    const version = newVersion();
    // As before the migration that adds it ran.
    await env.DB.exec(
      "ALTER TABLE platform_versions RENAME TO platform_versions_away"
    );
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    const error = vi.spyOn(console, "error").mockReturnValue();
    const events = (spy: typeof warn): string[] =>
      spy.mock.calls.flatMap(([fields]: unknown[]) => {
        const parsed = logSchema.safeParse(fields);
        return parsed.success ? [parsed.data.event] : [];
      });
    try {
      await runCron({ CF_VERSION_METADATA: version });
      await runCron({ CF_VERSION_METADATA: version });
      expect({
        warned: events(warn).filter(
          (event) => event === "platform.update.table_missing"
        ),
        failed: events(error).filter((event) => event === "cron.failed"),
      }).toStrictEqual({
        warned: ["platform.update.table_missing"],
        failed: [],
      });
    } finally {
      warn.mockRestore();
      error.mockRestore();
      await env.DB.exec(
        "ALTER TABLE platform_versions_away RENAME TO platform_versions"
      );
    }
    await expect(updatesOf(version)).resolves.toHaveLength(0);

    await runCron({ CF_VERSION_METADATA: version });

    await expect(updatesOf(version)).resolves.toHaveLength(1);
  });
});

/** A rollback's change, as the console sends it. */
const rollback: PlatformChange = {
  by: "staff@grasp.test",
  what: "rollback",
  release: "r000122-fedcba0",
  at: "2031-01-02T04:00:00.000Z",
};

/** A notice of `change` putting core on `versionId`, sent `sentAt`. */
const noticeBody = (
  versionId: string,
  sentAt = new Date().toISOString()
): string => JSON.stringify({ versionId, change: rollback, sentAt });

/** `body`'s signature as the console makes it, with the key `secret` gives. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET
): Promise<string> => {
  const key = await hkdfHmacKey(secret, platformUpdatePurpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** Sends `body` to core's notice path through the router, signed with `signature`. */
const sendNotice = async (
  body: string,
  signature: string | null,
  method = "POST"
): Promise<number> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  const response = await routed(platformUpdatePath, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
  await response.body?.cancel();
  return response.status;
};

describe("platform update notices", () => {
  it("record a rollback the console signed as a platform update of the version it went back to", async () => {
    const versionId = crypto.randomUUID();
    const body = noticeBody(versionId);

    const status = await sendNotice(body, await signatureOf(body));

    const [update, ...others] = await updatesOf({
      id: versionId,
      tag: "",
      timestamp: "",
    });
    expect({ status, others, update }).toMatchObject({
      status: 204,
      others: [],
      update: {
        actor: { type: "system" },
        action: "platform.updated",
        target: { type: "version", id: versionId },
        detail: {
          versionId,
          versionCreatedAt: null,
          by: rollback.by,
          what: rollback.what,
          release: rollback.release,
          changedAt: rollback.at,
        },
      },
    });
  });

  it("refuse, recording nothing, a notice unsigned, signed with another key, stale, too large, malformed or not posted", async () => {
    const versionId = crypto.randomUUID();
    const body = noticeBody(versionId);
    const stale = noticeBody(
      versionId,
      new Date(Date.now() - platformUpdateMaxSkewMs - 60_000).toISOString()
    );
    const early = noticeBody(
      versionId,
      new Date(Date.now() + platformUpdateMaxSkewMs + 60_000).toISOString()
    );
    // Signed, but padded past the limit with what JSON allows.
    const large = `${body}${" ".repeat(platformUpdateMaxBytes)}`;
    // Signed, but not a notice.
    const notJson = "not json";
    const notNotice = JSON.stringify({ versionId, sentAt: rollback.at });
    const info = vi.spyOn(console, "info").mockReturnValue();

    let statuses: Record<string, number> = {};
    try {
      statuses = {
        unsigned: await sendNotice(body, null),
        otherKey: await sendNotice(
          body,
          await signatureOf(body, "another-auth-secret-of-32-chars-or-more")
        ),
        notHex: await sendNotice(body, "z".repeat(64)),
        stale: await sendNotice(stale, await signatureOf(stale)),
        early: await sendNotice(early, await signatureOf(early)),
        large: await sendNotice(large, await signatureOf(large)),
        notJson: await sendNotice(notJson, await signatureOf(notJson)),
        notNotice: await sendNotice(notNotice, await signatureOf(notNotice)),
        get: await sendNotice(body, await signatureOf(body), "GET"),
      };
    } finally {
      info.mockRestore();
    }

    expect({
      statuses,
      updates: await updatesOf({ id: versionId, tag: "", timestamp: "" }),
    }).toStrictEqual({
      statuses: {
        unsigned: 403,
        otherKey: 403,
        notHex: 403,
        stale: 403,
        early: 403,
        large: 403,
        notJson: 403,
        notNotice: 403,
        get: 404,
      },
      updates: [],
    });
  });
});
