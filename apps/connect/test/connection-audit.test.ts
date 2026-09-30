import { composioToolsMax } from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import { namesEventsMax, packedNames } from "../src/connection-audit.ts";

// Names for the audit log (the tools an admin lets run unheld), whose
// detail values are small: every name kept, in order, in a bounded number
// of events, and what doesn't fit handed back to be counted and hashed,
// never dropped unseen.

/** The names a packing holds, in order. */
const namesIn = (details: Record<string, string>[]): string[] =>
  details.flatMap((detail) =>
    Object.keys(detail)
      .toSorted(
        (one, other) =>
          Number(one.slice("names".length)) -
          Number(other.slice("names".length))
      )
      .flatMap((key) => detail[key]?.split(",") ?? [])
  );

/** `count` names of `length` characters, each its own. */
const names = (count: number, length: number): string[] =>
  Array.from({ length: count }, (_, index) =>
    `TOOL_${index}_`.padEnd(length, "X")
  );

describe("names packed for the audit log", () => {
  it("are all kept, in order, in values and details of the log's size", () => {
    const tools = names(60, 25);
    const { details, rest } = packedNames(tools);
    const values = details.flatMap((detail) => Object.values(detail));
    expect({
      details: details.length,
      named: namesIn(details),
      rest,
      longest: Math.max(...values.map((value) => value.length)) <= 256,
      members: Math.max(...details.map((detail) => Object.keys(detail).length)),
    }).toStrictEqual({
      details: 1,
      named: tools,
      rest: [],
      longest: true,
      members: 7,
    });
  });

  it("name the largest allowlist of the longest names within the most events", () => {
    const tools = names(composioToolsMax, 64);
    const { details, rest } = packedNames(tools);
    expect({
      within: details.length <= namesEventsMax,
      details: details.length,
      members: Math.max(...details.map((detail) => Object.keys(detail).length)),
      named: namesIn(details).length,
      rest,
    }).toStrictEqual({
      within: true,
      details: 14,
      members: 24,
      named: composioToolsMax,
      rest: [],
    });
  });

  it("hand back, in order, the names that don't fit the events allowed", () => {
    const tools = names(100, 64);
    const one = packedNames(tools, 1);
    expect({
      details: one.details.length,
      named: namesIn(one.details),
      rest: one.rest,
    }).toStrictEqual({
      details: 1,
      // Three names of 64 characters to a value, 24 values to an event.
      named: tools.slice(0, 72),
      rest: tools.slice(72),
    });
    expect(packedNames(tools, 0)).toStrictEqual({ details: [], rest: tools });
    expect(packedNames([])).toStrictEqual({ details: [], rest: [] });
  });
});
