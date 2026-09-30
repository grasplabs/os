/**
 * Workflow runs as tests drive them from outside: through Cloudflare
 * Workflows' own instance API, as a crash, a deploy or time passing would.
 */
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";

/** What runs a statement against the database: each fails when broken. */
const statementRuns = new Set<PropertyKey>(["run", "all", "raw", "first"]);

/** `target`'s `key`, a method bound to it, as a proxy passes it through. */
const through = (target: object, key: PropertyKey): unknown => {
  const value: unknown = Reflect.get(target, key);
  if (typeof value !== "function") {
    return value;
  }
  const bound: unknown = value.bind(target);
  return bound;
};

/** A clear of a run's `waiting_for`, as drizzle writes it. */
const clearsWaitingFor = /update "workflow_runs" set "waiting_for" = /iu;

/**
 * Breaks the core database (`env.DB`) for one kind of write: clearing a
 * run's `waiting_for` as it goes on past a wait, which fails as D1 can
 * (overloaded, timed out) until `mend`. Everything else goes through.
 * `failures` counts the clears refused.
 */
export const failingGoingOn = (): {
  failures: () => number;
  mend: () => void;
} => {
  const db = env.DB;
  let failures = 0;
  const failed = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, key) => {
        if (statementRuns.has(key)) {
          return async () => {
            failures += 1;
            await Promise.resolve();
            throw new Error("D1_ERROR: broken for the test");
          };
        }
        return through(target, key);
      },
    });
  const prepared = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, key) => {
        if (key === "bind") {
          return (...values: unknown[]) => {
            const bound = target.bind(...values);
            return values[0] === null ? failed(bound) : bound;
          };
        }
        return through(target, key);
      },
    });
  env.DB = new Proxy(db, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return clearsWaitingFor.test(query) ? prepared(statement) : statement;
        };
      }
      return through(target, key);
    },
  });
  return {
    failures: () => failures,
    mend: () => {
      env.DB = db;
    },
  };
};

/** Where the engine has a run now. */
export const liveStatus = async (run: string): Promise<string> => {
  const instance = await env.WORKFLOWS.get(run);
  const { status } = await instance.status();
  return status;
};

/**
 * Stops a run's execution, as a crash or a deploy does; resuming it runs
 * the workflow again from its start, loaded anew, finished steps replayed.
 * Workflows lets a run stop between steps, here while it waits.
 */
export const stopped = async (run: string): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  await vi.waitFor(
    async () => {
      await instance.pause();
      await expect(instance.status()).resolves.toMatchObject({
        status: "paused",
      });
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Resumes a run `stopped` stopped. */
export const resumed = async (run: string): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  await instance.resume();
};

/** Once the run has ended, however it ended. */
export const finished = async (run: string): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  await vi.waitFor(
    async () => {
      const { status } = await instance.status();
      expect(["complete", "errored", "terminated"]).toContain(status);
    },
    { timeout: 20_000, interval: 200 }
  );
};

/**
 * Once the engine reports that the run began its sleep `step`, from the
 * run's own event stream (Workflows' `subscribe`), which the engine
 * writes as the sleep begins. The local engine's status says `running`
 * while a run sleeps, so the status can't tell.
 */
