/**
 * Workflow runs as tests drive them from outside: through Cloudflare
 * Workflows' own instance API, as a crash, a deploy or an event would.
 */
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";

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

/** Sends `event` until the run ends: it may not wait for it yet. */
export const finished = async (
  run: string,
  event?: { type: string; payload: unknown }
): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  await vi.waitFor(
    async () => {
      if (event) {
        await instance.sendEvent(event);
      }
      const { status } = await instance.status();
      expect(["complete", "errored", "terminated"]).toContain(status);
    },
    { timeout: 20_000, interval: 200 }
  );
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
            await instance.terminate();
          }
        }
        seenEnded.add(id);
      })
  );
};

/** Where the engine has a run now. */
export const liveStatus = async (run: string): Promise<string> => {
  const instance = await env.WORKFLOWS.get(run);
  const { status } = await instance.status();
  return status;
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
