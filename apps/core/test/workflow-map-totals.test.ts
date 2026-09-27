import { describe, expect, it } from "vite-plus/test";

import {
  expectedGain,
  formatHours,
  stepHours,
  totalsOf,
} from "../blueprints/workflow-map/files/components/totals.ts";
import type { Step } from "../blueprints/workflow-map/files/components/totals.ts";

// The workflow map's numbers (its screen works them out): a workflow's
// hours a week, people and handovers, and a designed workflow's expected
// gain against the drawn one. Pure logic, so tested on its own.

const estimated = (value: number) => ({ value, basis: "estimated" as const });
const observed = (value: number) => ({ value, basis: "observed" as const });

/** Match invoices: 30 times a week, 10 minutes, 2 people: 10 hours. */
const match: Step = {
  name: "Match the invoice",
  who: "Controller",
  handover: true,
  numbers: {
    frequency: estimated(30),
    minutes: estimated(10),
    people: estimated(2),
  },
};

/** Approve: 30 times a week, 4 minutes, one person (unsaid): 2 hours. */
const approve: Step = {
  name: "Approve the payment",
  who: " controller ",
  handover: false,
  numbers: { frequency: observed(30), minutes: observed(4) },
};

/** Book it: no numbers yet. */
const book: Step = { name: "Book it", who: "Bookkeeper", handover: true };

describe("the workflow map's numbers", () => {
  it("take a step's hours a week as times × minutes × people, one person when unsaid, none without times or minutes", () => {
    expect([match, approve, book].map(stepHours)).toStrictEqual([10, 2, 0]);
  });

  it("total a workflow's hours, the people who do its steps once each, and its handovers", () => {
    expect(totalsOf([match, approve, book])).toStrictEqual({
      hoursPerWeek: 12,
      // The controller twice, however it is written, and the bookkeeper.
      people: 2,
      handovers: 2,
      basis: "estimated",
    });
    expect(totalsOf([approve])).toMatchObject({ basis: "observed" });
    expect(totalsOf([])).toStrictEqual({
      hoursPerWeek: 0,
      people: 0,
      handovers: 0,
      basis: "estimated",
    });
  });

  it("gain the hours the designed steps save, to a tenth of an hour, and never less than none", () => {
    const automated: Step = {
      ...match,
      kind: "automated",
      numbers: { frequency: estimated(30), minutes: estimated(0) },
    };
    const checked: Step = {
      ...approve,
      kind: "ai_checked",
      numbers: { frequency: estimated(30), minutes: estimated(1) },
    };
    expect({
      designed: expectedGain([match, approve, book], [automated, checked]),
      slower: expectedGain([approve], [match]),
      thirds: expectedGain(
        [
          {
            ...book,
            numbers: { frequency: estimated(1), minutes: estimated(20) },
          },
        ],
        []
      ),
    }).toStrictEqual({ designed: 11.5, slower: 0, thirds: 0.3 });
  });

  it("show hours to a tenth", () => {
    expect([12, 0.333, 1234.56].map(formatHours)).toStrictEqual([
      "12 h",
      "0.3 h",
      "1,234.6 h",
    ]);
  });
});
