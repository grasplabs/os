import { describe, expect, it } from "vite-plus/test";

import { whilePending } from "../blueprints/board-page/files/components/pending.ts";

// The board page's pending state (its buttons disabled while a call runs):
// pure logic, so tested on its own. What can go wrong: a call that fails
// leaves the button disabled for good.

describe("the board page's pending state", () => {
  it("is set while a call runs, and cleared however it ends", async () => {
    const seen: boolean[] = [];
    const pending = (on: boolean): void => {
      seen.push(on);
    };
    const answer = await whilePending(
      pending,
      async () => await Promise.resolve(1)
    );
    const failed = await whilePending(pending, async () => {
      await Promise.resolve();
      throw new Error("The connection dropped");
    }).catch((error: unknown) => (error instanceof Error ? error.message : ""));
    expect({ answer, failed, seen }).toStrictEqual({
      answer: 1,
      failed: "The connection dropped",
      seen: [true, false, true, false],
    });
  });
});
