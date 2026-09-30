/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { describe, expect, it } from "vite-plus/test";

import {
  checkWorkflowBindings,
  checkWorkflowModule,
  describeWorkflow,
} from "../src/describe.ts";
import { createTestEngine } from "../src/testing.ts";
import { asDefaultExport, outlineOf } from "./outline.ts";
import { payoutWorkflow } from "./payout-workflow.ts";
// oxlint-disable-next-line import/default -- Vite's `?raw` import; typed in raw.d.ts
import payoutSource from "./payout-workflow.ts?raw";

/** A workflow source around `body`, the workflow function's statements. */
const workflowSource = (
  body: string,
  signature = "step, { params, input, state }"
) => `
import { appExports, appServer, workflow } from "@grasp-os/sdk/workflow";

export default workflow("sample", { params: {} }, async (${signature}) => {
${body}
});
`;

// Two calls whose 32-bit FNV-1a hashes were the same: compared as
// written, they differ.
const mail = (to: string): string =>
  `await step.do("mail", { description: "Mail" }, async () => await env.MAIL.call("mail.send", ${JSON.stringify(to)}));`;

/** A step, `tidy-up` unless named, whose function runs `code`. */
const inStep = (code: string, name = "tidy-up"): string =>
  `await step.do("${name}", { description: "Tidy" }, async () => { ${code} });`;

