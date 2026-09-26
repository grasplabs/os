import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import worker from "../src/index.ts";

/** Runs core's cron trigger, as Cloudflare does every minute, on an env with `changes`. */
export const runCron = async (changes: Partial<Env> = {}): Promise<void> => {
  await worker.scheduled(createScheduledController(), { ...env, ...changes });
};

/**
 * Runs `run` while the audit queue refuses every event, as when it's down:
 * what `run` audits waits in the outbox for the next cron run.
 */
export const whileQueueDown = async <T>(run: () => Promise<T>): Promise<T> => {
  const down = vi
    .spyOn(env.AUDIT_QUEUE, "send")
    .mockRejectedValue(new Error("Queue unavailable"));
  try {
    return await run();
  } finally {
    down.mockRestore();
  }
};
