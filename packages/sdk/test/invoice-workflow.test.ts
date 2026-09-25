/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { z } from "../src/workflow.ts";
import type { DecisionRequest } from "../src/workflow.ts";
import { createFakeEngine } from "./fake-engine.ts";
import { invoiceWorkflow } from "./invoice-workflow.ts";
import type { InvoiceSystems } from "./invoice-workflow.ts";

const invoice = {
  number: "INV-7",
  purchaseOrder: "PO-1",
  text: "Total €8,000",
};

const fakeSystems = (
  overrides: Partial<InvoiceSystems> = {}
): InvoiceSystems & {
  booked: { idempotencyKey: string }[];
  asked: DecisionRequest[];
} => {
  const booked: { idempotencyKey: string }[] = [];
  const asked: DecisionRequest[] = [];
  return {
    booked,
    asked,
    findPurchaseOrder: async () => ({ amount: 8000 }),
    book: async (_entry, idempotencyKey) => {
      booked.push({ idempotencyKey });
      return "ledger-42";
    },
    askReviewer: async (request) => {
      asked.push(request);
    },
    ...overrides,
  };
};

const modelSays = (total: number) => () => ({ total, currency: "EUR" });

const approvedBy = (by: string) => () => ({
  received: true as const,
  payload: { approved: true, by },
});

const day = 86_400_000;

