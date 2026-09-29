import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { startRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { finished } from "./runs.ts";
import { refusal, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// A failed run tells the person it acted for, in the product. The ways it
// can fail come first: someone else is told of it, or nobody is; a
// workflow failing every minute buries the person in notifications; a
// notification outlives the person's access to its App; it goes
// unrecorded; the list reads the whole table.

const idp = mockIdp();

/** Signing people in and running workflows can be slow on CI. */
const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A workflow that fails in its one step, with the workflow's own words. */
const failing = (id: string) =>
  workflowFiles(
    id,
    `  await step.do("check", { description: "Check" }, async () => {
    throw new Error("Customer c-1 is blocked");
  });`,
    { check: null }
  );

/** A run of `workflow` that `person` started, once it has ended. */
const failedRun = async (person: Person, app: string, workflow: string) => {
  const run = await person.api.workflows.start(app, workflow);
  await finished(run.id);
  return run.id;
};

/** The person's notifications, as the page lists them. */
const listed = async (person: Person) => {
  const { notifications, unread } = await person.api.notifications.list();
  return {
    unread,
    notifications: notifications.map(({ workflow, run, failures, read }) => ({
      workflow,
      run,
      failures,
      read,
    })),
  };
};

/** Reads the person's notifications as the page does: listed, then read. */
const readAll = async (person: Person): Promise<void> => {
  const { notifications } = await person.api.notifications.list();
  const [newest] = notifications;
  if (newest !== undefined) {
    await person.api.notifications.markRead(
      notifications.map(({ id }) => id),
      newest.at
    );
  }
};

const dayMs = 24 * 60 * 60 * 1000;

/** A notification of `personId`'s, stored as it is. */
const storedNotice = async (
  personId: string,
  app: string,
  workflow: string,
  { updatedAt, readAt }: { updatedAt: number; readAt: number | null }
): Promise<string> => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO notifications (id, person_id, type, app_id, workflow_id, run_id, failures, created_at, updated_at, read_at) VALUES (?, ?, 'run_failed', ?, ?, ?, 1, ?, ?, ?)"
  )
    .bind(
      id,
      personId,
      app,
      workflow,
      crypto.randomUUID(),
      updatedAt,
      updatedAt,
      readAt
    )
    .run();
  return id;
};

/** The IDs of `personId`'s notifications as stored, whatever they list. */
const storedOf = async (personId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM notifications WHERE person_id = ? ORDER BY id"
  )
    .bind(personId)
    .all<{ id: string }>();
  return results.map(({ id }) => id);
};

