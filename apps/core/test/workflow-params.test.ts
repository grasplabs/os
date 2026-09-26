import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { startRun } from "../src/workflows/runs.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, resumed, stopped } from "./runs.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  refusal,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";
import { runEvents } from "./workflow-apps.ts";

// The values of workflows' parameters: builders set them directly, audited
// without the value (R16), and runs read them as the version they are
// pinned to declares them. A sensitive parameter is set like any other.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * The invoice workflow and its test: a limit and a reviewer, each
 * sensitive as `sensitive` says (the limit is by default, the reviewer
 * isn't). `extra` goes after the definition, to change what it exports.
 */
const invoiceVersion = (
  sensitive: { limit?: boolean; reviewer?: boolean } = {},
  extra = ""
): Record<string, string> => ({
  "workflows/invoices.ts": `import { money, person, workflow, z } from "@grasp-os/sdk/workflow";

const definition = workflow(
  "invoices",
  {
    input: z.unknown(),
    params: {
      limit: money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: ${String(sensitive.limit ?? true)} }),
      reviewer: person({ label: "Reviewer", default: "role:admin", sensitive: ${String(sensitive.reviewer ?? false)} }),
    },
  },
  async (step, { params }) =>
    await step.do("limit", { description: "Read the limit" }, async () => params.limit)
);
${extra}
export default definition;
`,
  "workflows/invoices.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./invoices.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { limit: 1 }, expect: { output: 1 } }]);
`,
});

const invoiceFiles = invoiceVersion();

/** Why a version's tests failed, as `workflow.tests_failed` says. */
const testsFailedSchema = z.object({
  details: z.object({ failures: z.array(z.string()) }),
});

/** A new App with the invoice workflow as its current version. */
const invoicesApp = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, invoiceFiles);
  return id;
};

/** One parameter of the invoice workflow, as `person` sees it. */
const paramOf = async (person: Person, app: string, name: string) => {
  const params = await person.api.workflows.params.list(app, "invoices");
  const found = params.find((param) => param.name === name);
  if (!found) {
    throw new Error(`No parameter ${name}`);
  }
  return found;
};

/** The invoice workflow with its limit as text, not money. */
const textLimitVersion = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(invoiceVersion()).map(([path, text]) => [
      path,
      text
        .replace("{ money, person,", "{ money, person, text,")
        .replace(
          'money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: true })',
          'text({ label: "Review invoices above", default: "none" })'
        ),
    ])
  );

/** What a run of the invoice workflow read as its limit, once it ended. */
const limitOfRun = async (person: Person, run: string): Promise<unknown> => {
  await finished(run);
  const { status, output } = await person.api.workflows.status(run);
  expect(status).toBe("completed");
  return output;
};

/** Starts the invoice workflow and returns the limit it read. */
const runLimit = async (person: Person, app: string): Promise<unknown> => {
  const run = await person.api.workflows.start(app, "invoices");
  return await limitOfRun(person, run.id);
};

describe("workflow parameters", () => {
  it("are listed as the code declares them, and set at once, sensitive or not, audited without their values", async () => {
    const builder = await personApi("builder");
    const app = await invoicesApp(builder);
    await expect(
      builder.api.workflows.params.list(app, "invoices")
    ).resolves.toStrictEqual([
      {
        name: "limit",
        kind: "money",
        label: "Review invoices above",
        sensitive: true,
        default: 500_000,
        currency: "EUR",
        value: null,
      },
      {
        name: "reviewer",
        kind: "person",
        label: "Reviewer",
        sensitive: false,
        default: "role:admin",
        value: null,
      },
    ]);

    const events = await auditedDuring(async () => {
      await expect(
        builder.api.workflows.params.set(
          app,
          "invoices",
          "reviewer",
          "role:builder"
        )
      ).resolves.toMatchObject({ value: "role:builder" });
      await expect(
        builder.api.workflows.params.set(app, "invoices", "limit", 912_345)
      ).resolves.toMatchObject({ sensitive: true, value: 912_345 });
    });
    // The audit log names the parameter, never its value (R16).
    expect(events).toMatchObject([
      {
        actor: { type: "person", userId: builder.userId },
        action: "workflow.param.updated",
        target: { type: "app", id: app },
        detail: { workflow: "invoices", param: "reviewer" },
      },
      {
        actor: { type: "person", userId: builder.userId },
        action: "workflow.param.updated",
        target: { type: "app", id: app },
        detail: { workflow: "invoices", param: "limit" },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/role:builder|912345/u);
  });

  it("refuse values that don't fit, parameters that don't exist, and people who can't build", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const app = await invoicesApp(builder);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const set = async (person: Person, param: string, value: string | number) =>
      await outcome(
        person.api.workflows.params.set(app, "invoices", param, value)
      );
    expect({
      notMoney: await set(builder, "limit", "a lot"),
      notWhole: await set(builder, "limit", 1.5),
      notAPerson: await set(builder, "reviewer", "anna"),
      tooLong: await set(builder, "reviewer", `person:${"a".repeat(5000)}`),
      unknown: await set(builder, "budget", 1),
      byUser: await set(user, "reviewer", "role:builder"),
      // Grasp staff set no client's values.
      byStaff: await outcome(
        staff.workflows.params.set(app, "invoices", "reviewer", "role:user")
      ),
      listByUser: await outcome(
        user.api.workflows.params.list(app, "invoices")
      ),
      noWorkflow: await outcome(
        builder.api.workflows.params.list(app, "missing")
      ),
    }).toStrictEqual({
      notMoney: "workflow.param_invalid",
      notWhole: "workflow.param_invalid",
      notAPerson: "workflow.param_invalid",
      tooLong: "workflow.param_invalid",
      unknown: "workflow.param_not_found",
      byUser: "role.forbidden",
      byStaff: "role.forbidden",
      listByUser: "role.forbidden",
      noWorkflow: "workflow.not_found",
    });
  });
});

describe("declarations", () => {
  it("count a stored value only where the reading version declares it of that kind", async () => {
    const builder = await personApi("builder");
    const app = await invoicesApp(builder);
    const v1 = 1;
    // v2 declares the limit as text, and a text value is set under it.
    await release(builder, app, textLimitVersion());
    const underV2 = await paramOf(builder, app, "limit");
    await builder.api.workflows.params.set(app, "invoices", "limit", "none");
    await builder.api.apps.versions.setCurrent(app, v1);
    expect({
      underV2: underV2.kind,
      // v1 declares money: the text isn't one, so the default applies.
      underV1: await paramOf(builder, app, "limit"),
    }).toMatchObject({
      underV2: "text",
      underV1: { kind: "money", value: null },
    });
  });

  it("can't be declared past the bounds core keeps: the version's tests fail", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    const files = Object.fromEntries(
      Object.entries(invoiceVersion()).map(([path, text]) => [
        path,
        text.replace("Review invoices above", "L".repeat(201)),
      ])
    );
    const refused = await refusal(release(builder, app, files));
    const { failures } = testsFailedSchema.parse(refused).details;
    expect({
      code: workflowErrors.codeOf(refused),
      loads: failures.some((failure) =>
        /^invoices: its code doesn't load: .*Parameters/u.test(failure)
      ),
    }).toStrictEqual({ code: "workflow.tests_failed", loads: true });
  });

  it("are refused from code that declares a parameter twice", async () => {
    const builder = await personApi("builder");
    const app = await invoicesApp(builder);
    // Hand-made metadata: the limit again, not sensitive this time.
    await release(
      builder,
      app,
      invoiceVersion(
        {},
        `definition.metadata.params.push({ ...definition.metadata.params[0], sensitive: false });`
      )
    );
    await expect(
      outcome(builder.api.workflows.params.list(app, "invoices"))
    ).resolves.toBe("workflow.invalid");
    // A run of it fails as it loads: it can't read its values either.
    const run = await builder.api.workflows.start(app, "invoices");
    await finished(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    expect({ status, code: failure?.error.code }).toStrictEqual({
      status: "failed",
      code: "workflow.invalid",
    });
  });
});

describe("runs", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("use a value as soon as it's set", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    await release(builder, app, invoiceVersion({ limit: false }));
    const before = await runLimit(builder, app);
    await builder.api.workflows.params.set(app, "invoices", "limit", 700_000);
    expect({ before, after: await runLimit(builder, app) }).toStrictEqual({
      before: 500_000,
      after: 700_000,
    });
  });

  it("use a sensitive value as soon as it's set", async () => {
    const builder = await personApi("builder");
    const app = await invoicesApp(builder);
    await builder.api.workflows.params.set(app, "invoices", "limit", 900_000);
    await expect(runLimit(builder, app)).resolves.toBe(900_000);
  });

  it("go by what the version they are pinned to declares, not the current one", async () => {
    const builder = await personApi("builder");
    const app = await invoicesApp(builder);
    // A run pinned to v1, where the limit is money, started just before
    // workflows were switched off: it waits before its first step, where it
    // records its values, and is stopped there.
    const { FEATURES: features } = env;
    const on = z.record(z.string(), z.boolean()).parse(features);
    let run: Awaited<ReturnType<typeof startRun>>;
    try {
      env.FEATURES = { ...on, workflows: false };
      run = await startRun(
        { ...env, FEATURES: on },
        {
          app: appIdSchema.parse(app),
          workflow: workflowIdSchema.parse("invoices"),
          input: undefined,
          startedBy: builder.userId,
          actor: { type: "system" },
        }
      );
      await runEvents(run.id, "workflow.run.waiting");
      await stopped(run.id);
    } finally {
      env.FEATURES = features;
    }
    // Meanwhile v2, where the limit is text, is current, with a text value.
    // The run's next execution reads the values anew.
    await release(builder, app, textLimitVersion());
    await builder.api.workflows.params.set(app, "invoices", "limit", "none");
    await resumed(run.id);
    expect({
      pinned: await limitOfRun(builder, run.id),
      current: await runLimit(builder, app),
    }).toStrictEqual({
      // Not money, as v1 declares it: the code's default.
      pinned: 500_000,
      current: "none",
    });
  });
});
