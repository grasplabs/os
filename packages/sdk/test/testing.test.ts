/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { describe, expect, it } from "vite-plus/test";

import {
  dryRun,
  runWorkflowTests,
  testRun,
  workflowTests,
} from "../src/testing.ts";
import { person, workflow, z } from "../src/workflow.ts";
import invoiceTests from "./workflows/invoice-approval.test.ts";
import { invoiceWorkflow } from "./workflows/invoice-approval.ts";
import type { InvoiceSystems } from "./workflows/invoice-approval.ts";

const invoice = {
  number: "INV-7",
  purchaseOrder: "PO-1",
  text: "Total €8,000",
};
const unusedSystems: InvoiceSystems = {
  findPurchaseOrder: async () => null,
  book: async () => "unused",
  askReviewer: async () => {},
};

const noAsk = async (): Promise<void> => {};

/** Counts its runs in its state. */
const counter = workflow(
  "counter",
  { params: {} },
  async (_step, { state }) => {
    const count = await state.get("count");
    await state.set("count", typeof count === "number" ? count + 1 : 1);
  }
);

/** Reads a customer, then emails each of their open orders. */
const reminders = (systems: {
  customer: (id: string) => Promise<{ email: string; open: string[] }>;
  send: (email: string, order: string) => Promise<string>;
}) =>
  workflow(
    "order-reminders",
    { params: {}, input: z.object({ customer: z.string() }) },
    async (step, { input }) => {
      const customer = await step.do(
        "read-customer",
        { description: "Read the customer", retries: 3 },
        async () => await systems.customer(input.customer)
      );
      const sent: string[] = [];
      for (const order of customer.open) {
        sent.push(
          // oxlint-disable-next-line no-await-in-loop -- steps run in order
          await step.do(
            "send",
            {
              description: "Email the reminder",
              sideEffect: true,
              key: order,
              input: { to: customer.email, order },
            },
            async ({ idempotencyKey, input: email }) =>
              await systems.send(email.to, `${email.order}:${idempotencyKey}`)
          )
        );
      }
      return sent;
    }
  );

const liveSystems = () => {
  const reads: string[] = [];
  const sent: string[] = [];
  return {
    reads,
    sent,
    customer: async (id: string) => {
      reads.push(id);
      return { email: "ann@example.com", open: ["o-1", "o/2"] };
    },
    send: async (email: string, order: string) => {
      sent.push(`${email} ${order}`);
      return "message-1";
    },
  };
};

describe("test runs", () => {
  it("run the steps that read, and record the ones that change something with their input", async () => {
    const systems = liveSystems();

    const run = await testRun(reminders(systems), {
      input: { customer: "c-1" },
    });

    expect(systems.reads).toStrictEqual(["c-1"]);
    expect(systems.sent).toStrictEqual([]);
    expect(run.sideEffects).toStrictEqual([
      { name: "send:o-1", input: { to: "ann@example.com", order: "o-1" } },
      { name: "send:o/2", input: { to: "ann@example.com", order: "o/2" } },
    ]);
  });

  it("return a mock instead of running the step, by key or else by name", async () => {
    const systems = liveSystems();

    const run = await testRun(reminders(systems), {
      input: { customer: "c-1" },
      mocks: {
        "read-customer": { email: "bo@example.com", open: ["o-1", "o/2"] },
        send: ({ name, input }) =>
          `mocked ${name} for ${JSON.stringify(input)}`,
        "send:o/2": "mocked o/2",
      },
    });

    expect(systems.reads).toStrictEqual([]);
    expect(run).toMatchObject({
      status: "completed",
      output: [
        'mocked send:o-1 for {"to":"bo@example.com","order":"o-1"}',
        "mocked o/2",
      ],
    });
  });

  it("fail a step they're told to, without retrying it, and stop the run there", async () => {
    const systems = liveSystems();

    const run = await testRun(reminders(systems), {
      input: { customer: "c-1" },
      failures: { "read-customer": "CRM unavailable" },
    });

    expect(run).toMatchObject({
      status: "failed",
      error: { message: "CRM unavailable" },
    });
    expect(systems.reads).toStrictEqual([]);
    expect(run.sideEffects).toStrictEqual([]);
  });

  it("still check a mocked model answer against the step's schema", async () => {
    const run = await testRun(invoiceWorkflow(unusedSystems), {
      input: invoice,
      mocks: { "match-po": { amount: 8000 }, extract: { total: "lots" } },
    });

    expect(run).toMatchObject({
      status: "failed",
      error: { code: "workflow.invalid_model_output" },
    });
  });

  it("answer decisions and deliver events, skip sleeps, and time out any other wait at once", async () => {
    const approvals = workflow(
      "approvals",
      { params: { approver: person({ label: "Approver", default: "anna" }) } },
      async (step, { params }) => {
        await step.sleep("cool-off", {
          description: "Wait",
          duration: "3 days",
        });
        const signed = await step.waitFor("signed", {
          description: "Wait for the signature",
          type: "document.signed",
          timeout: "2 weeks",
        });
        const first = await step.decision("first", {
          description: "Approve",
          from: params.approver,
          ask: noAsk,
        });
        const second = await step.decision("second", {
          description: "Approve again",
          from: params.approver,
          ask: noAsk,
          timeout: "2 days",
          remindAfter: "1 day",
        });
        return { signed, first, second };
      }
    );

    const run = await testRun(approvals, {
      events: [{ type: "document.signed", payload: { by: "bo" } }],
      decisions: { first: { approved: true, by: "cas" } },
    });

    expect(run).toMatchObject({
      status: "completed",
      output: {
        signed: { received: true, payload: { by: "bo" } },
        first: { outcome: "approved", by: "cas" },
        second: { outcome: "timedOut" },
      },
    });
    expect(run.sideEffects.map(({ name }) => name)).toStrictEqual([
      "first#ask",
      "second#ask",
      "second#remind",
    ]);
  });

  it("start from the state they're given and keep what the run writes", async () => {
    const run = await testRun(counter, { state: { count: 41 } });

    expect(run.state).toStrictEqual({ count: 42 });
  });
});

