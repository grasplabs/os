/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { describe, expect, it } from "vite-plus/test";

import { describeWorkflow } from "../src/describe.ts";
import { createTestEngine } from "../src/testing.ts";
import { outlineOf } from "./outline.ts";
import { payoutWorkflow } from "./payout-workflow.ts";
// oxlint-disable-next-line import/default -- Vite's `?raw` import; typed in raw.d.ts
import payoutSource from "./payout-workflow.ts?raw";

/** A workflow source around `body`, the workflow function's statements. */
const workflowSource = (
  body: string,
  signature = "step, { params, input, state }"
) => `
import { workflow } from "@grasp-os/sdk/workflow";

export default workflow("sample", { params: {} }, async (${signature}) => {
${body}
});
`;

// Two calls whose 32-bit FNV-1a hashes were the same: compared as
// written, they differ.
const mail = (to: string): string =>
  `await step.do("mail", { description: "Mail" }, async () => await env.MAIL.call("mail.send", ${JSON.stringify(to)}));`;

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
    const { engine } = createTestEngine({ sideEffects: "run" });
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

    // Each step's code, as whether it is its call as written.
    const steps = describeWorkflow(source).steps.map((node) =>
      node.type === "step"
        ? { ...node, code: node.code.startsWith(`step.`) }
        : node
    );

    expect(steps).toStrictEqual([
      {
        type: "step",
        name: "pause",
        kind: "wait",
        description: "Wait a bit",
        sideEffect: false,
        locked: false,
        params: [],
        options: { duration: "1 hour" },
        code: true,
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
        code: true,
        line: 7,
      },
    ]);
  });

  it("records options written as objects of literals, such as retries", () => {
    const source = workflowSource(`
  await step.do("go", {
    description: "Go",
    retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
    timeout: "5 minutes",
  }, async () => 1);`);

    expect(describeWorkflow(source).steps).toMatchObject([
      {
        name: "go",
        options: {
          retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
          timeout: "5 minutes",
        },
      },
    ]);
  });

  it("reads the context only when it's destructured, without a rest element", () => {
    const body = `await step.sleep("rest", { description: "Rest", duration: 1000 });`;

    for (const signature of ["step, ctx", "step, { params, ...rest }"]) {
      expect(() => describeWorkflow(workflowSource(body, signature))).toThrow(
        "Destructure the workflow function's context"
      );
    }
  });

  it("keeps a condition that reads a parameter, even without steps under it", () => {
    const source = workflowSource(`
  if (input.total > params.limit) {
    return "too much";
  }
  if (input.total > 0) {
    return "fine";
  }`);

    expect(outlineOf(source)).toStrictEqual([
      {
        type: "branch",
        condition: "input.total > params.limit",
        params: ["limit"],
        steps: [],
        otherwise: [],
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
        "must be a literal",
      ],
      [
        `await step.do("go", { description: " " }, async () => 1);`,
        "is invalid",
      ],
      [
        `await step.do("go", { description: "Go", retries: count }, async () => 1);`,
        "must be a literal, an object of literals or a parameter",
      ],
      [
        `await step.sleep("go", { description: "Go", duration: "366 days" });`,
        "up to 365 days",
      ],
      [
        `await step.decision("go", { description: "Go", from: params.reviewer, ask });`,
        "needs timeout",
      ],
      [
        `await step.do("go", { description: "Go" }, async () => await state.get("seen"));`,
        "between steps",
      ],
      [`await step.do("go", {}, async () => 1);`, "needs description"],
      [
        `await step.do("go", { description: "Go", sideEffect: true }, async () => 1);`,
        "needs input",
      ],
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
      [
        `const limit = params.limit; if (input.total > limit) { await ${step}; }`,
        'Read parameter "limit" where it\'s used',
      ],
      [`await step.run("x", {});`, "isn't a step"],
    ];

    for (const [body, message] of cases) {
      expect(() => describeWorkflow(workflowSource(body))).toThrow(message);
    }
  });

  it("names the App's bindings each step calls, which may change things", () => {
    const source = workflowSource(
      [
        `const total = await step.do("read", { description: "Read" }, async () => 1);`,
        `await step.do("book", { description: "Book", input: total }, async () => await bindings.APP.call("book", total));`,
        `await step.do("mail", { description: "Mail" }, async () => [await bindings.MAIL.call("mail.send", {}), await use(bindings)]);`,
      ].join("\n"),
      "step, { input, env: bindings }"
    );

    expect(
      describeWorkflow(source).steps.map((node) =>
        node.type === "step" ? { name: node.name, env: node.env } : node.type
      )
    ).toStrictEqual([
      { name: "read", env: undefined },
      { name: "book", env: ["APP"] },
      { name: "mail", env: ["MAIL", "env"] },
    ]);
    expect(() =>
      describeWorkflow(
        workflowSource(
          `await step.do("x", { description: "X" }, async () => 1);`,
          "step, { env: { APP } }"
        )
      )
    ).toThrow("Call the App's bindings as `env.NAME`");
  });

  it("says every step may call the App's bindings when a helper or alias reads them", () => {
    const envOf = (body: string): unknown[] =>
      describeWorkflow(workflowSource(body, "step, { input, env }")).steps.map(
        (node) => (node.type === "step" ? node.env : node.type)
      );
    const steps = [
      `await step.do("read", { description: "Read" }, async () => 1);`,
      `await step.do("book", { description: "Book" }, async () => await book());`,
    ].join("\n");

    // A helper that reads env, called from a step.
    expect(
      envOf(
        `const book = async () => await env.APP.call("book", input);\n${steps}`
      )
    ).toStrictEqual([["env"], ["env"]]);
    // An alias of env.
    expect(
      envOf(
        `const bindings = env;\nconst book = async () => await bindings.APP.call("book");\n${steps}`
      )
    ).toStrictEqual([["env"], ["env"]]);
  });

  it("keeps each step's call as written, so any change to its code shows", () => {
    const codeOf = (body: string): string | undefined => {
      const [first] = describeWorkflow(
        workflowSource(body, "step, { env }")
      ).steps;
      return first?.type === "step" ? first.code : undefined;
    };

    expect(codeOf(mail("hwczrv0to6"))).toBe(
      mail("hwczrv0to6").replace("await ", "").replace(/;$/u, "")
    );
    expect(codeOf(mail("hwczrv0to6"))).not.toBe(codeOf(mail("flfoi83s5j")));
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
