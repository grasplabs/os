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

/** Where the engine has a run now. */
export const liveStatus = async (run: string): Promise<string> => {
  const instance = await env.WORKFLOWS.get(run);
  const { status } = await instance.status();
  return status;
};
