import { describe, expect, it } from "vite-plus/test";

import type {
  Outcome,
  Snapshot,
} from "../blueprints/board-page/files/components/snapshot.ts";
import { viewer } from "../blueprints/board-page/files/components/viewer.ts";

// Which snapshot the board page shows as its answers come in
// (components/viewer.ts): pure logic, so tested on its own, with the
// server's answers released in the order each test needs. What can go
// wrong: a late answer shows a snapshot the person moved away from; a
// failed open leaves the page acting on a snapshot it doesn't show, so a
// save no longer refreshes the one shown and the next save conflicts.

const snapshot = (id: string, version: number): Snapshot => ({
  id,
  path: `snapshots/${id}.md`,
  version,
  record: {},
  body: "",
});

/** A server whose answers wait until the test releases them. */
const server = () => {
  const waiting: {
    id: string;
    answer: (outcome: Outcome<Snapshot>) => void;
  }[] = [];
  const load = async (id: string): Promise<Outcome<Snapshot>> => {
    const { promise, resolve } = Promise.withResolvers<Outcome<Snapshot>>();
    waiting.push({ id, answer: resolve });
    return await promise;
  };
  /** Answers the oldest open of `id` still waiting with `outcome`. */
  const answer = async (id: string, outcome: Outcome<Snapshot>) => {
    const index = waiting.findIndex((each) => each.id === id);
    const [open] = waiting.splice(index, 1);
    open?.answer(outcome);
    // Lets the viewer take the answer in.
    await Promise.resolve();
    await Promise.resolve();
  };
  return { load, answer, waiting };
};

/** A viewer over `load`, and what it showed and refused, in order. */
const watched = (load: (id: string) => Promise<Outcome<Snapshot>>) => {
  const seen: string[] = [];
  const to = {
    show: ({ id, version }: Snapshot) => {
      seen.push(`${id}@${version}`);
    },
    refuse: (code: string) => {
      seen.push(code);
    },
  };
  const opened = viewer(load);
  const shown = {
    open: async (id: string) => {
      await opened.open(id, to);
    },
    saved: async (id: string) => {
      await opened.saved(id, to);
    },
    first: async (id: string) => {
      await opened.first(id, to);
    },
  };
  return { shown, seen };
};

describe("the board page's viewer", () => {
  it("keeps the snapshot shown when opening another fails, and still refreshes it after a save", async () => {
    const { load, answer } = server();
    const { shown, seen } = watched(load);
    const openA = shown.open("a");
    await answer("a", { ok: snapshot("a", 1) });
    await openA;

    // A is saved while B is opened, and B's open fails.
    const openB = shown.open("b");
    await answer("b", { error: "knowledge.not_found" });
    await openB;
    const refreshA = shown.saved("a");
    await answer("a", { ok: snapshot("a", 2) });
    await refreshA;
    // Saved again, from the version now shown: refreshed again.
    const again = shown.saved("a");
    await answer("a", { ok: snapshot("a", 3) });
    await again;

    expect(seen).toStrictEqual(["a@1", "knowledge.not_found", "a@2", "a@3"]);
  });

  it("shows only the answer to the latest open, and refreshes after a save only the snapshot shown", async () => {
    const { load, answer, waiting } = server();
    const { shown, seen } = watched(load);
    const openA = shown.open("a");
    const openB = shown.open("b");
    // A answers last: too late, B was asked for since.
    await answer("b", { ok: snapshot("b", 1) });
    await answer("a", { ok: snapshot("a", 1) });
    await Promise.all([openA, openB]);
    // A save of A, which isn't shown, opens nothing.
    await shown.saved("a");
    // And the newest isn't opened over what the person opened.
    await shown.first("c");

    expect({ seen, waiting: waiting.length }).toStrictEqual({
      seen: ["b@1"],
      waiting: 0,
    });
  });

  it("opens the newest first, when nothing was opened yet", async () => {
    const { load, answer } = server();
    const { shown, seen } = watched(load);
    const first = shown.first("c");
    await answer("c", { ok: snapshot("c", 1) });
    await first;
    expect(seen).toStrictEqual(["c@1"]);
  });
});
