// A document's history as the timeline shows it (grasplabs/prototype
// `splitTimeline` in `lib/brain.ts`): oldest first, the latest few as they
// are, and the ones before them folded away by the month they were saved.

/** How many of the latest versions show unfolded. */
export const recentVersions = 5;

/** Versions of one month, folded away. */
export interface HistoryMonth<T> {
  /** `YYYY-MM`. */
  month: string;
  versions: T[];
}

/**
 * `versions` (newest first, as core lists them) oldest first: the latest
 * `recent` unfolded, the ones before them by month. With only a couple more
 * than `recent`, nothing folds: folding two away saves nothing.
 */
export const splitHistory = <T extends { createdAt: string }>(
  versions: readonly T[],
  recent = recentVersions
): { earlier: HistoryMonth<T>[]; recent: T[] } => {
  const oldestFirst = versions.toReversed();
  if (oldestFirst.length <= recent + 2) {
    return { earlier: [], recent: oldestFirst };
  }
  const cut = oldestFirst.length - recent;
  const earlier: HistoryMonth<T>[] = [];
  for (const version of oldestFirst.slice(0, cut)) {
    const month = version.createdAt.slice(0, 7);
    const last = earlier.at(-1);
    if (last?.month === month) {
      last.versions.push(version);
    } else {
      earlier.push({ month, versions: [version] });
    }
  }
  return { earlier, recent: oldestFirst.slice(cut) };
};