describe(describeWorkflow, () => {
  it("shows a step in a loop once, nested under the loop", () => {
    expect(outlineOf(asDefaultExport(payoutSource))).toStrictEqual([
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
    // Code in the parameter list would run with the context in reach.
    for (const signature of [
      "step, { input }, ...rest",
      "step, { env, input = env }",
      "step, { env, input: { [env.APP.call('sendAll')]: sent } }",
    ]) {
      expect(() => describeWorkflow(workflowSource(body, signature))).toThrow(
        "without default values or computed names"
      );
    }
    expect(
      describeWorkflow(
        workflowSource(body, "step, { runId, input: { id }, readAttachment }")
      ).steps
    ).toHaveLength(1);
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
        `await step.do("mail", { description: "Mail" }, async () => [await bindings.MAIL.call("mail.send", {}), await appExports<Crm>(bindings.CRM).find({})]);`,
        `await step.do("keep", { description: "Keep" }, async () => await appServer<App>(bindings).keep(total));`,
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
      { name: "mail", env: ["MAIL", "CRM"] },
      { name: "keep", env: ["APP"] },
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

  it("names a binding a step's option calls, such as a decision's ask", () => {
    const source = workflowSource(
      `await step.decision("approve", { description: "Approve", from: params.reviewer, timeout: "1 day", ask: async (request) => await env.MAIL.call("mail.send", request) });`,
      "step, { params, env }"
    );

    expect(describeWorkflow(source).steps).toMatchObject([
      { name: "approve", env: ["MAIL"] },
    ]);
  });

  it("refuses a workflow that calls a binding anywhere but in the function of the step that makes the call", () => {
    const own = "in the step's own function";
    const cases: [string, string][] = [
      // A stub made in one step and called in another: the call would
      // show under the step that made the stub.
      [
        `let app;\n${inStep(`app = appServer(env);`, "prepare")}\n${inStep(`await app.hit();`)}`,
        "don't keep `env`",
      ],
      // A function over env kept in one step and run in another.
      [
        `const later = [];\n${inStep(`later.push(() => env.APP.call("hit"));`, "prepare")}\n${inStep(`await later[0]();`)}`,
        own,
      ],
      // A stub kept within one step.
      [inStep(`const app = appServer(env); await app.hit();`), "don't keep"],
      [inStep(`const crm = appExports(env.CRM); await crm.find({});`), "keep"],
      // A function inside the step's own, which could outlive it.
      [
        inStep(
          `await Promise.all(input.ids.map((id) => env.CRM.call("get", id)));`
        ),
        own,
      ],
      // A helper of the workflow's, which any step could run.
      [
        `const book = async () => await env.APP.call("book", input);\n${inStep(`await book();`)}`,
        own,
      ],
      // Between steps, where no step makes the call.
      [`await env.APP.call("book", input);`, own],
      [
        `await step.do("book", { description: "Book", sideEffect: true, input: await env.APP.call("total") }, async () => 1);`,
        own,
      ],
    ];

    for (const [body, message] of cases) {
      expect(() =>
        describeWorkflow(workflowSource(body, "step, { input, env }"))
      ).toThrow(message);
    }
    // In the step's own function, a loop makes each call where it's read.
    expect(
      describeWorkflow(
        workflowSource(
          inStep(
            `for (const id of input.ids) { await env.CRM.call("get", id); }`
          ),
          "step, { input, env }"
        )
      ).steps
    ).toMatchObject([{ name: "tidy-up", env: ["CRM"] }]);
  });

  it("refuses a workflow whose file takes a built-in the run is made with, or changes what it doesn't declare", () => {
    const tidy = workflowSource(
      inStep(`await leaked.APP.call("sendAll");`),
      "step, { input }"
    );
    const cases: [string, string][] = [
      // The run wraps its bindings in a Proxy: a constructor put in its
      // place as the module loads is handed them, with no `env` in sight.
      [
        `const Real = globalThis.Proxy;\nlet leaked;\nglobalThis.Proxy = function (target, handler) { leaked = target; return new Real(target, handler); };`,
        "Don't use `globalThis`",
      ],
      [
        `let leaked;\nself.Proxy = class { constructor(target) { leaked = target; } };`,
        "Don't use `self`",
      ],
      [`const Real = Proxy;\nlet leaked;`, "Don't use `Proxy`"],
      [`const leaked = Reflect.get(input, "env");`, "Don't use `Reflect`"],
      [`const leaked = Function("return this")();`, "Don't use `Function`"],
      [`const leaked = (0, eval)("this");`, "Don't use `eval`"],
      // A built-in, or what another module exports, changed for everyone.
      [
        `let leaked;\nArray.prototype.map = function () { leaked = this; return []; };`,
        "Don't change `Array`, a global",
      ],
      [
        `let leaked;\nObject.fromEntries = (entries) => { leaked = entries; };`,
        "Don't change `Object`, a global",
      ],
      [`let leaked;\ndelete Object.hasOwn;`, "Don't change `Object`, a global"],
      [`let leaked;\nPromise = undefined;`, "Don't change `Promise`, a global"],
      // The same through a destructuring assignment, however nested, and
      // a loop that assigns each time round.
      [
        `let leaked;\n({ map: Array.prototype.map } = { map() { leaked = this; return []; } });`,
        "Don't change `Array`, a global",
      ],
      [
        `let leaked;\n[Object.fromEntries] = [(entries) => { leaked = entries; }];`,
        "Don't change `Object`, a global",
      ],
      [
        `let leaked;\n({ made: { with: [, Array.prototype.map = () => leaked] } } = { made: { with: [] } });`,
        "Don't change `Array`, a global",
      ],
      [
        `let leaked;\n({ leaked, ...Object.prototype } = { APP: 1 });`,
        "Don't change `Object`, a global",
      ],
      [
        `let leaked;\nfor (Array.prototype.map of [() => leaked]) {}`,
        "Don't change `Array`, a global",
      ],
      // A type declared for the name declares no variable.
      [
        `let leaked;\ndeclare const Array: { prototype: { map: unknown } };\nArray.prototype.map = () => leaked;`,
        "Don't change `Array`, a global",
      ],
      // A `var` counts only in the block it is written in.
      [
        `let leaked;\n{ var made; }\nmade = leaked;`,
        "Don't change `made`, a global",
      ],
      // A name declared somewhere else in the file is still the global here.
      [
        `let leaked;\nconst first = (Array) => Array[0];\nArray.prototype.map = function () { leaked = this; return []; };`,
        "Don't change `Array`, a global",
      ],
      [
        `import { z } from "@grasp-os/sdk/workflow";\nlet leaked;\nz.object = () => leaked;`,
        "Don't change `z`, which is imported",
      ],
    ];

    for (const [top, message] of cases) {
      expect(() => describeWorkflow(`${top}\n${tidy}`)).toThrow(message);
      // The same in a file the workflow imports.
      expect(() => {
        checkWorkflowModule(`${top}\nexport const take = () => leaked;`);
      }).toThrow(message);
    }
    // A module may change what it declares, and name a type as it likes.
    const own = `let leaked = 0;\nleaked += 1;\nconst seen: Record<string, number> = {};\nseen.first = leaked;\ninterface Holder { self: string; Proxy: Function }`;
    expect(describeWorkflow(`${own}\n${tidy}`).steps).toHaveLength(1);
    expect(() => {
      checkWorkflowModule(`${own}\nexport const take = () => seen;`);
    }).not.toThrow();
  });

  it("rejects every way to reach the App's bindings that the step list couldn't name", () => {
    const cases: [string, string][] = [
      // The bindings under another name.
      [`const bindings = env;`, "don't keep `env`"],
      [`const { APP } = env;`, "don't keep `env`"],
      [`const app = env.APP;`, "don't keep `env`"],
      [`const call = env.APP.call;`, "don't keep `env`"],
      [inStep(`await env.APP.call.bind(env.APP)("sendAll");`), "don't keep"],
      [inStep(`await (0, env.APP.call)("sendAll");`), "don't keep `env`"],
      [inStep(`await env.valueOf().APP.call("sendAll");`), "don't keep `env`"],
      // Handed to other code, or copied.
      [inStep(`await helper(env);`), "don't keep `env`"],
      [inStep(`await helper(env.APP);`), "don't keep `env`"],
      [inStep(`await helper({ env });`), "don't keep `env`"],
      [inStep(`await helper({ ...env });`), "don't keep `env`"],
      [inStep(`await helper([env][0]);`), "don't keep `env`"],
      [inStep(`await appServer(env, 1).sendAll();`), "don't keep `env`"],
      // A name only known when it runs.
      [inStep(`await env["APP"].call("sendAll");`), "don't keep `env`"],
      [inStep(`await env[input.name].call("sendAll");`), "don't keep `env`"],
      [inStep(`await env.APP[input.method]("sendAll");`), "don't keep `env`"],
      [inStep(`await env?.APP.call("sendAll");`), "don't keep `env`"],
      // The SDK's stubs, which take `env`, under another name.
      [`const stub = appServer;`, "Only call `appServer`"],
      [
        `const appServer = (bindings) => bindings; const all = appServer(env);`,
        "Only call `appServer`",
      ],
      [inStep(`await helper(appExports);`), "Only call `appExports`"],
      // The context by another way than its parameter.
      [inStep(`await this.env.APP.call("sendAll");`), "Don't use `this`"],
      [
        inStep(`await arguments[1].env.APP.call("sendAll");`),
        "Don't use `arguments`",
      ],
      [inStep(`await eval("env").APP.call("sendAll");`), "Don't use `eval`"],
    ];

    for (const [body, message] of cases) {
      expect(() =>
        describeWorkflow(workflowSource(body, "step, { input, env }"))
      ).toThrow(message);
    }
  });

  it("reads only an arrow function, exported as the file's default, as the workflow", () => {
    const sdk = `import { workflow } from "@grasp-os/sdk/workflow";`;
    const sendAll = `{ const bindings = arguments[1].env; await step.do("tidy-up", { description: "Tidy" }, async () => { await bindings.APP.call("sendAll"); }); }`;
    const decoy = `workflow("tidy", { params: {} }, async (step) => { await step.sleep("rest", { description: "Rest", duration: 1000 }); })`;

    // A function with `arguments` of its own reads the context unnamed.
    expect(() =>
      describeWorkflow(
        `${sdk}\nexport default workflow("tidy", { params: {} }, async function (step, { params }) ${sendAll});`
      )
    ).toThrow("as an arrow function");
    // Another workflow runs in place of the one that's read.
    for (const exported of [
      `import other from "./lib/other.ts";\nconst decoy = ${decoy};\nexport default other;`,
      `import { other } from "./lib/other.ts";\nconst decoy = ${decoy};\nexport { other as default };`,
      `const decoy = ${decoy};\nexport { default } from "./lib/other.ts";`,
      `const decoy = ${decoy};\nexport * as default from "./lib/other.ts";`,
      `export default [${decoy}][0];`,
    ]) {
      expect(() => describeWorkflow(`${sdk}\n${exported}`)).toThrow(
        "Export the workflow as the file's default"
      );
    }
    // A workflow its file doesn't export as its default doesn't load, so
    // it has no steps to show.
    for (const unexported of [
      `${decoy};`,
      `export const tidy = ${decoy};`,
      `const tidy = ${decoy};\nexport default tidy;`,
    ]) {
      expect(() => describeWorkflow(`${sdk}\n${unexported}`)).toThrow(
        "Export the workflow as the file's default"
      );
    }
    expect(
      describeWorkflow(`${sdk}\nexport default ${decoy};`).steps
    ).toHaveLength(1);
  });

  it("refuses anything else in the workflow's file named as its env is, so every env is the context's", () => {
    const call = `await env.APP.call("sendAll");`;
    const rename = "Name this something other than `env`";
    const cases: string[] = [
      // A `var` in a block is the function's own variable, so here it is
      // the context's `env` itself: the call under it is a binding's.
      inStep(`{ var env; ${call} }`),
      inStep(`if (input.ok) { var env = env; ${call} }`),
      // A callback's parameter, a local, a catch binding, a loop's variable.
      inStep(`return input.totals.reduce((sum, env) => sum + env, 0);`),
      inStep(`const env = { APP: { call: () => 1 } }; ${call}`),
      inStep(`try { ${call} } catch (env) { return env; }`),
      inStep(`for (const env of input.totals) { ${call} }`),
      inStep(`const { first: env } = input; ${call}`),
      inStep(`const [, ...env] = input.totals; ${call}`),
      // A function or a class of that name, and between steps too.
      inStep(`function env() {} ${call}`),
      `const take = function env() {};\n${inStep(call)}`,
      inStep(`class env {} ${call}`),
      `const count = (env) => env.length;\n${inStep(call)}`,
    ];

    for (const body of cases) {
      expect(() =>
        describeWorkflow(workflowSource(body, "step, { input, env }"))
      ).toThrow(rename);
    }
    // Anywhere in the file, an import included.
    for (const top of [
      `import { env } from "./lib/env.ts";`,
      `import env from "./lib/env.ts";`,
      `import * as env from "./lib/env.ts";`,
      `const env = {};`,
      `const pick = ({ env }) => env;`,
      `declare const env: unknown;`,
      `enum env { One }`,
    ]) {
      expect(() =>
        describeWorkflow(
          `${top}\n${workflowSource(inStep(call), "step, { input, env }")}`
        )
      ).toThrow(rename);
    }
    // Under another name, that name is the one nothing else has.
    expect(() =>
      describeWorkflow(
        workflowSource(
          inStep(`return input.totals.map((bindings) => bindings);`),
          "step, { input, env: bindings }"
        )
      )
    ).toThrow("Name this something other than `bindings`");
    // A property or a key of that name is no variable.
    expect(
      describeWorkflow(
        workflowSource(
          inStep(`return { env: input.env, first: input.totals[0] };`),
          "step, { input, env }"
        )
      ).steps
    ).toMatchObject([{ name: "tidy-up" }]);
  });

  it("checks how the bindings are called apart from how the steps are laid out", () => {
    const nested = workflowSource(
      `const run = async () => { ${inStep(`await env.APP.call("tidy");`)} };\nawait run();`,
      "step, { env }"
    );
    const aliased = workflowSource(`const bindings = env;`, "step, { env }");

    // Steps that can't be read show as unread; their calls are all named.
    expect(() => describeWorkflow(nested)).toThrow("nested function");
    expect(() => {
      checkWorkflowBindings(nested);
    }).not.toThrow();
    expect(() => {
      checkWorkflowBindings(aliased);
    }).toThrow("don't keep `env`");
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
    // The SDK's `workflow` by way of another module isn't one it can read.
    expect(() =>
      describeWorkflow(`
import { workflow } from "./lib/sdk.ts";
export default workflow("x", { params: {} }, async () => null);`)
    ).toThrow("Expected one call to `workflow`");
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
