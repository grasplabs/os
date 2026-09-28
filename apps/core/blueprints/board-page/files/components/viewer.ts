// Which snapshot the board page shows, as its answers come in: the one
// source of truth for what is shown, so a late or failed answer never
// leaves the page showing one snapshot while it acts on another.

import type { Outcome, Snapshot } from "./snapshot";

/** Where the page shows a snapshot, or why it couldn't. */
export interface Shown {
  show: (snapshot: Snapshot) => void;
  refuse: (code: string) => void;
}

/** How the page opens snapshots, and refreshes one after a save. */
export interface Viewer {
  /** Opens `id`: shown once it answers, unless another open came since. */
  open: (id: string, to: Shown) => Promise<void>;
  /** A save of `id`: its new version, if `id` is still the one shown. */
  saved: (id: string, to: Shown) => Promise<void>;
  /** Opens `id` first, unless something was opened already. */
  first: (id: string, to: Shown) => Promise<void>;
}

/**
 * A viewer that opens snapshots with `load`. Only the answer to the
 * latest open is used: an earlier one, arriving late, would show what the
 * person moved away from, or an older version. What is shown changes only
 * when an open succeeds: a failed one leaves the snapshot shown as it was,
 * and saving it still refreshes it.
 */
export const viewer = (
  load: (id: string) => Promise<Outcome<Snapshot>>
): Viewer => {
  let latest = 0;
  let shown: string | null = null;
  const open = async (id: string, to: Shown): Promise<void> => {
    latest += 1;
    const asked = latest;
    const answer = await load(id);
    if (asked !== latest) {
      return;
    }
    if ("error" in answer) {
      to.refuse(answer.error);
      return;
    }
    shown = id;
    to.show(answer.ok);
  };
  return {
    open,
    saved: async (id, to) => {
      if (shown === id) {
        await open(id, to);
      }
    },
    first: async (id, to) => {
      if (latest === 0) {
        await open(id, to);
      }
    },
  };
};
