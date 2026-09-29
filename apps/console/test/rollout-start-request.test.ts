import { describe, expect, it } from "vite-plus/test";

import { startRequestOf } from "../src/rollout/start-request.ts";
import type { StartChoices } from "../src/rollout/start-request.ts";
import { InvalidFieldError } from "../src/use-action.ts";

/** The form as it opens, with a ring past ring 0 to pick. */
const opened: StartChoices = {
  what: "release",
  releaseId: "r100-abcdef0",
  scope: "ring",
  ring: 2,
  clientId: "",
  pastFirstRing: true,
};

/** What `choices` send, or the words they're refused with. */
const sent = (choices: Partial<StartChoices>): unknown => {
  try {
    return startRequestOf({ ...opened, ...choices });
  } catch (error) {
    return error instanceof InvalidFieldError ? error.message : "other";
  }
};

describe("the rollout start form's request", () => {
  it("sends the release with the scope, ring or client chosen", () => {
    expect({
      ring: sent({ scope: "ring", ring: 3 }),
      client: sent({ scope: "client", clientId: "acme" }),
      all: sent({ scope: "all" }),
    }).toStrictEqual({
      ring: {
        kind: "release",
        releaseId: "r100-abcdef0",
        scope: { scope: "ring", ring: 3 },
      },
      client: {
        kind: "release",
        releaseId: "r100-abcdef0",
        scope: { scope: "client", clientId: "acme" },
      },
      all: {
        kind: "release",
        releaseId: "r100-abcdef0",
        scope: { scope: "all" },
      },
    });
  });

  it("sends a secrets rollout without the release field, whatever it holds", () => {
    expect({
      ring: sent({ what: "secrets", scope: "ring", ring: 1 }),
      client: sent({ what: "secrets", scope: "client", clientId: "acme" }),
      all: sent({ what: "secrets", scope: "all" }),
    }).toStrictEqual({
      ring: { kind: "secrets", scope: { scope: "ring", ring: 1 } },
      client: {
        kind: "secrets",
        scope: { scope: "client", clientId: "acme" },
      },
      all: { kind: "secrets", scope: { scope: "all" } },
    });
  });

  it("sends only what the chosen scope uses", () => {
    expect({
      // A client typed in, then the scope switched back to a ring.
      ring: sent({ scope: "ring", clientId: "acme" }),
      all: sent({ scope: "all", ring: 3, clientId: "acme" }),
    }).toStrictEqual({
      ring: {
        kind: "release",
        releaseId: "r100-abcdef0",
        scope: { scope: "ring", ring: 2 },
      },
      all: {
        kind: "release",
        releaseId: "r100-abcdef0",
        scope: { scope: "all" },
      },
    });
  });

  it("reaches every client when ring 0 is all there is, whatever scope was left chosen", () => {
    expect(
      (["ring", "client", "all"] as const).map((scope) =>
        sent({ scope, pastFirstRing: false })
      )
    ).toStrictEqual(
      [1, 2, 3].map(() => ({
        kind: "release",
        releaseId: "r100-abcdef0",
        scope: { scope: "all" },
      }))
    );
  });

  it("asks for the client before sending a rollout to one it doesn't name", () => {
    expect(sent({ scope: "client", clientId: "" })).toBe(
      "Name the client to roll out to."
    );
  });
});
