/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { describe, expect, it } from "vite-plus/test";

import { describeWorkflow } from "../src/describe.ts";
import { createFakeEngine } from "./fake-engine.ts";
import { outlineOf } from "./outline.ts";
import { payoutWorkflow } from "./payout-workflow.ts";
// oxlint-disable-next-line import/default -- Vite's `?raw` import; typed in raw.d.ts
import payoutSource from "./payout-workflow.ts?raw";

/** A workflow source around `body`, the workflow function's statements. */
const workflowSource = (
  body: string,
  signature = "step, { params, input }"
) => `
import { workflow } from "@grasp-os/sdk/workflow";

export default workflow("sample", { params: {} }, async (${signature}) => {
${body}
});
`;

describe(describeWorkflow, () => {
  it("shows a step in a loop once, nested under the loop", () => {
    expect(outlineOf(payoutSource)).toStrictEqual([
      {
        type: "loop",
        header: "for (const payout of input.payouts)",
        params: [],
        steps: [
          {
            type: "branch",
            condition: "payout.amount <= params.limit",
            params: ["limit"],
            steps: [
              {
                type: "step",
                name: "pay",
                kind: "exact",
                description: "Pay the supplier",
                key: "payout.id",
                sideEffect: true,
                locked: false,
                params: [],
                options: {},
              },
            ],
            otherwise: [],
          },
        ],
      },
    ]);
  });

  it("runs the loop's step once per item, keyed by the item", async () => {
    const keys: string[] = [];
    const { engine } = createFakeEngine();
    const payouts = [
      { id: "p1", supplier: "Acme", amount: 100 },
      { id: "p/2", supplier: "Globex", amount: 200 },
    ];

    const paid = await payoutWorkflow(async (payout, idempotencyKey) => {
      keys.push(idempotencyKey);
      return payout.id;
    }).run(engine, { payouts });

    expect(paid).toStrictEqual(["p1", "p/2"]);
    expect(keys).toStrictEqual(["run-1:pay:p1", "run-1:pay:p%2F2"]);
  });

  it("gives every kind of step, with its literal options and line", () => {
    const source = workflowSource(`
  await step.sleep("pause", { description: "Wait a bit", duration: "1 hour" });
  await step.waitFor("signed", {
    description: "Wait for the signature",
    type: "document.signed",
    timeout: params.signTimeout,
  });`);

    expect(describeWorkflow(source).steps).toStrictEqual([
      {
        type: "step",
        name: "pause",
        kind: "wait",
        description: "Wait a bit",
        sideEffect: false,
        locked: false,
        params: [],
        options: { duration: "1 hour" },
        line: 6,
      },
      {
        type: "step",
        name: "signed",
        kind: "wait",
        description: "Wait for the signature",
        sideEffect: false,
        locked: false,
        params: ["signTimeout"],
        options: { type: "document.signed" },
        line: 7,
      },
    ]);
  });

  it("reads parameters through a context argument too", () => {
    const source = workflowSource(
      `
  if (ctx.params.enabled) {
    await step.do("go", { description: "Go", retries: 1 }, async () => ctx.params.target);
  } else {
    await step.sleep("rest", { description: "Rest", duration: 1000 });
  }`,
      "step, ctx"
    );

    expect(describeWorkflow(source).steps).toMatchObject([
      {
        type: "branch",
        condition: "ctx.params.enabled",
        params: ["enabled"],
        steps: [{ name: "go", params: ["target"], options: { retries: 1 } }],
        otherwise: [{ name: "rest", options: { duration: 1000 } }],
      },
    ]);
  });

  it("rejects what it can't read, saying how to write it instead", () => {
    const step = `step.do("go", { description: "Go" }, async () => 1)`;
    const cases: [string, string][] = [
      [
        `await step.do(name, { description: "Go" }, async () => 1);`,
        "string literal",
      ],
      [`await step.do("go", options, async () => 1);`, "object literal"],
      [
        `await step.do("go", { ...options }, async () => 1);`,
        "without spreads",
      ],
      [
        `await step.do("go", { description: label }, async () => 1);`,
        "non-empty string literal",
      ],
      [`await step.do("go", {}, async () => 1);`, "needs description"],
      [
        `await step.do("go", { description: "Go", retry: 2 }, async () => 1);`,
        "isn't an option",
      ],
      [
        `await step.llm("x", { description: "X", model: "m", instructions: "i", input: 1, schema });`,
        "must be a parameter",
      ],
      [
        `await step.llm("x", { description: "X", model: params.m, instructions: "i", input: 1, schema, locked: true });`,
        "isn't an option",
      ],
      [`await ${step}; await ${step};`, "appears twice"],
      [`for (const item of input.items) { await ${step}; }`, "needs a `key`"],
      [`const run = async () => { await ${step}; };`, "nested function"],
      [`input.ok && (await ${step});`, "inside an `if`"],
      [`try { await ${step}; } catch {}`, "`if`/`else` and `for`/`for...of`"],
      [
        `switch (input.kind) { case 1: await ${step}; }`,
        "`if`/`else` and `for`/`for...of`",
      ],
      [`if (await ${step}) {}`, "not in its condition"],
      [`await helper(step);`, "don't pass `step` around"],
      [`const { limit } = params;`, "Read parameters as"],
      [`await step.run("x", {});`, "isn't a step"],
    ];

    for (const [body, message] of cases) {
      expect(() => describeWorkflow(workflowSource(body))).toThrow(message);
    }
  });

  it("rejects a source without exactly one workflow, or that doesn't parse", () => {
    expect(() => describeWorkflow("export const x = 1;")).toThrow(
      "Expected one call to `workflow`"
    );
    expect(() => describeWorkflow("workflow(")).toThrow("doesn't parse");
    expect(() =>
      describeWorkflow(`
import { workflow } from "@grasp-os/sdk/workflow";
const run = async () => null;
export default workflow("x", { params: {} }, run);`)
    ).toThrow("Write the workflow's function inline");
  });

  it("reports errors as invalid definitions with the line", () => {
    expect(() =>
      describeWorkflow(
        workflowSource(`await step.do("go", options, async () => 1);`)
      )
    ).toThrow(/^Line 5: Write the options/u);
    expect(() => describeWorkflow("")).toThrow(
      expect.objectContaining({ code: "workflow.invalid_definition" })
    );
  });
});
