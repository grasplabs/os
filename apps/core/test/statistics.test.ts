import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import {
  statisticLimitsOf,
  statisticMaxApps,
  statisticRowsPerDay,
} from "@grasp-os/shared/statistics";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { refreshDailySignals } from "../src/daily-signals.ts";
import { recordStatistic, sweepStatistics } from "../src/statistics.ts";
import { release, requestGranted, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Statistics (src/statistics.ts): an App records measures of its own from
// its server code and reads them back added up, and reads the measures
// the platform publishes. These tests start from the ways it can fail: an
// App reads another App's measures, or the platform's of an App whose runs
// the person it acts for may not see; a read or a point goes past its
// bounds (names, dimensions, days, groups, rows a day); a point outside
// the window is counted; a platform read isn't audited; a stub is called
// with no call of the App running; and a read or the sweep reads a table
// whole; an App reads the platform's measures without an admin's grant;
// an App records points faster than a call or a minute allows; and the
// sweep leaves rows past the retention behind.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const dayMs = 24 * 60 * 60 * 1000;

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; token: string };
type Stats = {
  record: (caller: Caller, point: unknown) => Promise<void>;
  read: (caller: Caller, query: unknown) => Promise<unknown>;
};

const outcome = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { ok: (await run()) ?? null };
  } catch (error) {
    return { error: (error as { code?: string }).code ?? "failed" };
  }
};

export class App extends DurableObject {
  get stats(): Stats {
    return (this.env as { STATISTICS: Stats }).STATISTICS;
  }

  async record(caller: Caller, points: unknown[]): Promise<unknown> {
    return await outcome(async () => {
      for (const point of points) {
        await this.stats.record(caller, point);
      }
    });
  }

  async read(caller: Caller, query: unknown, binding = "STATISTICS"): Promise<unknown> {
    const stub = (this.env as Record<string, Stats | undefined>)[binding];
    return await outcome(async () => await (stub as Stats).read(caller, query));
  }

  async readMany(caller: Caller, query: unknown, count: number, binding = "STATISTICS"): Promise<unknown> {
    const stub = (this.env as Record<string, Stats | undefined>)[binding];
    return await outcome(async () => {
      for (let read = 0; read < count; read += 1) {
        await (stub as Stats).read(caller, query);
      }
    });
  }

