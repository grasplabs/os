import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { ImprovementSignal } from "@grasp-os/shared/signals";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { stringify } from "yaml";
import type { z } from "zod";

import { auditLog } from "../src/audit-log.ts";
import worker from "../src/index.ts";
import { refreshSignalsIfDue, signalsCron } from "../src/signals.ts";
import { allEvents, logHead } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, refusal, signedInApi, unique } from "./sign-in.ts";

// Improvement signals from runs, decisions and the audit log, computed
// once a day. Each test seeds its own App's runs, decisions and events,
// computes the signals as of a day of its own (later than the last
// test's), and reads them through the API: as an admin, who sees them
// whole, unless the test is about what builders see.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

/** Each computation's day: a day after the last test's, from tomorrow on. */
let days = 0;
const nextDay = (): Date => {
  days += 1;
  return new Date(Date.now() + days * dayMs);
};

/** A builder with an App of their own. */
const builderWithApp = async (): Promise<Person & { app: string }> => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: `Signals ${unique()}` });
  return { ...builder, app: id };
};

/** An admin's API, who reads every signal whole. */
const adminApi = async (): Promise<Person["api"]> => {
  const { api } = await signedInApi(idp, "admin");
  return await api;
};

/**
 * Gives the App a running version with `workflows`: committed as any
 * version is, and made current here, without the build and tests making
 * it current takes, which aren't what these tests are about.
 */
const running = async (
  { api, app }: Person & { app: string },
  ...workflows: string[]
): Promise<void> => {
  await api.apps.files.write(
    app,
    Object.fromEntries(
      workflows.map((workflow) => [
        `workflows/${workflow}.ts`,
        "export default {};\n",
      ])
    )
  );
  const { version } = await api.apps.files.commit(app, "Workflows");
  await env.DB.prepare("UPDATE apps SET current_version = ? WHERE id = ?")
    .bind(version, app)
    .run();
};

/** The computations of `day` there are, finished or not. */
const claimsOf = async (day: Date): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS claims FROM improvement_signal_computations WHERE day = ?"
  )
    .bind(day.toISOString().slice(0, 10))
    .first<{ claims: number }>();
  return row?.claims ?? 0;
};

/** The signals the computations of `day` wrote. */
const signalsOf = async (day: Date): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS signals FROM improvement_signals s JOIN improvement_signal_computations c ON c.id = s.computation WHERE c.day = ?"
  )
    .bind(day.toISOString().slice(0, 10))
    .first<{ signals: number }>();
  return row?.signals ?? 0;
};

/**
 * Core's database, running `first` once, just before the first batch sent
 * while `when` holds.
 */
const racingWhen = (
  when: () => Promise<boolean>,
  first: () => Promise<void>
): D1Database => {
  let raced = false;
  return new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced && (await when())) {
            raced = true;
            await first();
          }
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

/** Runs core's cron trigger `schedule`, as Cloudflare does. */
const cron = async (schedule: string): Promise<void> => {
  await worker.scheduled(createScheduledController({ cron: schedule }), env);
};

/** A claim of `day`'s computation, started `ago` before `day`, unfinished. */
const seedClaim = async (day: Date, ago: number): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO improvement_signal_computations (id, day, started_at) VALUES (?, ?, ?)"
  )
    .bind(
      crypto.randomUUID(),
      day.toISOString().slice(0, 10),
      day.getTime() - ago
    )
    .run();
};

interface SeededRun {
  workflow: string;
  status?: string;
  createdAt: Date;
  endedAt?: Date;
  failure?: { step: string | null; code: string; message?: string };
}

/** A run of `app`'s, as core keeps it; returns its ID. */
const seedRun = async (app: string, run: SeededRun): Promise<string> => {
  const id = `run-${unique()}`;
  const failure =
    run.failure === undefined
      ? null
      : JSON.stringify({
          run: id,
          app,
          workflow: run.workflow,
          version: 1,
          step: run.failure.step,
          input: null,
          error: {
            code: run.failure.code,
            message: run.failure.message ?? "It failed",
          },
          failedAt: (run.endedAt ?? run.createdAt).toISOString(),
        });
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, failure) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?)"
  )
    .bind(
      id,
      app,
      run.workflow,
      run.status ?? "running",
      run.createdAt.getTime(),
      run.endedAt?.getTime() ?? null,
      failure
    )
    .run();
  return id;
};

interface SeededDecision {
  step: string;
  deciders?: string;
  status?: "open" | "approved" | "rejected" | "timed_out";
  openedAt: Date;
  expiresAt: Date;
  decidedAt?: Date;
  description?: string;
  payload?: unknown;
}