describe("failed runs", slow, () => {
  it("notify the person each acted for, once per workflow until they read it", async () => {
    const owner = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const app = await appWith(owner, failing("careless"));
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });

    const first = await failedRun(owner, app, "careless");
    const second = await failedRun(owner, app, "careless");
    const counted = await listed(owner);
    await readAll(owner);
    const third = await failedRun(owner, app, "careless");
    // A trigger's run acts for the App's owner; the user's for the user.
    const byTrigger = await startRun(env, {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("careless"),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
    });
    await finished(byTrigger.id);
    const byUser = await failedRun(user, app, "careless");

    const runs = new Set<string>([first, second, third, byTrigger.id, byUser]);
    const events = await allEvents();
    const notified = events
      .filter(({ action }) => action === "workflow.run.notified")
      .filter(({ target }) => runs.has(target?.id ?? ""))
      .map(({ target, detail }) => [target?.id, detail.person]);
    const adminListed = await listed(admin);
    expect({
      counted,
      owner: await listed(owner),
      user: await listed(user),
      // Admins see every failure on the Workflows page, and aren't told.
      admin: adminListed.notifications.filter(({ run }) => runs.has(run)),
      notified,
    }).toStrictEqual({
      counted: {
        unread: 1,
        notifications: [
          { workflow: "careless", run: second, failures: 2, read: false },
        ],
      },
      owner: {
        unread: 1,
        notifications: [
          {
            workflow: "careless",
            run: byTrigger.id,
            failures: 2,
            read: false,
          },
          { workflow: "careless", run: second, failures: 2, read: true },
        ],
      },
      user: {
        unread: 1,
        notifications: [
          { workflow: "careless", run: byUser, failures: 1, read: false },
        ],
      },
      admin: [],
      notified: [
        [first, owner.userId],
        [second, owner.userId],
        [third, owner.userId],
        [byTrigger.id, owner.userId],
        [byUser, user.userId],
      ],
    });
  });

  it("notify a run that failed to start, as any failed run", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await appWith(owner, failing("unstartable"));
    // An ID core's record takes but Workflows refuses (over 100
    // characters), so creating the run fails after its row is written.
    const taken: ReturnType<typeof crypto.randomUUID> =
      `run-${"x".repeat(100)}-${crypto.randomUUID()}`;
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(taken);
    try {
      await refusal(
        startRun(env, {
          app: appIdSchema.parse(app),
          workflow: workflowIdSchema.parse("unstartable"),
          input: undefined,
          startedBy: owner.userId,
          actor: { type: "system" },
        })
      );
    } finally {
      uuid.mockRestore();
    }

    await expect(listed(owner)).resolves.toStrictEqual({
      unread: 1,
      notifications: [
        { workflow: "unstartable", run: taken, failures: 1, read: false },
      ],
    });
  });

  it("stop telling a person of an App they can no longer open", async () => {
    const owner = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const app = await appWith(owner, failing("careless"));
    const member = { type: "person", id: user.userId } as const;
    await owner.api.apps.members.add(app, { ...member, role: "user" });
    await failedRun(user, app, "careless");
    const before = await listed(user);
    await owner.api.apps.members.remove(app, member);

    expect({ before: before.unread, after: await listed(user) }).toStrictEqual({
      before: 1,
      after: { unread: 0, notifications: [] },
    });
  });

  it("are marked read only as the page showed them: a failure since stays unread", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await appWith(owner, failing("careless"));
    await failedRun(owner, app, "careless");
    const { notifications } = await owner.api.notifications.list();
    const later = await failedRun(owner, app, "careless");
    const [shown] = notifications;
    if (shown === undefined) {
      throw new Error("Expected the failure listed");
    }
    await owner.api.notifications.markRead([shown.id], shown.at);

    await expect(listed(owner)).resolves.toStrictEqual({
      unread: 1,
      notifications: [
        { workflow: "careless", run: later, failures: 2, read: false },
      ],
    });
  });

  it("keep what was read for 30 days, and what is unread however old", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await appWith(owner, failing("careless"));
    const now = Date.now();
    const readLongAgo = await storedNotice(owner.userId, app, "old", {
      updatedAt: now - 40 * dayMs,
      readAt: now - 31 * dayMs,
    });
    const readLately = await storedNotice(owner.userId, app, "recent", {
      updatedAt: now - 40 * dayMs,
      readAt: now - dayMs,
    });
    // Failed long ago, read only now: kept 30 days from now.
    const unreadOld = await storedNotice(owner.userId, app, "unread", {
      updatedAt: now - 40 * dayMs,
      readAt: null,
    });
    await readAll(owner);

    expect({
      stored: await storedOf(owner.userId),
      gone: readLongAgo,
    }).toStrictEqual({
      stored: [readLately, unreadOld].toSorted((one, other) =>
        one.localeCompare(other)
      ),
      gone: readLongAgo,
    });
  });

  it("go with a person removed from the organization", async () => {
    const owner = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const app = await appWith(owner, failing("careless"));
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await failedRun(user, app, "careless");
    const before = await storedOf(user.userId);
    await admin.api.members.remove(user.userId);

    expect({
      before: before.length,
      after: await storedOf(user.userId),
    }).toStrictEqual({ before: 1, after: [] });
  });

  it("refuse marking read what no list showed", async () => {
    const owner = await signedInApi(idp, "builder");
    await expect(
      Promise.all([
        refusal(owner.api.notifications.markRead([], "yesterday")),
        refusal(
          owner.api.notifications.markRead(
            Array.from({ length: 51 }, () => crypto.randomUUID()),
            new Date().toISOString()
          )
        ),
      ])
    ).resolves.toMatchObject([
      { code: "notification.invalid" },
      { code: "notification.invalid" },
    ]);
  });

  it("page past the latest 50, marking read only the page shown", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await appWith(owner, failing("careless"));
    const now = Date.now();
    // 55 unread, the two oldest at the same time: told apart by ID.
    const stored = await Promise.all(
      Array.from(
        { length: 55 },
        async (_, index) =>
          await storedNotice(owner.userId, app, `workflow-${index}`, {
            updatedAt: now - Math.min(index, 53) * 1000,
            readAt: null,
          })
      )
    );
    const first = await owner.api.notifications.list();
    const shownFirst = first.notifications.map(({ id }) => id);
    const [newest] = first.notifications;
    const last = first.notifications.at(-1);
    if (newest === undefined || last === undefined) {
      throw new Error("Expected a first page");
    }
    await owner.api.notifications.markRead(shownFirst, newest.at);
    const second = await owner.api.notifications.list({
      at: last.at,
      id: last.id,
    });

    expect({
      first: [shownFirst.length, first.unread, first.more],
      second: [
        second.notifications.length,
        second.unread,
        second.more,
        second.notifications.every(({ read }) => !read),
      ],
      // Every one shown once, in time order, then by ID.
      all: [...shownFirst, ...second.notifications.map(({ id }) => id)],
    }).toStrictEqual({
      first: [50, 55, true],
      second: [5, 5, false, true],
      all: [
        ...stored.slice(0, 53),
        ...stored.slice(53).toSorted((one, other) => other.localeCompare(one)),
      ],
    });
  });

  it("tell nobody while switched off", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await appWith(owner, failing("careless"));
    const { FEATURES } = env;
    env.FEATURES = {
      ...z.record(z.string(), z.boolean()).parse(FEATURES),
      run_notifications: false,
    };
    let run: string;
    try {
      run = await failedRun(owner, app, "careless");
    } finally {
      env.FEATURES = FEATURES;
    }
    const events = await allEvents();

    expect({
      listed: await listed(owner),
      failed: events.some(
        ({ action, target }) =>
          action === "workflow.run.failed" && target?.id === run
      ),
      notified: events.some(
        ({ action, target }) =>
          action === "workflow.run.notified" && target?.id === run
      ),
    }).toStrictEqual({
      listed: { unread: 0, notifications: [] },
      failed: true,
      notified: false,
    });
  });

  it("are listed and read by the person's own index, with no sort of their own", async () => {
    const owner = await signedInApi(idp, "builder");
    const queries = await recordedQueries(async () => {
      await owner.api.notifications.list();
      await owner.api.notifications.list({
        at: new Date().toISOString(),
        id: crypto.randomUUID(),
      });
      await owner.api.notifications.markRead(
        [crypto.randomUUID()],
        new Date().toISOString()
      );
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => query.includes('"notifications"'))
        .map(async (recorded) => await planOf(recorded))
    );

    expect({
      lists: plans.length,
      byIndex: plans.map((plan) =>
        plan.some((step) => /SEARCH notifications USING/u.test(step))
      ),
      scans: plans.flat().filter((step) => fullScan.test(step)),
      sorts: plans.flat().filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({
      // A page, its unread count, an older page and its count, marking
      // read and dropping old ones.
      lists: 6,
      byIndex: [true, true, true, true, true, true],
      scans: [],
      sorts: [],
    });
  });
});
