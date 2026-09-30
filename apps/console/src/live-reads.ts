/**
 * Reading many clients' accounts live, for a page staff wait on: a few
 * clients at a time, each within a deadline, so one account that doesn't
 * answer never holds up the rest, and none of its requests outlives its
 * deadline. The grid (src/clients/grid.ts) and the revocation check
 * (src/rollout/shared-secrets.ts) both read this way.
 */
import { deadline, whenAborted } from "@grasp-os/shared/deadline";

/** How reading clients live may go. */
export interface LiveReadLimits {
  /** How many clients are read at once. */
  concurrency: number;
  /** How long one client may take all told. */
  rowDeadlineMs: number;
  /** The most an API call waits between its retries, all told. */
  waitBudgetMs: number;
}

export const defaultLiveReadLimits: LiveReadLimits = {
  concurrency: 4,
  rowDeadlineMs: 15_000,
  waitBudgetMs: 5000,
};

/**
 * What `task` answers within `ms`, or `fallback` once that's up, or when
 * it throws. The signal it's given aborts then, stopping the requests it
 * has under way, so none outlives the deadline.
 */
export const within = async <T>(
  ms: number,
  task: (signal: AbortSignal) => Promise<T>,
  fallback: T
): Promise<T> => {
  const limit = deadline(ms);
  try {
    return await Promise.race([task(limit.signal), whenAborted(limit.signal)]);
  } catch {
    return fallback;
  } finally {
    limit.clear();
  }
};

/** `run` for each of `items`, at most `limit` at once, in order. */
export const eachLimited = async <T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time per worker
        results[index] = await run(item);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};
