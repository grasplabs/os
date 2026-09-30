import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  listedNotifications,
  notificationErrors,
} from "@grasp-os/shared/notifications";
import type {
  NotificationCursor,
  NotificationPage,
  NotificationsApi,
} from "@grasp-os/shared/notifications";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, count, desc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { appsFoundBy } from "./app-access.ts";
import { outboxedWhere } from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import { apps, notifications } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// What core tells a person in the product: for now, that a workflow
// failed while acting for them (who started the run, or, for a run a
// trigger started, the App's owner when it failed), while they are a
// member of the organization still. Nobody else is told:
// admins see every run's failure on the Workflows page, and the report
// itself stays there, for those who see it (`seesDetails` in
// workflows/runs.ts). A notification holds IDs and a count, never what
// the run read or its error's words.
//
// A failure notifies in the batch that marks the run failed, audited as
// `workflow.run.notified` in it too, only if that batch ended the run: a
// run ends once, so it notifies once. While a notification of a workflow
// is unread, its next failures count on it, so a workflow failing every
// minute is one notification, not thousands.
//
// A person lists only notifications of Apps they can still open
// (`appsFoundBy`), so one of an App taken from them tells them nothing
// more, not even its name now.

/** How long a person's read notifications are kept. */
const keptReadMs = 30 * 24 * 60 * 60 * 1000;

/** The failed run a notice is for, and whom it tells. */
export interface FailureNotice {
  run: { id: string; appId: string; workflowId: string; version: number };
  personId: string;
  /** Its audit event: `workflow.run.notified`. */
  entry: AuditEntry;
  /**
   * That the failure is recorded, as SQL on what the batch wrote before:
   * the run's own failed event stored. Nothing is written otherwise.
   */
  recorded: SQL;
}

/**
 * The statements that notify `personId` of the failed run, and audit it,
 * in the batch that records the failure: a new unread notification of
 * the workflow, or one more failure counted on the unread one there is.
 * Only while they are a member of the organization, as the batch finds
 * them: someone removed since the run started (members.ts, which deletes
 * their notifications) is told nothing, and the log doesn't say they were.
 */
export const failureNoticed = (
  db: DrizzleD1Database,
  { run, personId, entry, recorded }: FailureNotice
) => {
  const now = Date.now();
  const told = sql`${recorded} AND ${activeMember(personId)}`;
  return [
    // The WHERE keeps SQLite from reading ON CONFLICT as a join.
    db
      .insert(notifications)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${personId}, 'run_failed', ${run.appId}, ${run.workflowId}, ${run.id}, 1, ${now}, ${now}, NULL WHERE ${told}`
      )
      .onConflictDoUpdate({
        target: [
          notifications.personId,
          notifications.type,
          notifications.appId,
          notifications.workflowId,
        ],
        targetWhere: isNull(notifications.readAt),
        set: {
          runId: sql`excluded.run_id`,
          failures: sql`${notifications.failures} + 1`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
    outboxedWhere(db, entry, told),
  ] as const;
};

/** `person`'s notifications, of Apps they can still open. */
const visibleTo = (env: Env, person: Identity): SQL | undefined =>
  and(eq(notifications.personId, person.userId), appsFoundBy(env, person));

/** Where a page goes on from, as the page passes it. */
const cursorSchema = z
  .object({ at: z.iso.datetime(), id: z.string().max(64) })
  .optional();

/**
 * A page of the person's notifications, the latest or those older than
 * `before`, and how many of all they can see are unread: two reads of the
 * person's index, in its order (time, then ID), joined to each App by its
 * key.
 */
export const listNotifications = async (
  env: Env,
  person: Identity,
  before?: unknown
): Promise<NotificationPage> => {
  const cursor = cursorSchema.safeParse(before);
  if (!cursor.success) {
    throw notificationErrors.create("notification.invalid");
  }
  const after =
    cursor.data === undefined
      ? undefined
      : sql`(${notifications.updatedAt}, ${notifications.id}) < (${new Date(cursor.data.at).getTime()}, ${cursor.data.id})`;
  const db = drizzle(env.DB);
  const [rows, [unread]] = await db.batch([
    db
      .select({
        id: notifications.id,
        app: notifications.appId,
        appName: apps.name,
        workflow: notifications.workflowId,
        run: notifications.runId,
        failures: notifications.failures,
        updatedAt: notifications.updatedAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .innerJoin(apps, eq(apps.id, notifications.appId))
      .where(and(visibleTo(env, person), after))
      .orderBy(desc(notifications.updatedAt), desc(notifications.id))
      // One past the page: whether more follow.
      .limit(listedNotifications + 1),
    db
      .select({ count: count() })
      .from(notifications)
      .innerJoin(apps, eq(apps.id, notifications.appId))
      .where(and(visibleTo(env, person), isNull(notifications.readAt))),
  ]);
  return {
    notifications: rows
      .slice(0, listedNotifications)
      .map(({ updatedAt, readAt, ...row }) => ({
        ...row,
        type: "run_failed",
        at: updatedAt.toISOString(),
        read: readAt !== null,
      })),
    unread: unread?.count ?? 0,
    more: rows.length > listedNotifications,
  };
};

/** What `markRead` is told the person saw: IDs, and the newest time. */
const shownSchema = z.object({
  ids: z.array(z.string().max(64)).max(listedNotifications),
  upTo: z.iso.datetime(),
});

/**
 * Marks read the person's notifications `ids` whose latest failure is no
 * later than `upTo`, and drops those they read over {@link keptReadMs}
 * ago.
 */
export const markNotificationsRead = async (
  env: Env,
  person: Identity,
  ids: unknown,
  upTo: unknown
): Promise<void> => {
  const shown = shownSchema.safeParse({ ids, upTo });
  if (!shown.success) {
    throw notificationErrors.create("notification.invalid");
  }
  const db = drizzle(env.DB);
  const now = new Date();
  await db.batch([
    db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.personId, person.userId),
          isNull(notifications.readAt),
          inList(notifications.id, shown.data.ids),
          lte(notifications.updatedAt, new Date(shown.data.upTo))
        )
      ),
    db
      .delete(notifications)
      .where(
        and(
          eq(notifications.personId, person.userId),
          lt(notifications.readAt, new Date(now.getTime() - keptReadMs))
        )
      ),
  ]);
};

/** The signed-in person's notifications, over `/rpc`. */
export class NotificationsRpc extends RpcTarget implements NotificationsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(before?: NotificationCursor): Promise<NotificationPage> {
    return await withPerson(
      this.#check,
      async (person) => await listNotifications(this.#env, person, before)
    );
  }

  async markRead(ids: string[], upTo: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await markNotificationsRead(this.#env, person, ids, upTo);
    });
  }
}
