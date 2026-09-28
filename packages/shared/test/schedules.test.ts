import { describe, expect, it } from "vite-plus/test";

import { nextScheduledRun } from "../src/workflows.ts";

const inAmsterdam = (cron: string) => ({
  cron,
  timeZone: "Europe/Amsterdam",
});

/** The next `count` times `cron` fires in Amsterdam after `after`, in UTC. */
const firings = (cron: string, after: string, count: number): string[] => {
  const times: string[] = [];
  let from = new Date(after);
  for (let index = 0; index < count; index += 1) {
    const next = nextScheduledRun(inAmsterdam(cron), from);
    if (!next) {
      break;
    }
    times.push(next.toISOString());
    from = next;
  }
  return times;
};

describe("schedules across summer time", () => {
  it("fire a time the spring change skips at the same time an hour later", () => {
    // 2:30 doesn't exist in Amsterdam on 28 March 2027: 3:30 CEST.
    expect(firings("30 2 * * *", "2027-03-27T12:00:00Z", 2)).toStrictEqual([
      "2027-03-28T01:30:00.000Z",
      "2027-03-29T00:30:00.000Z",
    ]);
  });

  it("fire a time the autumn change repeats once, the first time", () => {
    // 2:30 happens twice in Amsterdam on 25 October 2026: CEST, then CET.
    expect(firings("30 2 * * *", "2026-10-24T12:00:00Z", 2)).toStrictEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  it("fire through the repeated hour only once", () => {
    expect(firings("*/30 * * * *", "2026-10-24T23:45:00Z", 4)).toStrictEqual([
      // 2:00 and 2:30 CEST, then 3:00 and 3:30 CET: not 2:00 and 2:30 CET.
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T02:30:00.000Z",
    ]);
  });
});