/** A decision of `run`'s; returns its ID. */
const seedDecision = async (
  run: string,
  decision: SeededDecision
): Promise<string> => {
  const id = `decision-${unique()}`;
  await env.DB.prepare(
    "INSERT INTO workflow_decisions (id, run_id, step, deciders, description, status, opened_at, expires_at, decided_by, decided_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      id,
      run,
      decision.step,
      decision.deciders ?? "role:admin",
      decision.description ?? "Approve it",
      decision.status ?? "open",
      decision.openedAt.getTime(),
      decision.expiresAt.getTime(),
      decision.decidedAt === undefined ? null : "someone",
      decision.decidedAt?.getTime() ?? null,
      decision.payload === undefined ? null : JSON.stringify(decision.payload)
    )
    .run();
  return id;
};

/**
 * More decisions of `run`'s than one page of a read holds, all alike but
 * for their keyed steps (`<step>:<n>`).
 */
const seedDecisions = async (
  run: string,
  step: string,
  decision: Omit<SeededDecision, "step">
): Promise<void> => {
  const statements = Array.from({ length: 600 }, (_, index) =>
    env.DB.prepare(
      "INSERT INTO workflow_decisions (id, run_id, step, deciders, description, status, opened_at, expires_at, decided_by, decided_at) VALUES (?, ?, ?, ?, 'Approve it', ?, ?, ?, ?, ?)"
    ).bind(
      `decision-${unique()}-${index}`,
      run,
      `${step}:${index}`,
      decision.deciders ?? "role:admin",
      decision.status ?? "open",
      decision.openedAt.getTime(),
      decision.expiresAt.getTime(),
      decision.decidedAt === undefined ? null : "someone",
      decision.decidedAt?.getTime() ?? null
    )
  );
  await env.DB.batch(statements);
};

/** Appends events to the deployment's log, as draining an outbox does. */
const logged = async (
  ...entries: Partial<z.input<typeof auditEventSchema>>[]
): Promise<string[]> => {
  const events: AuditEvent[] = entries.map((entry) =>
    auditEventSchema.parse({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: "core",
      actor: { type: "system" },
      action: "model.call",
      ...entry,
    })
  );
  await auditLog(env).append(events);
  return events.map(({ id }) => id);
};

/** When the log received the event `id`, appended after position `after`. */
const receivedAtOf = async (id: string, after: number): Promise<string> => {
  let page = await auditLog(env).entries(after);
  while (page.length > 0) {
    const found = page.find(({ event }) => event.includes(id));
    if (found !== undefined) {
      return found.receivedAt;
    }
    // Pages are read one after another.
    // oxlint-disable-next-line no-await-in-loop
    page = await auditLog(env).entries(page.at(-1)?.seq);
  }
  throw new Error(`The log has no event ${id}`);
};

/** A workflow run's actor in the audit log. */
const runActor = (app: string, workflow: string, run: string) => ({
  type: "workflow" as const,
  appId: app,
  workflowId: workflow,
  runId: run,
});

/** A model call a run made, at `amount` US dollars. */
const modelCall = (
  app: string,
  workflow: string,
  run: string,
  amount: number
) => ({
  actor: runActor(app, workflow, run),
  action: "model.call",
  cost: { amount, currency: "USD" },
});

/** A Knowledge search that found nothing, by `actor`. */
const emptySearch = (
  actor: z.input<typeof auditEventSchema>["actor"],
  queryKey: string,
  collection?: string
) => ({
  actor,
  action: "knowledge.search.empty",
  ...(collection === undefined
    ? {}
    : { target: { type: "collection", id: collection } }),
  detail: { terms: 3, queryKey, sensitive: false },
});

/**
 * A Playbook workflow record, linked to `app`'s `workflow`, as the save
 * pipeline stores it; returns its document ID.
 */
const seedRecord = async (
  app: string,
  workflow: string,
  fields: Record<string, unknown>
): Promise<string> => {
  const id = `record-${unique()}`;
  const now = Date.now();
  const text = `---\n${stringify({
    type: "workflow",
    title: `Workflow ${workflow}`,
    state: "designed",
    app: { appId: app, workflowId: workflow },
    ...fields,
  })}---\nHow it goes.\n`;
  await env.KNOWLEDGE.batch([
    env.KNOWLEDGE.prepare(
      "INSERT OR IGNORE INTO collections (id, name, description, owner, access, sensitive, source, created_at) VALUES ('playbook', 'Playbook', 'The Playbook', 'admin', 'everyone', 0, 'playbook', ?)"
    ).bind(now),
    env.KNOWLEDGE.prepare(
      "INSERT INTO documents (id, collection_id, path, title, type, description, owner, tags, current_version, created_at, updated_at) VALUES (?, 'playbook', ?, ?, 'workflow', '', 'admin', '[]', 1, ?, ?)"
    ).bind(id, `workflows/${id}.md`, `Workflow ${workflow}`, now, now),
    env.KNOWLEDGE.prepare(
      "INSERT INTO versions (document_id, number, text, author, created_at) VALUES (?, 1, ?, 'admin', ?)"
    ).bind(id, text, now),
  ]);
  return id;
};