  async forged(_caller: Caller, query: unknown): Promise<unknown> {
    return await outcome(async () => await this.stats.read({ userId: "x", token: "made-up" }, query));
  }
}
`;

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** A new App running `serverCode`, released by `owner`. */
const statsApp = async (owner: Person): Promise<AppId> => {
  const { id } = await owner.api.apps.create({ name: `Stats ${unique()}` });
  await serverBuilt(
    id,
    await release(owner, id, { "app/server.ts": serverCode })
  );
  return appIdSchema.parse(id);
};

const groupSchema = z.object({
  dimensions: z.record(z.string(), z.string().nullable()),
  count: z.number(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
});

const answerSchema = z.object({
  ok: z.object({
    measure: z.string(),
    from: z.string(),
    to: z.string(),
    groups: z.array(groupSchema),
    truncated: z.boolean(),
  }),
});

/** `count` points of the measure `ticks`. */
const ticks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    measure: "ticks",
    value: index,
  }));

const read = async (app: AppId, userId: string, query: unknown) =>
  await callApp(env, app, as(userId), "read", [query]);

/** A read through the stub of `app`'s permission on the platform's statistics. */
const platformRead = async (app: AppId, userId: string, query: unknown) =>
  await callApp(env, app, as(userId), "read", [query, "PLATFORM"]);

/** `app`'s permission to read the platform's statistics, asked for by `builder`, granted. */
const grantPlatform = async (builder: Person, app: AppId): Promise<void> => {
  await requestGranted(idp, builder, {
    subject: { type: "app", appId: app },
    object: { type: "platform" },
    actions: ["statistics"],
    binding: "PLATFORM",
  });
};

/** A run of `app`'s workflow `workflow`, started `ago` milliseconds back. */
const seedRun = async (app: string, workflow: string, ago = 0) => {
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, ?, 1, NULL, 'completed', ?, ?)"
  )
    .bind(crypto.randomUUID(), app, workflow, Date.now() - ago, Date.now())
    .run();
};

/**
 * Holds the clock from here to the end of the test, as it reads now: core
 * and the App's host read the same `Date`, so the test's points, reads,
 * runs and windows never cross a minute (the rate bounds' counters) or a
 * UTC day, however slow the machine. A test moves it on only on purpose.
 * Held once a test's setup is done: signing in and building an App wait
 * on time passing.
 */
const holdClock = (): number => {
  const at = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return at;
};

describe("an App's own statistics", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are recorded as they come and read back added up, by the dimensions asked, over the days asked", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await statsApp(admin);
    const other = await statsApp(admin);
    holdClock();
    const recorded = await callApp(env, app, as(admin.userId), "record", [
      [
        { measure: "invoices", value: 120, dimensions: { supplier: "acme" } },
        { measure: "invoices", value: 80, dimensions: { supplier: "acme" } },
        { measure: "invoices", value: 40, dimensions: { supplier: "globex" } },
        { measure: "invoices", value: 5 },
      ],
    ]);
    // Eight days ago: outside a week, inside a month.
    await recordStatistic(
      env,
      app,
      { measure: "invoices", value: 1000, dimensions: { supplier: "acme" } },
      { now: new Date(Date.now() - 8 * dayMs) }
    );
    const bySupplier = answerSchema.parse(
      await read(app, admin.userId, {
        measure: "invoices",
        days: 7,
        groupBy: ["supplier"],
      })
    );
    const month = answerSchema.parse(
      await read(app, admin.userId, {
        measure: "invoices",
        days: 30,
        where: { supplier: "acme" },
      })
    );
    const theirs = answerSchema.parse(
      await read(other, admin.userId, { measure: "invoices", days: 30 })
    );
    expect({
      recorded,
      // Most points first; `globex` and none tie, so by name here.
      bySupplier: bySupplier.ok.groups.toSorted(
        (a, b) =>
          b.count - a.count ||
          String(a.dimensions.supplier).localeCompare(
            String(b.dimensions.supplier)
          )
      ),
      truncated: bySupplier.ok.truncated,
      days: bySupplier.ok.to > bySupplier.ok.from,
      month: month.ok.groups,
      theirs: theirs.ok.groups,
    }).toStrictEqual({
      recorded: { ok: null },
      bySupplier: [
        {
          dimensions: { supplier: "acme" },
          count: 2,
          sum: 200,
          min: 80,
          max: 120,
        },
        {
          dimensions: { supplier: "globex" },
          count: 1,
          sum: 40,
          min: 40,
          max: 40,
        },
        {
          dimensions: { supplier: null },
          count: 1,
          sum: 5,
          min: 5,
          max: 5,
        },
      ],
      truncated: false,
      days: true,
      month: [
        {
          dimensions: {},
          count: 3,
          sum: 1200,
          min: 80,
          max: 1000,
        },
      ],
      theirs: [],
    });
  });

  it("stay within their bounds, and are recorded only from a call of the App that's running", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await statsApp(admin);
    holdClock();
    const record = async (point: unknown) =>
      await callApp(env, app, as(admin.userId), "record", [[point]]);
    const query = async (input: unknown) =>
      await read(app, admin.userId, input);
    // A day's rows filled, but for one, by another App's points as much.
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.batch(
      Array.from({ length: statisticRowsPerDay - 1 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO app_statistics (app_id, measure, day, dimensions, count, sum, min, max) VALUES (?, 'filled', ?, ?, 1, 1, 1, 1)"
        ).bind(app, day, JSON.stringify({ n: String(index) }))
      )
    );
    const last = await record({ measure: "late", value: 1 });
    const pastBound = await record({ measure: "later", value: 1 });
    const existing = await record({ measure: "late", value: 2 });
    expect({
      last,
      pastBound,
      existing,
      name: await record({ measure: "Invoices!", value: 1 }),
      platformName: await record({
        measure: "platform.workflow_runs",
        value: 1,
      }),
      dimensions: await record({
        measure: "m",
        value: 1,
        dimensions: { a: "1", b: "2", c: "3", d: "4" },
      }),
      value: await record({ measure: "m", value: 1e13 }),
      tooManyDays: await query({ measure: "m", days: 367 }),
      noDays: await query({ measure: "m", days: 0 }),
      groupTwice: await query({ measure: "m", days: 1, groupBy: ["a", "a"] }),
      forged: await callApp(env, app, as(admin.userId), "forged", [
        { measure: "m", days: 1 },
      ]),
    }).toStrictEqual({
      last: { ok: null },
      pastBound: { error: "statistics.too_many" },
      existing: { ok: null },
      name: { error: "statistics.invalid" },
      platformName: { error: "statistics.invalid" },
      dimensions: { error: "statistics.invalid" },
      value: { error: "statistics.invalid" },
      tooManyDays: { error: "statistics.invalid" },
      noDays: { error: "statistics.invalid" },
      groupTwice: { error: "statistics.invalid" },
      forged: { error: "app.caller_invalid" },
    });
  });

  it("are recorded no faster than a call or a minute allows", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await statsApp(admin);
    holdClock();
    // Lowered for tests (vite.config.ts).
    const {
      perCall: statisticPointsPerCall,
      perMinute: statisticPointsPerMinute,
    } = statisticLimitsOf("point", env.STATISTICS_POINT_LIMITS);
    const call = async (count: number) =>
      await callApp(env, app, as(admin.userId), "record", [ticks(count)]);
    const tooManyInOneCall = await call(statisticPointsPerCall + 1);
    // The rest of the minute's points: that call's first ones count too.
    const calls: unknown[] = [];
    for (
      let recorded = statisticPointsPerCall;
      recorded < statisticPointsPerMinute;
      recorded += statisticPointsPerCall
    ) {
      const count = Math.min(
        statisticPointsPerCall,
        statisticPointsPerMinute - recorded
      );
      // oxlint-disable-next-line no-await-in-loop -- one call after another, as they count
      calls.push(await call(count));
    }
    const overTheMinute = await call(1);
    const counted = answerSchema.parse(
      await read(app, admin.userId, { measure: "ticks", days: 1 })
    );
    expect({
      tooManyInOneCall,
      calls: new Set(calls.map((answer) => JSON.stringify(answer))),
      overTheMinute,
      counted: counted.ok.groups[0]?.count,
    }).toStrictEqual({
      tooManyInOneCall: { error: "statistics.rate_limited" },
      calls: new Set([JSON.stringify({ ok: null })]),
      overTheMinute: { error: "statistics.rate_limited" },
      counted: statisticPointsPerMinute,
    });
  });

  it("are read no more often than a call or a minute allows", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await statsApp(admin);
    holdClock();
    // Lowered for tests (vite.config.ts).
    const { perCall, perMinute } = statisticLimitsOf(
      "read",
      env.STATISTICS_READ_LIMITS
    );
    const query = { measure: "ticks", days: 1 };
    const readMany = async (count: number) =>
      await callApp(env, app, as(admin.userId), "readMany", [query, count]);
    const tooManyInOneCall = await readMany(perCall + 1);
    const calls: unknown[] = [];
    for (let reads = perCall; reads < perMinute; reads += perCall) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another, as they count
      calls.push(await readMany(Math.min(perCall, perMinute - reads)));
    }
    expect({
      tooManyInOneCall,
      calls: new Set(calls.map((answer) => JSON.stringify(answer))),
      overTheMinute: await readMany(1),
    }).toStrictEqual({
      tooManyInOneCall: { error: "statistics.rate_limited" },
      calls: new Set([JSON.stringify({ ok: null })]),
      overTheMinute: { error: "statistics.rate_limited" },
    });
  });

  it("are swept past their retention, however many rows, in one run", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await statsApp(admin);
    holdClock();
    const old = new Date(Date.now() - 500 * dayMs).toISOString().slice(0, 10);
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
       INSERT INTO app_statistics (app_id, measure, day, dimensions, count, sum, min, max)
       SELECT ?, 'old', ?, json_object('n', CAST(i AS TEXT)), 1, 1, 1, 1 FROM n`
    )
      .bind(app, old)
      .run();
    await sweepStatistics(env);
    const left = await env.DB.prepare(
      "SELECT count(*) AS count FROM app_statistics WHERE app_id = ?"
    )
      .bind(app)
      .first<{ count: number }>();
    expect(left?.count).toBe(0);
  });

  it("are read, bounded and swept by their indexes, never a table whole", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await statsApp(admin);
    holdClock();
    // Past the retention: swept.
    await recordStatistic(
      env,
      app,
      { measure: "old", value: 1 },
      { now: new Date(Date.now() - 500 * dayMs) }
    );
    const recorded = await recordedQueries(async () => {
      await callApp(env, app, as(admin.userId), "record", [
        [{ measure: "plan", value: 1, dimensions: { kind: "a" } }],
      ]);
      await read(app, admin.userId, {
        measure: "plan",
        days: 366,
        where: { kind: "a" },
        groupBy: ["kind"],
      });
      await sweepStatistics(env);
    });
    const statements = recorded.filter(({ query }) =>
      query.includes("app_statistics")
    );
    const plans = await Promise.all(statements.map(planOf));
    const left = await env.DB.prepare(
      "SELECT count(*) AS count FROM app_statistics WHERE app_id = ? AND measure = 'old'"
    )
      .bind(app)
      .first<{ count: number }>();
    expect({
      statements: statements.length,
      // The bound's `SELECT` of the point's values is one constant row.
      scans: plans
        .flat()
        .filter((step) => fullScan.test(step) && step !== "SCAN CONSTANT ROW"),
      left: left?.count,
    }).toStrictEqual({ statements: 3, scans: [], left: 0 });
  });
});