export const sleeping = async (run: string, step: string): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  using events = await instance.subscribe({ filter: ["sleep_started"] });
  await vi.waitFor(
    async () => {
      const { done, value } = await events.next();
      if (done === true) {
        throw new Error(`Run ${run} ended before it slept in ${step}`);
      }
      // The engine names a sleep after its step, with a count behind.
      expect(
        value.type === "sleep_started" && value.stepName.startsWith(step)
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

/**
 * Once the run, `stopped` and `resumed`, began a sleep in a step whose
 * name starts with `step` in the resumed execution: as `sleeping`, but
 * only a sleep the engine reports after it resumed the run counts. The
 * resumed execution has then replayed every step before that sleep.
 */
export const sleepingOnceResumed = async (
  run: string,
  step: string
): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  using events = await instance.subscribe({
    filter: ["workflow_paused", "workflow_running", "sleep_started"],
  });
  let paused = false;
  let resumedRun = false;
  await vi.waitFor(
    async () => {
      const { done, value } = await events.next();
      if (done === true) {
        throw new Error(`Run ${run} ended before it slept in ${step}`);
      }
      if (value.type === "workflow_paused") {
        paused = true;
        resumedRun = false;
      } else if (value.type === "workflow_running" && paused) {
        resumedRun = true;
      }
      expect(
        resumedRun &&
          value.type === "sleep_started" &&
          value.stepName.startsWith(step)
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

/**
 * Ends the run's sleep `step` now, as its time passing would: a workflow
 * under test sleeps a day where the test acts on it while it is live, and
 * this lets it go on. The local engine skips a sleep only when an
 * execution comes to it, so the run is stopped once it sleeps there (as
 * it is, when a test stopped it already), told to skip the sleep, and
 * resumed: the new execution replays the steps before it, and passes it.
 */
export const woken = async (run: string, step = "go"): Promise<void> => {
  if ((await liveStatus(run)) !== "paused") {
    await sleeping(run, step);
    await stopped(run);
  }
  // Not disposed: disposing deletes the run's instance.
  const instance = await introspectWorkflowInstance(env.WORKFLOWS, run);
  await instance.modify(async (modifier) => {
    await modifier.disableSleeps([{ name: step }]);
  });
  await resumed(run);
};

/** Once the run's step `step` has completed, as the audit log has it. */
export const stepDone = async (run: string, step: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      expect(
        events.some(
          ({ action, target, detail }) =>
            action === "workflow.step.completed" &&
            target?.id === run &&
            detail.step === step
        )
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

const endedStatuses = new Set(["complete", "errored", "terminated"]);

/** Runs `endLiveRuns` has ended or found ended; it skips them after. */
const seenEnded = new Set<string>();

/**
 * Terminates every run a test left waiting, sleeping or paused. The
 * engine keeps those in the project's one workerd across test files, and
 * would go on in the background of whatever runs next: a decision's
 * week-long wait, a run paused, or one waiting while a feature was off.
 * Work that outlives its test is how a test file came to wait forever in
 * CI (see apps/core/vite.config.ts), so each test ends its runs.
 */
export const endLiveRuns = async (): Promise<void> => {
  const { results } = await env.DB.prepare("SELECT id FROM workflow_runs").all<{
    id: string;
  }>();
  await Promise.all(
    results
      .filter(({ id }) => !seenEnded.has(id))
      .map(async ({ id }) => {
        // A row whose run never started has no instance; any other
        // failure is the test's to see.
        const instance = await env.WORKFLOWS.get(id).catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.message === "instance.not_found"
          ) {
            return null;
          }
          throw error;
        });
        if (instance) {
          const { status } = await instance.status();
          if (!endedStatuses.has(status)) {
            await instance.terminate().catch(async (error: unknown) => {
              // It ended on its own between the two calls (a run that just
              // failed, say, whose row the test already saw): the engine
              // refuses to terminate an ended instance. Anything else, or
              // an instance still live, is the test's to see.
              const now = await instance.status();
              if (!endedStatuses.has(now.status)) {
                throw error;
              }
            });
          }
        }
        seenEnded.add(id);
      })
  );
};

/** Removes a person from the organization; returns how to bring them back. */
export const leave = async (userId: string): Promise<() => Promise<void>> => {
  const membership = await env.DB.prepare(
    "SELECT * FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<Record<string, string | number>>();
  await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
    .bind(userId)
    .run();
  return async () => {
    await env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        membership?.id,
        membership?.organization_id,
        membership?.user_id,
        membership?.role,
        membership?.created_at
      )
      .run();
  };
};
