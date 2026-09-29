import type { AuditEntry } from "@grasp-os/shared/audit";
import { listedNotifications } from "@grasp-os/shared/notifications";
import type {
  Notification,
  NotificationsApi,
} from "@grasp-os/shared/notifications";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, count, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { appsFoundBy } from "./app-access.ts";
import { outboxedWhere } from "./audit-outbox.ts";
import { apps, notifications } from "./db/core/schema.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// What core tells a person in the product: for now, that a workflow
// failed while acting for them (who started the run, or, for a run a
// trigger started, the App's owner when it failed). Nobody else is told:
// admins see every run's failure on the Workflows page, and the report
// itself stays there, for those who see it (`seesDetails` in
// workflows/runs.ts). A notification holds IDs and a count, never what
// the run read or its error's words.
//
// A failure notifies in the batch that marks the run failed, audited as
// `workflow.run.notified` in it too, only if that batch ended the run: a
// run ends once, so it notifies once. While a notification of a workflow
// is unread, its next failures count on it, so a workflow failing every
// minute is one notification, not thousands. Behind `run_notifications`,
// with the Workflows kill switch: while off, a failure notifies nobody.
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
 */
export const failureNoticed = (
  db: DrizzleD1Database,
  { run, personId, entry, recorded }: FailureNotice
) => {
  const now = Date.now();
  return [
    // The WHERE keeps SQLite from reading ON CONFLICT as a join.
    db
      .insert(notifications)
      .select(
        sql`SELECT ${crypto.randomUUID()}, ${personId}, 'run_failed', ${run.appId}, ${run.workflowId}, ${run.id}, 1, ${now}, ${now}, NULL WHERE ${recorded}`
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
    outboxedWhere(db, entry, recorded),
  ] as const;
};

/** `person`'s notifications, of Apps they can still open. */
const visibleTo = (env: Env, person: Identity): SQL | undefined =>
  and(eq(notifications.personId, person.userId), appsFoundBy(env, person));

/**
 * The person's latest notifications, and how many of those they can see
 * are unread: two reads of the person's index, joined to each App by its
 * key.
 */
export const listNotifications = async (
  env: Env,
  person: Identity
): Promise<{ notifications: Notification[]; unread: number }> => {
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
      .where(visibleTo(env, person))
      .orderBy(desc(notifications.updatedAt), desc(notifications.id))
      .limit(listedNotifications),
    db
      .select({ count: count() })
      .from(notifications)
      .innerJoin(apps, eq(apps.id, notifications.appId))
      .where(and(visibleTo(env, person), isNull(notifications.readAt))),
  ]);
  return {
    notifications: rows.map(({ updatedAt, readAt, ...row }) => ({
      ...row,
      type: "run_failed",
      at: updatedAt.toISOString(),
      read: readAt !== null,
    })),
    unread: unread?.count ?? 0,
  };
};

/**
 * Marks all of the person's notifications read, and drops those they
 * read over {@link keptReadMs} ago.
 */
export const markNotificationsRead = async (
  env: Env,
  person: Identity
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = new Date();
  await db.batch([
    db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.personId, person.userId),
          isNull(notifications.readAt)
        )
      ),
    db
      .delete(notifications)
      .where(
        and(
          eq(notifications.personId, person.userId),
          lt(notifications.updatedAt, new Date(now.getTime() - keptReadMs)),
          isNotNull(notifications.readAt)
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

  async list(): Promise<{ notifications: Notification[]; unread: number }> {
    return await withPerson(
      this.#check,
      async (person) => await listNotifications(this.#env, person)
    );
  }

  async markRead(): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await markNotificationsRead(this.#env, person);
    });
  }
}