describe("the platform's statistics", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("count an App's runs and signals for whoever may see its runs, audited, and nobody else", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await statsApp(builder);
    const watched = await statsApp(admin);
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
      groupBy: ["workflow"],
    };
    // Before an admin grants it the platform's statistics: refused, and
    // recorded as refused.
    let ungranted: unknown;
    const refusedEvents = await auditedDuring(async () => {
      ungranted = await read(reader, admin.userId, query);
    });
    // The stub every App has is never a permission's name.
    const reservedName = await outcome(
      builder.api.permissions.request({
        subject: { type: "app", appId: reader },
        object: { type: "platform" },
        actions: ["statistics"],
        binding: "STATISTICS",
      })
    );
    await grantPlatform(builder, reader);
    holdClock();
    await seedRun(watched, "pay");
    await seedRun(watched, "pay");
    await seedRun(watched, "remind");
    // Before the window of a week.
    await seedRun(watched, "pay", 10 * dayMs);
    const runs = async (userId: string, change: Record<string, unknown> = {}) =>
      await platformRead(reader, userId, { ...query, ...change });
    let byWorkflow: unknown;
    const events = await auditedDuring(async () => {
      byWorkflow = await runs(admin.userId);
    });
    expect({
      byWorkflow: answerSchema.parse(byWorkflow).ok.groups,
      one: answerSchema.parse(
        await runs(admin.userId, {
          where: { app: watched, workflow: "pay" },
          groupBy: [],
        })
      ).ok.groups,
      // A builder of the reading App, with no role in the one it counts.
      builder: await runs(builder.userId),
      noApp: await platformRead(reader, admin.userId, {
        measure: "platform.workflow_runs",
        days: 7,
      }),
      ungranted,
      reservedName,
      // Its own statistics stub reads no platform measure, granted or not.
      ownStub: await read(reader, admin.userId, query),
      unknownDimension: await runs(admin.userId, { groupBy: ["startedBy"] }),
      refusedAudited: refusedEvents
        .filter(({ action }) => action === "statistics.read")
        .map(({ target, detail }) => ({ target, refused: detail.refused })),
      audited: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ actor, target, detail }) => ({ actor, target, detail })),
    }).toStrictEqual({
      byWorkflow: [
        {
          dimensions: { workflow: "pay" },
          count: 2,
          sum: 2,
          min: 1,
          max: 1,
        },
        {
          dimensions: { workflow: "remind" },
          count: 1,
          sum: 1,
          min: 1,
          max: 1,
        },
      ],
      one: [{ dimensions: {}, count: 2, sum: 2, min: 1, max: 1 }],
      builder: { error: "app.not_found" },
      noApp: { error: "statistics.invalid" },
      ungranted: { error: "permission.denied" },
      reservedName: "permission.invalid",
      ownStub: { error: "permission.denied" },
      unknownDimension: { error: "statistics.invalid" },
      refusedAudited: [
        {
          target: { type: "app", id: watched },
          refused: "permission.denied",
        },
      ],
      audited: [
        {
          actor: { type: "app", appId: reader, part: "server" },
          target: { type: "app", id: watched },
          detail: {
            measure: "platform.workflow_runs",
            days: 7,
            onBehalfOf: admin.userId,
          },
        },
      ],
    });
  });

  it("count many Apps' runs in one read, grouped by App, the ones it can't read listed unavailable, audited once with every App asked for", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const reader = await statsApp(builder);
    await grantPlatform(builder, reader);
    // The builder builds `theirs`, not `watched`; `gone` is no App at all.
    const watched = await statsApp(admin);
    const theirs = await statsApp(builder);
    holdClock();
    const gone = crypto.randomUUID();
    await seedRun(watched, "pay");
    await seedRun(watched, "pay");
    await seedRun(theirs, "remind");
    const all = {
      measure: "platform.workflow_runs",
      days: 7,
      apps: [watched, gone, theirs],
      groupBy: ["app", "workflow"],
    };
    const answerOf = (answer: unknown) => {
      const parsed = z
        .object({
          ok: answerSchema.shape.ok.extend({
            unavailable: z.array(z.string()),
          }),
        })
        .parse(answer).ok;
      return {
        groups: parsed.groups.map(({ dimensions, count }) => ({
          ...dimensions,
          count,
        })),
        unavailable: parsed.unavailable,
      };
    };
    let byAdmin: unknown;
    const events = await auditedDuring(async () => {
      byAdmin = await platformRead(reader, admin.userId, all);
    });
    // Ordered by the groups' values: by App ID, then workflow.
    const expected = [
      { app: watched, workflow: "pay", count: 2 },
      { app: theirs, workflow: "remind", count: 1 },
    ].toSorted((one, other) => one.app.localeCompare(other.app));
    expect({
      byAdmin: answerOf(byAdmin),
      // An App the builder may not see is unavailable too, and the rest
      // still counted.
      byBuilder: answerOf(await platformRead(reader, builder.userId, all)),
      audited: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ target, provenance, detail }) => ({
          target,
          provenance,
          apps: detail.apps,
          unavailable: detail.unavailable,
        })),
      ownWithApps: await read(reader, admin.userId, {
        measure: "ticks",
        days: 1,
        apps: [watched],
      }),
      oneAndApps: await platformRead(reader, admin.userId, {
        ...all,
        where: { app: watched },
      }),
      // One App, as `where.app`, is still refused when it can't be read.
      oneGone: await platformRead(reader, admin.userId, {
        measure: "platform.workflow_runs",
        days: 7,
        where: { app: gone },
      }),
    }).toStrictEqual({
      byAdmin: { groups: expected, unavailable: [gone] },
      byBuilder: {
        groups: [{ app: theirs, workflow: "remind", count: 1 }],
        unavailable: [watched, gone],
      },
      // Every App asked for: those it counted, then the unavailable one.
      audited: [
        {
          target: undefined,
          provenance: [watched, theirs, gone],
          apps: 3,
          unavailable: 1,
        },
      ],
      ownWithApps: { error: "statistics.invalid" },
      oneAndApps: { error: "statistics.invalid" },
      oneGone: { error: "app.not_found" },
    });
  });

  it("count the runs and signals of as many Apps as one read takes, by index", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await statsApp(admin);
    await grantPlatform(admin, reader);
    holdClock();
    // As many Apps as a read names, none of them built: only counted.
    const apps = Array.from({ length: statisticMaxApps }, () =>
      crypto.randomUUID()
    ).toSorted();
    await env.DB.batch(
      apps.map((id) =>
        env.DB.prepare(
          "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Counted', '', ?, ?)"
        ).bind(id, admin.userId, Date.now())
      )
    );
    const [first, last] = [apps.at(0) ?? "", apps.at(-1) ?? ""];
    await seedRun(first, "pay");
    await seedRun(last, "pay");
    await seedRun(last, "pay");
    await seedRun(last, "remind");
    const computation = `computation-${unique()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO improvement_signal_computations (id, day, started_at, finished_at) VALUES (?, ?, ?, ?)"
      ).bind(
        computation,
        new Date().toISOString().slice(0, 10),
        Date.now() - 120_000,
        Date.now() - 60_000
      ),
      ...[first, last].map((app) =>
        env.DB.prepare(
          "INSERT INTO improvement_signals (computation, app_id, workflow_id, kind, subject, value, evidence) VALUES (?, ?, 'pay', 'failing_step', 'match', 3, '{}')"
        ).bind(computation, app)
      ),
    ]);
    // Every filter a read takes, with every App it takes.
    const query = { days: 7, apps, groupBy: ["app"] };
    const counts = (answer: unknown) =>
      answerSchema
        .parse(answer)
        .ok.groups.map(({ dimensions, count }) => ({ ...dimensions, count }));
    let runs: unknown;
    let signals: unknown;
    const recorded = await recordedQueries(async () => {
      runs = await platformRead(reader, admin.userId, {
        ...query,
        measure: "platform.workflow_runs",
        where: { workflow: "pay" },
      });
      signals = await platformRead(reader, admin.userId, {
        ...query,
        measure: "platform.improvement_signals",
        where: { workflow: "pay", kind: "failing_step" },
      });
    });
    const plans = await Promise.all(
      recorded
        .filter(({ query: sql }) =>
          /from "(?:apps|improvement_signals|workflow_runs)"/u.test(sql)
        )
        .map(planOf)
    );
    expect({
      runs: counts(runs),
      signals: counts(signals),
      // But for the few computations, as every read of the signals reads.
      scans: plans
        .flat()
        .filter(
          (step) =>
            fullScan.test(step) &&
            step !== "SCAN improvement_signal_computations"
        ),
    }).toStrictEqual({
      runs: [
        { app: first, count: 1 },
        { app: last, count: 2 },
      ],
      signals: [
        { app: first, count: 1 },
        { app: last, count: 1 },
      ],
      scans: [],
    });
  });

  it("page by the groups' values over a window held at `until`, so runs starting between pages neither repeat nor skip a group", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await statsApp(admin);
    await grantPlatform(admin, reader);
    const watched = await statsApp(admin);
    holdClock();
    // 101 workflows ran a minute ago: two pages of groups.
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101) INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) SELECT ?1 || i, ?2, 'w' || i, 1, NULL, 'completed', ?3, ?3 FROM n"
    )
      .bind(`bulk-${unique()}-`, watched, Date.now() - 60_000)
      .run();
    const until = new Date(Date.now() - 1000).toISOString();
    const page = async (offset: number, held = true) =>
      answerSchema.parse(
        await platformRead(reader, admin.userId, {
          measure: "platform.workflow_runs",
          days: 7,
          apps: [watched],
          groupBy: ["workflow"],
          offset,
          ...(held ? { until } : {}),
        })
      ).ok;
    const first = await page(0);
    // Between the pages: a workflow that sorts first starts, and another
    // run of one on the first page.
    await seedRun(watched, "a-first");
    await seedRun(watched, "w1");
    const second = await page(100);
    const groups = [...first.groups, ...second.groups];
    const workflows = groups.map(({ dimensions }) => dimensions.workflow);
    // Without `until`, the new workflow moves every group a place.
    const unheld = await page(100, false);
    expect({
      pages: [first.truncated, second.truncated],
      read: workflows.length,
      distinct: new Set(workflows).size,
      w1: groups.find(({ dimensions }) => dimensions.workflow === "w1")?.count,
      unheldFirst: unheld.groups[0]?.dimensions.workflow,
    }).toStrictEqual({
      pages: [true, false],
      read: 101,
      distinct: 101,
      w1: 1,
      // What the first page ended with, read again.
      unheldFirst: first.groups.at(-1)?.dimensions.workflow,
    });
  });

  it("give the latest improvement signals of an App's workflows by kind, and plan their reads by index", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await statsApp(admin);
    await grantPlatform(admin, reader);
    const watched = await statsApp(admin);
    holdClock();
    /** A finished computation, started `ago` and finished `took` later, with `signals`. */
    const seedComputation = async (
      ago: number,
      took: number,
      signals: readonly (readonly [string, string, string, number])[]
    ) => {
      const id = `computation-${unique()}`;
      const startedAt = Date.now() - ago;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO improvement_signal_computations (id, day, started_at, finished_at) VALUES (?, ?, ?, ?)"
        ).bind(
          id,
          new Date(startedAt).toISOString().slice(0, 10),
          startedAt,
          startedAt + took
        ),
        ...signals.map(([workflow, kind, subject, value]) =>
          env.DB.prepare(
            "INSERT INTO improvement_signals (computation, app_id, workflow_id, kind, subject, value, evidence) VALUES (?, ?, ?, ?, ?, ?, '{}')"
          ).bind(id, watched, workflow, kind, subject, value)
        ),
      ]);
    };
    // The latest computation, within the day read: two minutes ago.
    await seedComputation(120_000, 10_000, [
      ["pay", "failing_step", "match", 4],
      ["pay", "failing_step", "book", 2],
      ["pay", "cost_per_run", "", 0.5],
      ["remind", "failing_step", "send", 1],
    ]);
    // A snapshot's time, after it finished.
    const until = new Date(Date.now() - 60_000).toISOString();
    const signalsRead = async (held: boolean) =>
      answerSchema.parse(
        await platformRead(reader, admin.userId, {
          measure: "platform.improvement_signals",
          days: 1,
          where: { app: watched, workflow: "pay" },
          groupBy: ["kind"],
          ...(held ? { until } : {}),
        })
      ).ok.groups;
    let answer: unknown;
    const recorded = await recordedQueries(async () => {
      answer = await platformRead(reader, admin.userId, {
        measure: "platform.improvement_signals",
        days: 1,
        where: { app: watched, workflow: "pay" },
        groupBy: ["kind"],
      });
      await platformRead(reader, admin.userId, {
        measure: "platform.workflow_runs",
        days: 30,
        where: { app: watched },
        groupBy: ["workflow"],
      });
    });
    const heldBefore = await signalsRead(true);
    // Then one finishes after the snapshot's time, as between its pages,
    // and another is dated after now.
    await seedComputation(30_000, 10_000, [
      ["pay", "failing_step", "later", 9],
    ]);
    await seedComputation(-1000 * dayMs, 0, [
      ["pay", "failing_step", "future", 99],
    ]);
    const heldAfter = await signalsRead(true);
    const current = await signalsRead(false);
    const measured = recorded.filter(({ query }) =>
      /from "(?:improvement_signals|workflow_runs)"/u.test(query)
    );
    const plans = await Promise.all(measured.map(planOf));
    expect({
      groups: answerSchema.parse(answer).ok.groups,
      // Held at the snapshot's time: the same computation before and after
      // another finished.
      held: heldAfter,
      same: JSON.stringify(heldAfter) === JSON.stringify(heldBefore),
      // Not held: the latest finished by now, never one dated later.
      current,
      reads: measured.length,
      // Which computation is the latest reads the computations, as every
      // read of the signals does: a finished one deletes those before it,
      // so there are only ever a few.
      scans: plans
        .flat()
        .filter(
          (step) =>
            fullScan.test(step) &&
            step !== "SCAN improvement_signal_computations"
        ),
    }).toStrictEqual({
      // By kind: the groups' values.
      groups: [
        {
          dimensions: { kind: "cost_per_run" },
          count: 1,
          sum: 0.5,
          min: 0.5,
          max: 0.5,
        },
        {
          dimensions: { kind: "failing_step" },
          count: 2,
          sum: 6,
          min: 2,
          max: 4,
        },
      ],
      held: [
        {
          dimensions: { kind: "cost_per_run" },
          count: 1,
          sum: 0.5,
          min: 0.5,
          max: 0.5,
        },
        {
          dimensions: { kind: "failing_step" },
          count: 2,
          sum: 6,
          min: 2,
          max: 4,
        },
      ],
      same: true,
      current: [
        {
          dimensions: { kind: "failing_step" },
          count: 1,
          sum: 9,
          min: 9,
          max: 9,
        },
      ],
      reads: 2,
      scans: [],
    });
  });

  it("read one signal computation on every page held at `until`, kept while a newer one finishes, and say which", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await statsApp(admin);
    await grantPlatform(admin, reader);
    const watched = await statsApp(admin);
    const held = holdClock();
    const days = (count: number) => new Date(Date.now() + count * dayMs);
    // The production computation: today's, finished before the snapshot.
    await refreshDailySignals(env, days(0));
    const until = new Date(held).toISOString();
    // Past the snapshot's time before anything else finishes.
    vi.setSystemTime(held + 1000);
    const computationRead = async () =>
      z.object({ ok: z.object({ computation: z.string().nullable() }) }).parse(
        await platformRead(reader, admin.userId, {
          measure: "platform.improvement_signals",
          days: 7,
          apps: [watched],
          groupBy: ["kind"],
          until,
        })
      ).ok.computation;
    const first = await computationRead();
    // A newer computation finishes between two pages: the one the first
    // page read is kept, and the next page reads it too.
    await refreshDailySignals(env, days(1));
    const second = await computationRead();
    // Another one: now the first is older than the latest two finished,
    // and goes. A page reading it now says so.
    await refreshDailySignals(env, days(2));
    const third = await computationRead();
    const kept = await env.DB.prepare(
      "SELECT count(*) AS kept FROM improvement_signal_computations WHERE id = ?"
    )
      .bind(first)
      .first<{ kept: number }>();
    expect({
      read: typeof first,
      second: second === first,
      third: third === first,
      kept: kept?.kept,
    }).toStrictEqual({
      read: "string",
      second: true,
      third: false,
      kept: 0,
    });
  });

  it("audit every platform read refused, and why: invalid, or past their bounds, those once a minute", async () => {
    const admin = await signedInApi(idp, "admin");
    const reader = await statsApp(admin);
    await grantPlatform(admin, reader);
    const watched = await statsApp(admin);
    const held = holdClock();
    const query = {
      measure: "platform.workflow_runs",
      days: 7,
      where: { app: watched },
    };
    const { perCall } = statisticLimitsOf("read", env.STATISTICS_READ_LIMITS);
    const readMany = async () =>
      await callApp(env, reader, as(admin.userId), "readMany", [
        query,
        perCall + 1,
        "PLATFORM",
      ]);
    const results: Record<string, unknown> = {};
    const events = await auditedDuring(async () => {
      results.invalid = await platformRead(reader, admin.userId, {
        ...query,
        days: 0,
      });
      results.unknown = await platformRead(reader, admin.userId, {
        measure: "platform.everything",
        days: 7,
      });
      // Two calls past the bound of one in the same minute, audited once;
      // one in the next minute, audited again.
      const minute = Math.floor(held / 60_000) * 60_000;
      vi.setSystemTime(minute + 10_000);
      results.limited = await readMany();
      vi.setSystemTime(minute + 50_000);
      results.limitedAgain = await readMany();
      vi.setSystemTime(minute + 70_000);
      results.nextMinute = await readMany();
    });
    expect({
      results,
      refused: events
        .filter(
          ({ action, detail }) =>
            action === "statistics.read" && detail.refused !== undefined
        )
        .map(({ target, detail }) => ({
          app: target?.id,
          measure: detail.measure,
          refused: detail.refused,
        })),
    }).toStrictEqual({
      results: {
        invalid: { error: "statistics.invalid" },
        unknown: { error: "statistics.invalid" },
        limited: { error: "statistics.rate_limited" },
        limitedAgain: { error: "statistics.rate_limited" },
        nextMinute: { error: "statistics.rate_limited" },
      },
      refused: [
        {
          app: watched,
          measure: "platform.workflow_runs",
          refused: "statistics.invalid",
        },
        {
          app: undefined,
          measure: "platform.unknown",
          refused: "statistics.invalid",
        },
        {
          app: watched,
          measure: "platform.workflow_runs",
          refused: "statistics.rate_limited",
        },
        {
          app: watched,
          measure: "platform.workflow_runs",
          refused: "statistics.rate_limited",
        },
      ],
    });
  });
});
