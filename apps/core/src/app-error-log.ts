import type { AppErrorEntry } from "@grasp-os/shared/screens";

// An App's error log: what went wrong in its screens, for the builders and
// the agent who fix it. It lives in the App's own Durable Object (in the
// EU with the App), outside the facet its code runs in, and keeps only the
// newest entries, so a screen that fails in a loop fills it and no more.

/** How many entries the log keeps. */
const errorLogSize = 100;

const countKey = "error-log-count";
const entryPrefix = "error-log:";

/** Entries sort by key in the order they were added. */
const entryKey = (count: number): string =>
  `${entryPrefix}${String(count).padStart(12, "0")}`;

/** Adds `entry` to the log in `storage`, dropping the oldest beyond its size. */
export const addToErrorLog = async (
  storage: DurableObjectStorage,
  entry: AppErrorEntry
): Promise<void> => {
  const count = ((await storage.get<number>(countKey)) ?? 0) + 1;
  await storage.put({ [countKey]: count, [entryKey(count)]: entry });
  if (count > errorLogSize) {
    await storage.delete(entryKey(count - errorLogSize));
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