describe("the sample invoice workflow", () => {
  // Decisions read the clock; a frozen one makes their waits exact.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes every step, including the decision behind the threshold", () => {
    const { metadata } = invoiceWorkflow(fakeSystems());

    expect(metadata.steps).toStrictEqual([
      {
        name: "match-po",
        kind: "exact",
        description: "Find the purchase order the invoice refers to",
        params: [],
        sideEffect: false,
        locked: false,
      },
      {
        name: "extract",
        kind: "ai",
        description: "Read the total and currency from the invoice",
        params: ["extractionModel"],
        sideEffect: false,
        locked: false,
      },
      {
        name: "review",
        kind: "decision",
        description: "Ask the reviewer to approve invoices above the limit",
        params: ["threshold", "reviewer"],
        sideEffect: true,
        locked: false,
      },
      {
        name: "book",
        kind: "exact",
        description: "Book the invoice in the ledger",
        params: [],
        sideEffect: true,
        locked: true,
      },
    ]);
  });

  it("exposes its parameters and triggers as plain JSON", () => {
    const { metadata } = invoiceWorkflow(fakeSystems());

    expect(metadata.id).toBe("invoice-approval");
    expect(metadata.params).toStrictEqual([
      {
        name: "threshold",
        kind: "money",
        label: "Review invoices above",
        default: 5000,
        sensitive: true,
      },
      {
        name: "reviewer",
        kind: "person",
        label: "Reviewer",
        default: "finance-team",
        sensitive: false,
      },
      {
        name: "extractionModel",
        kind: "model",
        label: "Extraction model",
        default: "mistral-large",
        sensitive: true,
      },
    ]);
    expect(metadata.triggers).toStrictEqual([
      { type: "event", event: "invoice.received" },
    ]);
    expect(z.json().safeParse(metadata).success).toBeTruthy();
  });

  it("books an invoice below the threshold without asking anyone", async () => {
    const systems = fakeSystems();
    const { engine, decisions } = createFakeEngine({ model: modelSays(4000) });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "booked", entry: "ledger-42" });
    expect(decisions).toStrictEqual([]);
    expect(systems.booked).toStrictEqual([{ idempotencyKey: "run-1:book" }]);
  });

  it("asks the reviewer above the threshold and books once approved", async () => {
    const systems = fakeSystems();
    const { engine, decisions } = createFakeEngine({
      model: modelSays(8000),
      event: approvedBy("anna"),
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "booked", entry: "ledger-42" });
    expect(decisions).toStrictEqual([{ step: "review", from: "finance-team" }]);
    expect(systems.asked).toStrictEqual([
      {
        link: "https://grasp.test/decisions/review",
        reminder: false,
        idempotencyKey: "run-1:review:ask",
      },
    ]);
  });

  it("doesn't book an invoice the reviewer rejects", async () => {
    const systems = fakeSystems();
    const { engine } = createFakeEngine({
      model: modelSays(8000),
      event: () => ({
        received: true,
        payload: { approved: false, by: "anna", comment: "Wrong PO" },
      }),
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "rejected" });
    expect(systems.booked).toStrictEqual([]);
  });

  it("reminds the reviewer once, then gives up at the timeout", async () => {
    const systems = fakeSystems();
    const { askReviewer } = systems;
    // Sending the reminder takes a day, which comes off the time left.
    systems.askReviewer = async (request) => {
      await askReviewer(request);
      if (request.reminder) {
        vi.setSystemTime(Date.now() + day);
      }
    };
    const { engine, waits } = createFakeEngine({ model: modelSays(8000) });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "timedOut" });
    expect(systems.asked.map(({ reminder }) => reminder)).toStrictEqual([
      false,
      true,
    ]);
    expect(waits.map(({ timeout }) => timeout)).toStrictEqual([
      2 * day,
      4 * day,
    ]);
    expect(systems.booked).toStrictEqual([]);
  });

  it("uses the values people set instead of the defaults", async () => {
    const { engine, decisions, modelRequests } = createFakeEngine({
      params: { threshold: 10_000, extractionModel: "small-model" },
      model: modelSays(8000),
    });

    const result = await invoiceWorkflow(fakeSystems()).run(engine, invoice);

    expect(result.status).toBe("booked");
    expect(decisions).toStrictEqual([]);
    expect(modelRequests[0]?.model).toBe("small-model");
  });

  it("fails a run whose parameter value doesn't fit its kind, or is empty", async () => {
    for (const threshold of ["lots", null]) {
      const { engine } = createFakeEngine({ params: { threshold } });

      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        invoiceWorkflow(fakeSystems()).run(engine, invoice)
      ).rejects.toMatchObject({ code: "workflow.invalid_param" });
    }
  });

  it("keeps the parameter values it started with when it resumes", async () => {
    const systems = fakeSystems();
    const { book } = systems;
    let crashed = false;
    systems.book = async (entry, idempotencyKey) => {
      if (!crashed) {
        crashed = true;
        throw new Error("Ledger went away mid-call");
      }
      return await book(entry, idempotencyKey);
    };
    const params: Record<string, unknown> = { threshold: 10_000 };
    const { engine, decisions } = createFakeEngine({
      params,
      model: modelSays(8000),
    });
    const definition = invoiceWorkflow(systems);

    await expect(definition.run(engine, invoice)).rejects.toThrow(
      "Ledger went away"
    );
    params.threshold = 1000;
    const result = await definition.run(engine, invoice);

    expect(result.status).toBe("booked");
    expect(decisions).toStrictEqual([]);
  });

  it("fails a run whose input doesn't match the input schema", async () => {
    const { engine } = createFakeEngine();

    await expect(
      invoiceWorkflow(fakeSystems()).run(engine, { number: "INV-7" })
    ).rejects.toMatchObject({ code: "workflow.invalid_input" });
  });

  it("resumes after a crash without redoing finished steps, with the same key", async () => {
    let lookups = 0;
    let crashed = false;
    const systems = fakeSystems({
      findPurchaseOrder: async () => {
        lookups += 1;
        return { amount: 4000 };
      },
    });
    const bookOnce = systems.book;
    const keys: string[] = [];
    systems.book = async (entry, idempotencyKey) => {
      keys.push(idempotencyKey);
      if (!crashed) {
        crashed = true;
        throw new Error("Ledger went away mid-call");
      }
      return await bookOnce(entry, idempotencyKey);
    };
    const { engine, modelRequests } = createFakeEngine({
      model: modelSays(4000),
    });
    const definition = invoiceWorkflow(systems);

    await expect(definition.run(engine, invoice)).rejects.toThrow(
      "Ledger went away"
    );
    const result = await definition.run(engine, invoice);

    expect(result.status).toBe("booked");
    expect(lookups).toBe(1);
    expect(modelRequests).toHaveLength(1);
    expect(keys).toStrictEqual(["run-1:book", "run-1:book"]);
  });
});
