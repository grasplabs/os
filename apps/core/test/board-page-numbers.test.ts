import { describe, expect, it } from "vite-plus/test";

import {
  beforeAndAfter,
  formatHours,
  headlineOf,
  rowsShown,
  signalRows,
  topByHours,
} from "../blueprints/board-page/files/components/board.ts";
import type { WorkflowFigures } from "../blueprints/board-page/files/components/board.ts";

// What the board page shows of a snapshot's frozen figures (its screen
// works it out): where the hours go now, before and after, the headline
// and the signals in plain words. Pure logic, so tested on its own. What
// can go wrong: a designed workflow that doesn't run yet counted at its
// designed hours as if it saved them already; a running one shown at its
// estimate instead of what runs observed; a list too long for one page;
// a signal of a kind this page doesn't know shown as nothing.

const hours = (hoursPerWeek: number, version = 1) => ({
  version,
  hoursPerWeek,
  basis: "estimated" as const,
});

/** Drawn only: 4 hours a week. */
const book: WorkflowFigures = {
  path: "workflows/book.md",
  title: "Book receipts",
  team: "Finance",
  state: "drawn",
  drawn: hours(4),
};

/** Designed from 10 hours to 2.5, running at 0.6. */
const pay: WorkflowFigures = {
  path: "workflows/pay.md",
  title: "Pay invoices",
  state: "designed",
  drawn: hours(10),
  designed: hours(2.5, 3),
  running: { appId: "app-1", workflowId: "pay", runs: 30, hoursPerWeek: 0.6 },
};

/** Designed from 6 hours to 1, not running yet. */
const hire: WorkflowFigures = {
  path: "workflows/hire.md",
  title: "Hire",
  team: "People",
  state: "designed",
  drawn: hours(6),
  designed: hours(1, 2),
};

describe("the board page's numbers", () => {
  it("put the hours where they go now: as a workflow runs once it does, as drawn until then", () => {
    expect(topByHours([book, pay, hire])).toStrictEqual([
      { path: hire.path, title: "Hire", team: "People", hoursPerWeek: 6 },
      {
        path: book.path,
        title: "Book receipts",
        team: "Finance",
        hoursPerWeek: 4,
      },
      { path: pay.path, title: "Pay invoices", hoursPerWeek: 0.6 },
    ]);
  });

  it("set each designed workflow's drawn hours beside what runs observed, or else what its design expects", () => {
    expect(beforeAndAfter([book, pay, hire])).toStrictEqual([
      {
        path: pay.path,
        title: "Pay invoices",
        before: 10,
        after: 0.6,
        from: "observed",
      },
      { path: hire.path, title: "Hire", before: 6, after: 1, from: "expected" },
    ]);
  });

  it("count as saved only what running workflows save", () => {
    expect(headlineOf([book, pay, hire])).toStrictEqual({
      hoursNow: 10.6,
      savedRunning: 9.4,
      running: 1,
      unavailable: 0,
      workflows: 3,
    });
  });

  it("show a workflow whose runs couldn't be read as unavailable, never as saving nothing", () => {
    const unread: WorkflowFigures = { ...hire, unavailable: true };
    expect({
      beforeAfter: beforeAndAfter([unread]),
      headline: headlineOf([book, pay, unread]),
    }).toStrictEqual({
      beforeAfter: [
        {
          path: hire.path,
          title: "Hire",
          before: 6,
          after: 1,
          from: "unavailable",
        },
      ],
      headline: {
        hoursNow: 10.6,
        savedRunning: 9.4,
        running: 1,
        unavailable: 1,
        workflows: 3,
      },
    });
  });

  it("show no more rows than fit on one page", () => {
    const many = Array.from({ length: rowsShown + 3 }, (_, index) => ({
      ...hire,
      path: `workflows/w${index}.md`,
    }));
    expect({
      hours: topByHours(many).length,
      beforeAfter: beforeAndAfter(many).length,
      signals: signalRows(
        many.map(({ path }) => ({ path, kind: "failing_step", value: 1 })),
        many
      ).length,
    }).toStrictEqual({
      hours: rowsShown,
      beforeAfter: rowsShown,
      signals: rowsShown,
    });
  });

  it("say each signal in plain words, with its workflow's title, a kind it doesn't know too", () => {
    expect(
      signalRows(
        [
          {
            path: pay.path,
            kind: "waiting_for_person",
            value: 3 * 24 * 3_600_000,
          },
          { path: pay.path, kind: "failing_step", value: 3 },
          { path: pay.path, kind: "correction", value: 2 },
          { path: pay.path, kind: "cost_per_run", value: 0.125 },
          { path: "workflows/gone.md", kind: "slow_step", value: 7 },
        ],
        [pay]
      ).map(({ workflow, text }) => `${workflow}: ${text}`)
    ).toStrictEqual([
      "Pay invoices: Waits up to 3 days for a person to decide",
      "Pay invoices: 3 runs failed at a step",
      "Pay invoices: 2 proposals were rejected",
      "Pay invoices: $0.13 of model calls a run",
      "workflows/gone.md: slow step: 7",
    ]);
    expect(
      signalRows(
        [
          { path: pay.path, kind: "waiting_for_person", value: 5 * 3_600_000 },
          { path: pay.path, kind: "unanswered_question", value: 4 },
        ],
        [pay]
      ).map(({ text }) => text)
    ).toStrictEqual([
      "Waits up to 5 hours for a person to decide",
      "A question went unanswered 4 times",
    ]);
  });

  it("show hours to a tenth", () => {
    expect([12, 0.333, 1234.56].map(formatHours)).toStrictEqual([
      "12 h",
      "0.3 h",
      "1,234.6 h",
    ]);
  });
});
