import type { Role } from "@grasp-os/shared/roles";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The values of workflows' parameters. A sensitive one never changes on
// one person's word (threat model R8, WF5): a change waits until someone
// other than the person who asked approves it, and the approval sets the
// value. These tests try to get a sensitive value changed any other way.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** A workflow with a sensitive limit and a reviewer who isn't, and its test. */
const invoiceFiles = {
  "workflows/invoices.ts": `import { money, person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "invoices",
  {
    input: z.unknown(),
    params: {
      limit: money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: true }),
      reviewer: person({ label: "Reviewer", default: "role:admin" }),
    },
  },
  async (step, { params }) =>
    await step.do("limit", { description: "Read the limit" }, async () => params.limit)
);
`,
  "workflows/invoices.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./invoices.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { limit: 1 }, expect: { output: 1 } }]);
`,
};

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

/** Asks to change the limit as `requester`; returns the pending approval. */
const limitChange = async (requester: Person, app: string, to: number) => {
  const { pending } = await requester.api.workflows.params.set(
    app,
    "invoices",
    "limit",
    to
  );
  if (!pending) {
    throw new Error("The change isn't pending");
  }
  return pending;
};

describe("workflow parameters", () => {
  it("are listed as the code declares them, and a value that isn't sensitive is set at once", async () => {
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
        pending: null,
      },
      {
        name: "reviewer",
        kind: "person",
        label: "Reviewer",
        sensitive: false,
        default: "role:admin",
        value: null,
        pending: null,
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
      ).resolves.toMatchObject({ value: "role:builder", pending: null });
    });
    // The audit log names the parameter, never its value (R16).
    expect(events).toMatchObject([
      {
        actor: { type: "person", userId: builder.userId },
        action: "workflow.param.updated",
        target: { type: "app", id: app },
        detail: { workflow: "invoices", param: "reviewer" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("role:builder");
  });

  it("refuse values that don't fit, parameters that don't exist, and people who can't build", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const app = await invoicesApp(builder);
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
      listByUser: "role.forbidden",
      noWorkflow: "workflow.not_found",
    });
  });
});

describe("sensitive values", () => {
  it("change only once someone other than the requester approves, and each step is audited", async () => {
    const builder = await personApi("builder");
    const other = await personApi("builder");
    const app = await invoicesApp(builder);

    let pending: Awaited<ReturnType<typeof limitChange>> | undefined;
    const requested = await auditedDuring(async () => {
      pending = await limitChange(builder, app, 900_000);
    });
    expect(pending).toMatchObject({
      kind: "param",
      status: "pending",
      approvers: "builders",
      app,
      workflow: "invoices",
      param: "limit",
      from: null,
      to: 900_000,
      requestedBy: builder.userId,
    });
    await expect(paramOf(builder, app, "limit")).resolves.toMatchObject({
      value: null,
      pending: { id: pending?.id, to: 900_000 },
    });
    expect(requested).toMatchObject([
      {
        action: "workflow.param.requested",
        target: { type: "app", id: app },
        detail: { workflow: "invoices", param: "limit", approval: pending?.id },
      },
    ]);

    const approved = await auditedDuring(async () => {
      await other.api.approvals.approve(pending?.id ?? "");
    });
    expect({
      param: await paramOf(builder, app, "limit"),
      approved,
      // The audit log never holds the values (R16).
      valuesAudited: JSON.stringify([...requested, ...approved]).includes(
        "900000"
      ),
      // The next change starts from the value now set.
      next: await limitChange(other, app, 1_000_000),
    }).toMatchObject({
      param: { value: 900_000, pending: null },
      approved: [
        {
          actor: { type: "person", userId: other.userId },
          action: "workflow.param.approved",
          detail: {
            workflow: "invoices",
            param: "limit",
            approval: pending?.id,
            requestedBy: builder.userId,
          },
        },
      ],
      valuesAudited: false,
      next: { from: 900_000, to: 1_000_000 },
    });
  });

  it("are never approved by the requester, not even an admin who is the only admin", async () => {
    const admin = await personApi("admin");
    const app = await invoicesApp(admin);
    const pending = await limitChange(admin, app, 900_000);
    expect([
      await outcome(admin.api.approvals.approve(pending.id)),
      await outcome(
        admin.api.approvals.approve(pending.id, { breakGlass: true })
      ),
    ]).toStrictEqual(["approval.self", "approval.self"]);
    await expect(paramOf(admin, app, "limit")).resolves.toMatchObject({
      value: null,
    });
  });

  it("are never approved by users or Grasp staff", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const app = await invoicesApp(builder);
    const pending = await limitChange(builder, app, 900_000);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    expect([
      await outcome(user.api.approvals.approve(pending.id)),
      await outcome(staff.approvals.approve(pending.id)),
      await outcome(staff.approvals.decline(pending.id)),
    ]).toStrictEqual([
      "approval.forbidden",
      "approval.forbidden",
      "approval.forbidden",
    ]);
    await expect(paramOf(builder, app, "limit")).resolves.toMatchObject({
      value: null,
    });
  });

  it("take one approval when two people approve at once", async () => {
    const builder = await personApi("builder");
    const first = await personApi("builder");
    const second = await personApi("admin");
    const app = await invoicesApp(builder);
    const pending = await limitChange(builder, app, 900_000);
    let outcomes: string[] = [];
    const events = await auditedDuring(async () => {
      outcomes = await Promise.all([
        outcome(first.api.approvals.approve(pending.id)),
        outcome(second.api.approvals.approve(pending.id)),
      ]);
    });
    expect(outcomes.toSorted()).toStrictEqual(["approval.closed", "ok"]);
    expect(events.map(({ action }) => action)).toStrictEqual([
      "workflow.param.approved",
    ]);
    await expect(paramOf(builder, app, "limit")).resolves.toMatchObject({
      value: 900_000,
    });
  });

  it("wait one at a time, and are withdrawn only by their requester", async () => {
    const builder = await personApi("builder");
    const other = await personApi("builder");
    const app = await invoicesApp(builder);
    const withdrawn = await limitChange(builder, app, 900_000);
    const refused = {
      second: await outcome(limitChange(other, app, 1)),
      withdrawByOther: await outcome(
        other.api.approvals.withdraw(withdrawn.id)
      ),
    };
    const events = await auditedDuring(async () => {
      await builder.api.approvals.withdraw(withdrawn.id);
    });
    expect({
      refused,
      events,
      approveAfter: await outcome(other.api.approvals.approve(withdrawn.id)),
      param: await paramOf(builder, app, "limit"),
    }).toMatchObject({
      refused: {
        second: "approval.conflict",
        withdrawByOther: "approval.forbidden",
      },
      events: [{ action: "workflow.param.withdrawn" }],
      approveAfter: "approval.closed",
      param: { value: null, pending: null },
    });
  });

  it("never apply once declined", async () => {
    const builder = await personApi("builder");
    const other = await personApi("builder");
    const app = await invoicesApp(builder);
    const declined = await limitChange(other, app, 1);
    const events = await auditedDuring(async () => {
      await builder.api.approvals.decline(declined.id);
    });
    expect({
      events,
      approveAfter: await outcome(builder.api.approvals.approve(declined.id)),
      param: await paramOf(builder, app, "limit"),
    }).toMatchObject({
      events: [{ action: "workflow.param.declined" }],
      approveAfter: "approval.closed",
      param: { value: null, pending: null },
    });
  });

  it("aren't approved once the requester left", async () => {
    const admin = await personApi("admin");
    const leaver = await personApi("builder");
    const app = await invoicesApp(admin);
    const pending = await limitChange(leaver, app, 900_000);
    await admin.api.members.remove(leaver.userId);
    await expect(
      outcome(admin.api.approvals.approve(pending.id))
    ).resolves.toBe("approval.stale");
    await expect(paramOf(admin, app, "limit")).resolves.toMatchObject({
      value: null,
    });
  });
});