describe("dry runs", () => {
  it("run the reads, change nothing and report what they would have changed", async () => {
    const reads: string[] = [];
    const writes: string[] = [];
    const definition = invoiceWorkflow({
      findPurchaseOrder: async (number) => {
        reads.push(number);
        return { amount: 8000 };
      },
      book: async (entry) => {
        writes.push(`booked ${entry.invoice}`);
        return "ledger-42";
      },
      askReviewer: async () => {
        writes.push("asked the reviewer");
      },
    });

    const run = await dryRun(definition, {
      input: invoice,
      model: () => ({ total: 8000, currency: "EUR" }),
      decisions: { review: { approved: true, by: "anna" } },
    });

    expect(reads).toStrictEqual(["PO-1"]);
    expect(writes).toStrictEqual([]);
    expect(run.report).toContain(
      [
        "Dry run of invoice-approval",
        'Completed with {"status":"booked"}',
        "Side effects that didn't run have no result, which a real run may use: review#ask, book",
      ].join("\n")
    );
    expect(run.report).toContain(
      'extract "Total €8,000": ran, returned {"total":8000,"currency":"EUR"}'
    );
    expect(run.report).toContain(
      [
        "Would have changed:",
        '- review#ask {"from":"finance-team","reminder":false}',
        '- book {"invoice":"INV-7","total":8000}',
      ].join("\n")
    );
  });

  it("report the state they would have written, and keep none of it", async () => {
    const state = { count: 41, other: "same" };

    const run = await dryRun(counter, { state });

    expect(run.report).toContain('Would have changed:\n- state "count" to 42');
    expect(run.report).not.toContain("other");
    expect(state).toStrictEqual({ count: 41, other: "same" });
  });

  it("report a run that fails, and where", async () => {
    const run = await dryRun(invoiceWorkflow(unusedSystems), {
      input: invoice,
      failures: { "match-po": "Purchase order system unavailable" },
    });

    expect(run.report).toContain("Failed: Purchase order system unavailable");
    expect(run.report).toContain(
      "match-po: failed: Purchase order system unavailable"
    );
    expect(run.report).toContain("Would have changed:\n- nothing");
  });
});

describe("workflow tests", () => {
  it("pass for the sample invoice workflow", async () => {
    const report = await runWorkflowTests(invoiceTests);

    expect(report.results.flatMap(({ failures }) => failures)).toStrictEqual(
      []
    );
    expect(report.passed).toBeTruthy();
  });

  it("fail for a version that books every invoice without review, saying why", async () => {
    const booksEverything = workflow(
      "invoice-approval",
      { params: {}, input: z.object({ number: z.string() }) },
      async (step, { input }) => {
        const entry = await step.do(
          "book",
          {
            description: "Book the invoice in the ledger",
            sideEffect: true,
            input: { invoice: input.number, total: 8000 },
          },
          async () => "ledger-42"
        );
        return { status: "booked", entry };
      }
    );

    const report = await runWorkflowTests(
      workflowTests(booksEverything, invoiceTests.tests)
    );

    expect(report.passed).toBeFalsy();
    expect(
      report.results.filter(({ passed }) => !passed).map(({ name }) => name)
    ).toStrictEqual([
      "books an invoice below the threshold without asking anyone",
      "asks the reviewer above the threshold and books once approved",
      "doesn't book an invoice the reviewer rejects",
      "books nothing when the purchase order system is down",
    ]);
    expect(report.results.at(-1)?.failures).toStrictEqual([
      'Expected the run to fail with "Purchase order system unavailable"; it completed',
      'Expected side effects []; got [{"input":{"invoice":"INV-7","total":8000},"name":"book"}]',
    ]);
  });

  it("fail for a workflow without tests", async () => {
    const report = await runWorkflowTests(
      workflowTests(invoiceWorkflow(unusedSystems), [])
    );

    expect(report.passed).toBeFalsy();
  });
});
