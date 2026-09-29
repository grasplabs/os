import type { App, FileDiff } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import {
  pendingToShow,
  readyToMakeCurrent,
  serverFileLabels,
  serverFileOf,
  stillMadeCurrent,
  versionKey,
} from "./builds-state.ts";

// What the side panel's "Being built" section decides: when a version may
// be made current, which proposals it shows, and how it labels server
// code.

const app = (id: string, pendingVersion: number | null): App => ({
  id: appIdSchema.parse(id),
  name: id,
  description: "",
  owner: "user-1",
  blueprint: null,
  currentVersion: null,
  pendingVersion,
  createdAt: "2026-09-29T00:00:00.000Z",
});

/** Each way a version changes a server file. */
const diffs: Record<"added" | "modified" | "deleted", FileDiff> = {
  added: { path: "app/lib/a.ts", change: "added", after: "new" },
  modified: {
    path: "app/lib/a.ts",
    change: "modified",
    before: "old",
    after: "new",
  },
  deleted: { path: "app/lib/a.ts", change: "deleted", before: "old" },
};

/** How the panel labels a server file the version changes so. */
const labelsOf = (change: keyof typeof diffs) => {
  const file = serverFileOf(diffs[change]);
  return { file, labels: serverFileLabels(file) };
};

describe("the Being built section", () => {
  it("offers making a version current only once its review and changed server code have loaded", () => {
    const ready = { state: "ready" };
    const failed = { state: "refused" };

    expect([
      readyToMakeCurrent(undefined, false),
      readyToMakeCurrent(failed, false),
      readyToMakeCurrent(ready, false),
      // Server code changed: its code must have loaded too.
      readyToMakeCurrent(ready, true),
      readyToMakeCurrent(ready, true, failed),
      readyToMakeCurrent(ready, true, { state: "offline" }),
      readyToMakeCurrent(ready, true, ready),
    ]).toStrictEqual([false, false, true, false, false, false, true]);
  });

  it("drops a proposal the panel made current at once, whatever the next read says", () => {
    const apps = [app("app-1", 2), app("app-2", 5), app("app-3", null)];

    expect(
      pendingToShow(apps, new Set([versionKey("app-1", 2)])).map(
        ({ id, pendingVersion }) => [id, pendingVersion]
      )
    ).toStrictEqual([["app-2", 5]]);
    // A newer proposal of the same App shows again.
    expect(
      pendingToShow([app("app-1", 3)], new Set([versionKey("app-1", 2)])).map(
        ({ pendingVersion }) => pendingVersion
      )
    ).toStrictEqual([3]);
  });

  it("forgets a version made current once a read no longer lists it pending, so it shows when proposed again", () => {
    const made = new Set([versionKey("app-1", 2)]);

    // A read from before the change still lists it: still hidden.
    const early = stillMadeCurrent(made, [app("app-1", 2)]);
    expect(pendingToShow([app("app-1", 2)], early)).toStrictEqual([]);
    // A read after it: forgotten.
    const after = stillMadeCurrent(early, [app("app-1", null)]);
    expect([...after]).toStrictEqual([]);
    // Rolled back and put up for review again: shown.
    expect(
      pendingToShow([app("app-1", 2)], after).map(
        ({ pendingVersion }) => pendingVersion
      )
    ).toStrictEqual([2]);
  });

  it("labels what runs now, what would run after approval, and a file that would no longer run", () => {
    expect(labelsOf("modified")).toStrictEqual({
      file: { path: "app/lib/a.ts", before: "old", after: "new" },
      labels: {
        summary: "app/lib/a.ts, as it would run",
        before: "Runs now",
        after: "Would run after approval",
      },
    });
    expect(labelsOf("added").file).toStrictEqual({
      path: "app/lib/a.ts",
      after: "new",
    });
    expect(labelsOf("deleted")).toStrictEqual({
      file: { path: "app/lib/a.ts", before: "old" },
      labels: {
        summary: "app/lib/a.ts, which would no longer run",
        before: "Runs now",
        after: "Would run after approval",
      },
    });
  });
});