/** The signals of `kind` in `list`, without the App (the tests' own). */
const ofKind = <Kind extends ImprovementSignal["kind"]>(
  signals: readonly ImprovementSignal[],
  kind: Kind
) =>
  signals
    .filter(
      (signal): signal is Extract<ImprovementSignal, { kind: Kind }> =>
        signal.kind === kind
    )
    .map(({ app: _app, ...signal }) => signal);

/**
 * Unanswered questions without when each was last asked, which the log
 * sets as it receives them; and whether every one was since `since`.
 */
const questions = (signals: readonly ImprovementSignal[], since: number) => {
  const found = signals.filter(
    (
      signal
    ): signal is Extract<ImprovementSignal, { kind: "unanswered_question" }> =>
      signal.kind === "unanswered_question"
  );
  return {
    recent: found.every(({ evidence }) => Date.parse(evidence.lastAt) >= since),
    questions: found.map(
      ({ evidence: { lastAt: _lastAt, ...evidence }, ...signal }) => ({
        ...signal,
        evidence,
      })
    ),
  };
};

/** How many computations the audit log recorded for `day`. */
const computationsOf = async (day: Date): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, detail }) =>
      action === "improvement.signals.computed" &&
      detail.day === day.toISOString().slice(0, 10)
  ).length;
};

