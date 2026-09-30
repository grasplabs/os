import type { AppErrorEntry } from "@grasp-os/shared/screens";

// An App's error log: what went wrong in its screens, and what its server
// code wrote with `console` (server-logs.ts), for the builders and the
// agent who fix it. It lives in the App's own Durable Object (in the EU
// with the App), outside the facet its code runs in, and keeps only the
// newest entries, so code that fails or logs in a loop fills it and no
// more.

/** How many entries the log keeps. */
const errorLogSize = 100;

const countKey = "error-log-count";
const entryPrefix = "error-log:";

/** Entries sort by key in the order they were added. */
const entryKey = (count: number): string =>
  `${entryPrefix}${String(count).padStart(12, "0")}`;

/**
 * Adds `entries` to the log in `storage`, in order, dropping the oldest
 * beyond its size.
 */
export const addToErrorLog = async (
  storage: DurableObjectStorage,
  entries: AppErrorEntry[]
): Promise<void> => {
  const before = (await storage.get<number>(countKey)) ?? 0;
  const count = before + entries.length;
  const added = Object.fromEntries(
    entries.map((entry, index) => [entryKey(before + index + 1), entry])
  );
  await storage.put({ ...added, [countKey]: count });
  const dropped = Array.from(
    { length: Math.min(entries.length, Math.max(0, count - errorLogSize)) },
    (_, index) => entryKey(count - errorLogSize - index)
  );
  if (dropped.length > 0) {
    await storage.delete(dropped);
  }
};

/** The log in `storage`, newest first. */
export const readErrorLog = async (
  storage: DurableObjectStorage
): Promise<AppErrorEntry[]> => {
  const entries = await storage.list<AppErrorEntry>({
    prefix: entryPrefix,
    reverse: true,
    limit: errorLogSize,
  });
  return [...entries.values()];
};
