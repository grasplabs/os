import { describe, expect, it } from "vite-plus/test";

import { splitHistory } from "./history.ts";

const saved = (number: number, createdAt: string) => ({ number, createdAt });

describe("a document's history on the timeline", () => {
  it("shows a short history as it is, oldest first", () => {
    const versions = [3, 2, 1].map((n) => saved(n, `2026-09-0${n}T00:00:00Z`));
    expect(splitHistory(versions)).toStrictEqual({
      earlier: [],
      recent: versions.toReversed(),
    });
  });

  it("folds all but the latest five by month", () => {
    const months = ["2026-07", "2026-07", "2026-08", "2026-09", "2026-09"];
    const versions = Array.from({ length: 10 }, (_, at) =>
      saved(at + 1, `${months[at] ?? "2026-10"}-01T00:00:00Z`)
    ).toReversed();
    const { earlier, recent } = splitHistory(versions);
    expect({
      earlier: earlier.map(({ month, versions: inMonth }) => [
        month,
        inMonth.map(({ number }) => number),
      ]),
      recent: recent.map(({ number }) => number),
    }).toStrictEqual({
      earlier: [
        ["2026-07", [1, 2]],
        ["2026-08", [3]],
        ["2026-09", [4, 5]],
      ],
      recent: [6, 7, 8, 9, 10],
    });
  });
});