describe("improvement signals", () => {
  it("rank each workflow's runs waiting for a person by the deciders they wait for", async () => {
    const { app } = await builderWithApp();
    const api = await adminApi();
    const now = nextDay();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const later = new Date(now.getTime() + dayMs);
    const first = await seedRun(app, {
      workflow: "invoices",
      createdAt: ago(4 * dayMs),
    });
    const second = await seedRun(app, {
      workflow: "invoices",
      createdAt: ago(2 * dayMs),
    });
    const ended = await seedRun(app, {
      workflow: "invoices",
      status: "cancelled",
      createdAt: ago(dayMs),
      endedAt: ago(dayMs),
    });
    const oldest = await seedDecision(first, {
      step: "review",
      openedAt: ago(3 * dayMs),
      expiresAt: later,
    });
    const newer = await seedDecision(second, {
      step: "review",
      openedAt: ago(dayMs),
      expiresAt: later,
    });
    const team = await seedDecision(second, {
      step: "sign:off#ask",
      deciders: "team:finance",
      openedAt: ago(2 * hourMs),
      expiresAt: later,
    });
    // Not waiting: answered, past its deadline, or of a run that ended.
    await seedDecision(first, {
      step: "answered",
      status: "approved",
      openedAt: ago(4 * dayMs),
      expiresAt: later,
      decidedAt: ago(3 * dayMs),
    });
    await seedDecision(first, {
      step: "expired",
      openedAt: ago(5 * dayMs),
      expiresAt: ago(hourMs),
    });
    await seedDecision(ended, {
      step: "review",
      openedAt: ago(9 * dayMs),
      expiresAt: later,
    });
    // More than a page of them, all newer.
    await seedDecisions(second, "review", {
      openedAt: ago(hourMs),
      expiresAt: later,
    });

    await refreshSignalsIfDue(env, now);
    const { signals } = await api.signals.list({ app });

    // The first two of the oldest each names, and how many it names.
    const waiting = ofKind(signals, "waiting_for_person").map(
      ({ evidence, ...signal }) => ({
        ...signal,
        evidence: {
          ...evidence,
          oldest: evidence.oldest?.slice(0, 2),
          named: evidence.oldest?.length,
        },
      })
    );
    expect(waiting).toStrictEqual([
      {
        kind: "waiting_for_person",
        workflow: "invoices",
        subject: "role:admin",
        value: 3 * dayMs,
        evidence: {
          open: 602,
          named: 5,
          oldest: [
            {
              decision: oldest,
              run: first,
              step: "review",
              openedAt: ago(3 * dayMs).toISOString(),
            },
            {
              decision: newer,
              run: second,
              step: "review",
              openedAt: ago(dayMs).toISOString(),
            },
          ],
        },
      },
      {
        kind: "waiting_for_person",
        workflow: "invoices",
        subject: "team:finance",
        value: 2 * hourMs,
        evidence: {
          open: 1,
          named: 1,
          // A keyed step by its name alone: its key can be what the run read.
          oldest: [
            {
              decision: team,
              run: second,
              step: "sign",
              openedAt: ago(2 * hourMs).toISOString(),
            },
          ],
        },
      },
    ]);
  });

  it("count the steps runs failed at, with their error codes and every page of failures", async () => {
    const builder = await builderWithApp();
    const { app } = builder;
    await running(builder, "sync");
    const api = await adminApi();
    const now = nextDay();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const failed = async (step: string | null, code: string, endedMs: number) =>
      await seedRun(app, {
        workflow: "sync",
        status: "failed",
        createdAt: ago(endedMs + hourMs),
        endedAt: ago(endedMs),
        failure: { step, code },
      });
    // More failures than one page holds, all at one step.
    const statements = Array.from({ length: 600 }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, status, created_at, ended_at, failure) VALUES (?, ?, 'sync', 1, 'failed', ?, ?, ?)"
      ).bind(
        `bulk-${unique()}-${index}`,
        app,
        ago(3 * dayMs).getTime(),
        ago(3 * dayMs).getTime(),
        JSON.stringify({
          step: "fetch",
          error: { code: "connect.rate_limited", message: "x" },
        })
      )
    );
    await env.DB.batch(statements);
    const keyed = await failed(
      "fetch:person%40acme.test",
      "connect.action_failed",
      2 * hourMs
    );
    const latest = await failed("fetch", "Not a code!", hourMs);
    const outside = await failed(null, "workflow.run_failed", dayMs);
    await seedRun(app, {
      workflow: "sync",
      status: "completed",
      createdAt: ago(dayMs),
      endedAt: ago(dayMs),
    });
    // Before the window: not counted.
    await failed("fetch", "connect.action_failed", 40 * dayMs);

    await refreshSignalsIfDue(env, now);
    const { signals } = await api.signals.list({ app, workflow: "sync" });
    const missing = await outcome(
      api.signals.list({ app, workflow: "missing" })
    );
    const [fetch, none] = ofKind(signals, "failing_step");

    expect({
      fetch: fetch && {
        ...fetch,
        evidence: {
          ...fetch.evidence,
          recent: fetch.evidence.recent?.slice(0, 2),
        },
      },
      none,
      missing,
    }).toStrictEqual({
      fetch: {
        kind: "failing_step",
        workflow: "sync",
        subject: "fetch",
        value: 602,
        evidence: {
          failures: 602,
          runs: 604,
          errors: [
            { code: "connect.rate_limited", count: 600 },
            { code: "connect.action_failed", count: 1 },
            // A code the audit log couldn't take, as a fixed one.
            { code: "workflow.run_failed", count: 1 },
          ],
          recent: [latest, keyed],
        },
      },
      none: {
        kind: "failing_step",
        workflow: "sync",
        subject: null,
        value: 1,
        evidence: {
          failures: 1,
          runs: 604,
          errors: [{ code: "workflow.run_failed", count: 1 }],
          recent: [outside],
        },
      },
      // A workflow the running version doesn't have matches nothing.
      missing: "signal.invalid",
    });
  });

  it("find the steps whose decisions keep rejecting what the workflow proposed", async () => {
    const { app } = await builderWithApp();
    const api = await adminApi();
    const now = nextDay();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const run = await seedRun(app, {
      workflow: "quotes",
      createdAt: ago(5 * dayMs),
    });
    const answered = async (
      step: string,
      status: "approved" | "rejected",
      decidedMs: number
    ) =>
      await seedDecision(run, {
        step,
        status,
        openedAt: ago(decidedMs + hourMs),
        expiresAt: now,
        decidedAt: ago(decidedMs),
      });
    const early = await answered("price", "rejected", 3 * dayMs);
    await answered("price:line-2", "approved", 2 * dayMs);
    const late = await answered("price:line-3", "rejected", dayMs);
    // More than a page of them, all approved.
    await seedDecisions(run, "price:bulk", {
      status: "approved",
      openedAt: ago(3 * dayMs),
      expiresAt: now,
      decidedAt: ago(2 * dayMs),
    });
    await answered("send", "approved", dayMs);
    // Before the window, and one nobody answered: neither counts.
    await answered("send:old", "rejected", 45 * dayMs);
    await seedDecision(run, {
      step: "send:unanswered",
      status: "timed_out",
      openedAt: ago(2 * dayMs),
      expiresAt: ago(dayMs),
    });

    await refreshSignalsIfDue(env, now);
    const { signals } = await api.signals.list({ app });

    expect(ofKind(signals, "correction")).toStrictEqual([
      {
        kind: "correction",
        workflow: "quotes",
        subject: "price",
        value: 2,
        evidence: {
          answered: 603,
          rejected: 2,
          recent: [
            { decision: late, run },
            { decision: early, run },
          ],
        },
      },
    ]);
  });

  it("weigh each workflow's model cost per run against the minutes its Playbook record says it saves", async () => {
    const { app } = await builderWithApp();
    const api = await adminApi();
    const now = nextDay();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const run = async (workflow: string) =>
      await seedRun(app, {
        workflow,
        status: "completed",
        createdAt: ago(dayMs),
        endedAt: ago(dayMs),
      });
    const [first, second] = await Promise.all([
      run("invoices"),
      run("invoices"),
    ]);
    await Promise.all([run("invoices"), run("invoices")]);
    // A week's worth of runs a week, over the window.
    await Promise.all(
      Array.from({ length: 30 }, async () => await run("filing"))
    );
    const unlinked = await run("chat");
    await logged(
      modelCall(app, "invoices", first, 0.5),
      modelCall(app, "invoices", second, 0.125),
      modelCall(app, "invoices", second, 0.125),
      modelCall(app, "chat", unlinked, 0.25),
      // Not a run's: not counted.
      {
        actor: { type: "app", appId: app, part: "server" },
        cost: { amount: 9, currency: "USD" },
      }
    );
    const invoices = await seedRecord(app, "invoices", {
      steps: [
        {
          name: "Enter",
          kind: "automated",
          numbers: {
            minutes: { value: 6, basis: "estimated" },
            people: { value: 2, basis: "estimated" },
          },
        },
        {
          name: "Check",
          kind: "ai_checked",
          numbers: { minutes: { value: 3, basis: "observed" } },
        },
        // A person still does this one.
        {
          name: "Pay",
          kind: "instruction",
          numbers: { minutes: { value: 20, basis: "estimated" } },
        },
      ],
      gain: { hoursPerWeek: 1 },
    });
    const filing = await seedRecord(app, "filing", {
      gain: { hoursPerWeek: 7 },
    });

    await refreshSignalsIfDue(env, now);
    const { signals } = await api.signals.list({ app });

    expect(ofKind(signals, "cost_per_run")).toStrictEqual([
      {
        kind: "cost_per_run",
        workflow: "chat",
        subject: null,
        value: 0.25,
        evidence: {
          runs: 1,
          cost: 0.25,
          minutesSavedPerRun: null,
          savedFrom: null,
          record: null,
          costPerHourSaved: null,
          costliest: [{ run: unlinked, cost: 0.25 }],
        },
      },
      {
        kind: "cost_per_run",
        workflow: "invoices",
        subject: null,
        value: 0.1875,
        evidence: {
          runs: 4,
          cost: 0.75,
          minutesSavedPerRun: 15,
          savedFrom: "steps",
          record: invoices,
          costPerHourSaved: 0.75,
          costliest: [
            { run: first, cost: 0.5 },
            { run: second, cost: 0.25 },
          ],
        },
      },
      {
        kind: "cost_per_run",
        workflow: "filing",
        subject: null,
        value: 0,
        evidence: {
          runs: 30,
          cost: 0,
          minutesSavedPerRun: 60,
          savedFrom: "gain",
          record: filing,
          costPerHourSaved: 0,
          costliest: [],
        },
      },
    ]);
  });

  it("group Knowledge searches that found nothing by their key, an App's with the App and people's with the deployment", async () => {
    const { api, app } = await builderWithApp();
    const admin = await signedInApi(idp, "admin");
    const now = nextDay();
    const asked = `key-${unique()}`;
    const once = `key-${unique()}`;
    const people = `key-${unique()}`;
    const since = Date.now();
    const head = await logHead();
    // Its askers take turns, each search received a second after the one
    // before (the log's clock, moved on here).
    const turns = [
      emptySearch(runActor(app, "triage", "run-a"), asked, "collection-a"),
      emptySearch(runActor(app, "triage", "run-b"), asked),
      emptySearch(runActor(app, "triage", "run-a"), asked, "collection-b"),
    ];
    const received: string[] = [];
    vi.useFakeTimers({ toFake: ["Date"], now: since });
    try {
      for (const turn of turns) {
        vi.setSystemTime(Date.now() + 1000);
        // One after another, each at its own time.
        // oxlint-disable-next-line no-await-in-loop
        received.push(...(await logged(turn)));
      }
    } finally {
      vi.useRealTimers();
    }
    const [lastAsked = ""] = received.slice(-1);
    await logged(
      emptySearch({ type: "app", appId: app, part: "screen" }, once),
      emptySearch({ type: "person", userId: `person-${unique()}` }, people),
      emptySearch({ type: "person", userId: `person-${unique()}` }, people)
    );

    await refreshSignalsIfDue(env, now);
    const [mine, everyone] = await Promise.all([
      api.signals.list({ app }),
      admin.api.signals.list(),
    ]);

    const own = questions(mine.signals, since);
    const askedLast = ofKind(mine.signals, "unanswered_question").find(
      ({ subject }) => subject === asked
    )?.evidence.lastAt;
    expect({
      // The latest search of any of its askers'.
      askedLast: askedLast === (await receivedAtOf(lastAsked, head)),
      mine: {
        ...own,
        questions: own.questions.map(({ app: _app, ...signal }) => signal),
      },
      people: questions(
        everyone.signals.filter(({ subject }) => subject === people),
        since
      ),
    }).toStrictEqual({
      askedLast: true,
      mine: {
        recent: true,
        questions: [
          {
            kind: "unanswered_question",
            workflow: "triage",
            subject: asked,
            value: 3,
            evidence: {
              searches: 3,
              askers: 2,
              terms: 3,
              collections: ["collection-a", "collection-b"],
            },
          },
          {
            kind: "unanswered_question",
            workflow: null,
            subject: once,
            value: 1,
            evidence: { searches: 1, askers: 1, terms: 3, collections: [] },
          },
        ],
      },
      people: {
        recent: true,
        questions: [
          {
            kind: "unanswered_question",
            app: null,
            workflow: null,
            subject: people,
            value: 2,
            evidence: { searches: 2, askers: 2, terms: 3, collections: [] },
          },
        ],
      },
    });
  });

  it("are read by admins, and by an App's builders for that App only, without what runs read or decisions said", async () => {
    const owner = await builderWithApp();
    const other = await builderWithApp();
    const user = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    await owner.api.apps.members.add(owner.app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const now = nextDay();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const run = await seedRun(owner.app, {
      workflow: "hr",
      status: "failed",
      createdAt: ago(2 * dayMs),
      endedAt: ago(dayMs),
      failure: {
        step: "lookup",
        code: "connect.action_failed",
        message: "salary of jan.de.vries is 5000",
      },
    });
    await seedDecision(run, {
      step: "approve",
      status: "rejected",
      openedAt: ago(2 * dayMs),
      expiresAt: now,
      decidedAt: ago(dayMs),
      description: "Raise for jan.de.vries",
      payload: { comment: "jan.de.vries asked twice" },
    });

    await refreshSignalsIfDue(env, now);
    const outcomes = await Promise.all([
      outcome(owner.api.signals.list({ app: owner.app })),
      outcome(admin.api.signals.list({ app: owner.app })),
      outcome(admin.api.signals.list()),
      outcome(owner.api.signals.list()),
      outcome(other.api.signals.list({ app: owner.app })),
      outcome(user.api.signals.list({ app: owner.app })),
      outcome(owner.api.signals.list({ workflow: "hr" })),
    ]);
    const read = await owner.api.signals.list({ app: owner.app });
    const events = await allEvents();

    expect({
      outcomes,
      kinds: read.signals.map(({ kind }) => kind).toSorted(),
      leaks: JSON.stringify(read).includes("jan.de.vries"),
      audited: events.some(
        ({ action, actor, detail }) =>
          action === "improvement.signals.read" &&
          actor.type === "person" &&
          actor.userId === owner.userId &&
          detail.app === owner.app
      ),
    }).toStrictEqual({
      outcomes: [
        "ok",
        "ok",
        "ok",
        "role.forbidden",
        "app.not_found",
        "role.forbidden",
        "signal.invalid",
      ],
      kinds: ["correction", "cost_per_run", "failing_step"],
      leaks: false,
      audited: true,
    });
  });

  it("are computed once a day, again once a failed day's claim has lapsed, and then from what changed", async () => {
    const { api, app } = await builderWithApp();
    const now = nextDay();
    const failing = async (step: string) =>
      await seedRun(app, {
        workflow: "daily",
        status: "failed",
        createdAt: new Date(now.getTime() - hourMs),
        endedAt: new Date(now.getTime() - hourMs),
        failure: { step, code: "connect.action_failed" },
      });
    const steps = async () => {
      const { signals } = await api.signals.list({ app });
      return ofKind(signals, "failing_step").map(({ subject }) => subject);
    };
    await failing("first");
    // A claim of the day that stopped half an hour ago, and was never finished.
    await env.DB.prepare(
      "INSERT INTO improvement_signal_computations (id, day, started_at) VALUES (?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        now.toISOString().slice(0, 10),
        now.getTime() - 30 * 60 * 1000
      )
      .run();

    await refreshSignalsIfDue(env, now);
    const computed = await api.signals.list({ app });
    await failing("second");
    await refreshSignalsIfDue(env, new Date(now.getTime() + hourMs));
    const sameDay = await api.signals.list({ app });
    const tomorrow = new Date(now.getTime() + dayMs);
    days += 1;
    await refreshSignalsIfDue(env, tomorrow);

    expect({
      computations: await computationsOf(now),
      unchanged: sameDay.computedAt === computed.computedAt,
      sameDay: ofKind(sameDay.signals, "failing_step").map(
        ({ subject }) => subject
      ),
      tomorrow: await steps(),
    }).toStrictEqual({
      computations: 1,
      unchanged: true,
      sameDay: ["first"],
      tomorrow: ["first", "second"],
    });
  });

  it("leave a day alone while another computation's claim on it is recent", async () => {
    const now = nextDay();
    // Claimed 16 minutes ago: longer than between cron runs, within the lease.
    await env.DB.prepare(
      "INSERT INTO improvement_signal_computations (id, day, started_at) VALUES (?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        now.toISOString().slice(0, 10),
        now.getTime() - 16 * 60 * 1000
      )
      .run();

    await refreshSignalsIfDue(env, now);

    await expect(computationsOf(now)).resolves.toBe(0);
  });

  it("are computed once when two cron runs claim the same day at once", async () => {
    const now = nextDay();

    await Promise.all([
      refreshSignalsIfDue(env, now),
      refreshSignalsIfDue(env, now),
    ]);

    await expect(computationsOf(now)).resolves.toBe(1);
  });

  it("stay those of a newer computation when an older one it finished past goes on writing", async () => {
    const { app } = await builderWithApp();
    const api = await adminApi();
    const older = nextDay();
    const newer = nextDay();
    await seedRun(app, {
      workflow: "raced",
      status: "failed",
      createdAt: new Date(older.getTime() - hourMs),
      endedAt: new Date(older.getTime() - hourMs),
      failure: { step: "fetch", code: "connect.action_failed" },
    });
    // The newer computation runs whole once the older one has claimed its
    // day, just before the older one writes its first signals.
    const racing = racingWhen(
      async () => (await claimsOf(older)) > 0,
      async () => {
        await refreshSignalsIfDue(env, newer);
      }
    );

    const stopped = await refusal(
      refreshSignalsIfDue({ ...env, DB: racing }, older)
    );
    const { computedAt, signals } = await api.signals.list({ app });

    expect({
      stopped: String(stopped).includes("FOREIGN KEY constraint failed"),
      computed: computedAt !== null,
      failing: ofKind(signals, "failing_step").map(({ subject }) => subject),
      claims: { older: await claimsOf(older), newer: await claimsOf(newer) },
      computations: {
        older: await computationsOf(older),
        newer: await computationsOf(newer),
      },
    }).toStrictEqual({
      stopped: true,
      computed: true,
      failing: ["fetch"],
      claims: { older: 0, newer: 1 },
      computations: { older: 0, newer: 1 },
    });
  });

  it("stay those of a newer computation that finished while an older one was finishing", async () => {
    const { app } = await builderWithApp();
    const api = await adminApi();
    const older = nextDay();
    const newer = nextDay();
    await seedRun(app, {
      workflow: "raced",
      status: "failed",
      createdAt: new Date(older.getTime() - hourMs),
      endedAt: new Date(older.getTime() - hourMs),
      failure: { step: "fetch", code: "connect.action_failed" },
    });
    // The newer computation runs whole once the older one has written its
    // signals, just before the older one's finishing batch.
    const racing = racingWhen(
      async () => (await signalsOf(older)) > 0,
      async () => {
        await refreshSignalsIfDue(env, newer);
      }
    );

    const finishing = await outcome(
      refreshSignalsIfDue({ ...env, DB: racing }, older)
    );
    const { signals } = await api.signals.list({ app });

    expect({
      finishing,
      failing: ofKind(signals, "failing_step").map(({ subject }) => subject),
      claims: { older: await claimsOf(older), newer: await claimsOf(newer) },
      signals: { newer: (await signalsOf(newer)) > 0 },
      computations: {
        older: await computationsOf(older),
        newer: await computationsOf(newer),
      },
    }).toStrictEqual({
      // Its finishing batch found its row gone, and changed nothing.
      finishing: "ok",
      failing: ["fetch"],
      claims: { older: 0, newer: 1 },
      signals: { newer: true },
      computations: { older: 0, newer: 1 },
    });
  });

  it("stop claiming a day after a few failed attempts, and drop earlier days' unfinished claims", async () => {
    const earlier = nextDay();
    const now = nextDay();
    await seedClaim(earlier, hourMs);
    // Three attempts of the day, each lapsed long ago.
    await seedClaim(now, 3 * hourMs);
    await seedClaim(now, 2 * hourMs);
    await seedClaim(now, hourMs);

    await refreshSignalsIfDue(env, now);

    expect({
      computed: await computationsOf(now),
      claims: { earlier: await claimsOf(earlier), now: await claimsOf(now) },
    }).toStrictEqual({ computed: 0, claims: { earlier: 0, now: 3 } });
  });

  it("are computed on their own cron trigger, not the every-minute one", async () => {
    const today = new Date();

    await cron("* * * * *");
    const everyMinute = await computationsOf(today);
    await cron(signalsCron);

    expect({ everyMinute, signals: await computationsOf(today) }).toStrictEqual(
      {
        everyMinute: 0,
        signals: 1,
      }
    );
  });

  it("show an App's builders counts, step names and codes, but no run, decision or person IDs", async () => {
    const builder = await builderWithApp();
    const { app } = builder;
    const now = nextDay();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const later = new Date(now.getTime() + dayMs);
    const first = `person-${unique()}`;
    const second = `person-${unique()}`;
    const run = await seedRun(app, {
      workflow: "hr",
      status: "failed",
      createdAt: ago(2 * dayMs),
      endedAt: ago(dayMs),
      failure: { step: "lookup", code: "connect.action_failed" },
    });
    const waiting = await seedRun(app, {
      workflow: "hr",
      createdAt: ago(dayMs),
    });
    const asked = await seedDecision(waiting, {
      step: "approve",
      deciders: `person:${first}`,
      openedAt: ago(3 * hourMs),
      expiresAt: later,
    });
    const also = await seedDecision(waiting, {
      step: "check",
      deciders: `person:${second}`,
      openedAt: ago(hourMs),
      expiresAt: later,
    });
    const rejected = await seedDecision(run, {
      step: "approve",
      status: "rejected",
      openedAt: ago(2 * dayMs),
      expiresAt: now,
      decidedAt: ago(dayMs),
    });
    await logged(modelCall(app, "hr", run, 0.5));

    await refreshSignalsIfDue(env, now);
    const { signals } = await builder.api.signals.list({ app });
    const read = JSON.stringify(signals);

    expect({
      ids: [run, waiting, asked, also, rejected, first, second].filter((id) =>
        read.includes(id)
      ),
      signals: signals.map(({ app: _app, ...signal }) => signal),
    }).toStrictEqual({
      ids: [],
      signals: [
        {
          kind: "waiting_for_person",
          workflow: "hr",
          // Both people, as one.
          subject: "person",
          value: 3 * hourMs,
          evidence: { open: 2 },
        },
        {
          kind: "failing_step",
          workflow: "hr",
          subject: "lookup",
          value: 1,
          evidence: {
            failures: 1,
            runs: 2,
            errors: [{ code: "connect.action_failed", count: 1 }],
          },
        },
        {
          kind: "correction",
          workflow: "hr",
          subject: "approve",
          value: 1,
          evidence: { answered: 1, rejected: 1 },
        },
        {
          kind: "cost_per_run",
          workflow: "hr",
          subject: null,
          value: 0.25,
          evidence: {
            runs: 2,
            cost: 0.5,
            minutesSavedPerRun: null,
            savedFrom: null,
            record: null,
            costPerHourSaved: null,
          },
        },
      ],
    });
  });

  it("give builders each workflow's waits for people added up, however many people, and admins each person's", async () => {
    const builder = await builderWithApp();
    const { app } = builder;
    const admin = await adminApi();
    const now = nextDay();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const later = new Date(now.getTime() + dayMs);
    const run = await seedRun(app, {
      workflow: "leave",
      createdAt: ago(dayMs),
    });
    const other = await seedRun(app, {
      workflow: "expenses",
      createdAt: ago(dayMs),
    });
    // More people than one kind lists, each asked once, the first longest.
    await env.DB.batch(
      Array.from({ length: 60 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO workflow_decisions (id, run_id, step, deciders, description, status, opened_at, expires_at) VALUES (?, ?, ?, ?, 'Approve it', 'open', ?, ?)"
        ).bind(
          `decision-${unique()}`,
          run,
          `approve:${index}`,
          `person:person-${unique()}`,
          ago(2 * hourMs - index * 1000).getTime(),
          later.getTime()
        )
      )
    );
    // A shorter wait, which no person's pushes out of a builder's list.
    await seedDecision(other, {
      step: "check",
      deciders: "role:admin",
      openedAt: ago(hourMs),
      expiresAt: later,
    });

    await refreshSignalsIfDue(env, now);
    const [built, all] = await Promise.all([
      builder.api.signals.list({ app }),
      admin.signals.list({ app }),
    ]);
    const waits = ofKind(all.signals, "waiting_for_person");

    expect({
      built: ofKind(built.signals, "waiting_for_person"),
      admin: {
        listed: waits.length,
        people: waits.every(
          ({ subject }) => subject?.startsWith("person:") === true
        ),
      },
    }).toStrictEqual({
      built: [
        {
          kind: "waiting_for_person",
          workflow: "leave",
          subject: "person",
          value: 2 * hourMs,
          evidence: { open: 60 },
        },
        {
          kind: "waiting_for_person",
          workflow: "expenses",
          subject: "role:admin",
          value: hourMs,
          evidence: { open: 1 },
        },
      ],
      // The longest 50 of the 60 people's waits: none added up.
      admin: { listed: 50, people: true },
    });
  });

  it("aren't computed while switched off", async () => {
    const now = nextDay();

    await refreshSignalsIfDue({ ...env, FEATURES: { workflows: true } }, now);

    await expect(computationsOf(now)).resolves.toBe(0);
  });
});
