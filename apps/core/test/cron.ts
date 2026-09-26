import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import worker from "../src/index.ts";

/** Runs core's cron trigger, as Cloudflare does every minute, on an env with `changes`. */
export const runCron = async (changes: Partial<Env> = {}): Promise<void> => {
  await worker.scheduled(createScheduledController(), { ...env, ...changes });
};

/**
 * How many events of `action` on target `targetId` wait in `database`'s
 * audit outbox.
 */
export const waitingInOutbox = async (
  database: D1Database,
  action: string,
  targetId: string
): Promise<number> => {
  const row = await database
    .prepare(
      "SELECT count(*) AS waiting FROM audit_outbox WHERE json_extract(event, '$.action') = ? AND json_extract(event, '$.target.id') = ?"
    )
    .bind(action, targetId)
    .first<{ waiting: number }>();
  return row?.waiting ?? 0;
};

/**
 * Runs `run` while the audit log can't be reached, as when it's down: what
 * `run` audits waits in the outbox until a drain reaches the log.
 */
export const whileLogDown = async <T>(run: () => Promise<T>): Promise<T> => {
  const down = vi.spyOn(env.AUDIT_LOG, "getByName").mockImplementation(() => {
    throw new Error("Audit log unavailable");
  });
  try {
    return await run();
  } finally {
    down.mockRestore();
  }
};
