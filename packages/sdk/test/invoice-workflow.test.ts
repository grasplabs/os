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
import { createFakeEngine, invoice } from "./fakes.ts";
import { outlineOf } from "./outline.ts";
import { invoiceWorkflow } from "./workflows/invoice-approval.ts";
import type { InvoiceSystems } from "./workflows/invoice-approval.ts";
// oxlint-disable-next-line import/default -- Vite's `?raw` import; typed in raw.d.ts
import invoiceSource from "./workflows/invoice-approval.ts?raw";

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
    findPurchaseOrder: async () => ({ amount: 800_000 }),
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

const day = 86_400_000;

describe("the sample invoice workflow", () => {
  // Decisions read the clock; a frozen one makes their waits exact.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists its steps from the code, with the review nested under its condition", () => {
    expect(outlineOf(invoiceSource)).toStrictEqual([
      {
        type: "step",
        name: "match-po",
        kind: "exact",
        description: "Find the purchase order the invoice refers to",
        sideEffect: false,
        locked: true,
        params: [],
        options: {},
      },
      {
        type: "step",
        name: "extract",
        kind: "ai",
        description: "Read the total and currency from the invoice",
        sideEffect: false,
        locked: false,
        params: ["extractionModel"],
        options: {
          instructions:
            "Read the invoice's total amount in whole minor units (cents for EUR) and its ISO 4217 currency code.",
          retries: { limit: 2 },
        },
      },
      {
        type: "branch",
        condition: "extracted.total > params.threshold",
        params: ["threshold"],
        steps: [
          {
            type: "step",
            name: "review",
            kind: "decision",
            description: "Ask the reviewer to approve invoices above the limit",
            sideEffect: true,
            locked: false,
            params: ["reviewer"],
            options: { timeout: "7 days", remindAfter: "2 days" },
          },
        ],
        otherwise: [],
      },
      {
        type: "step",
        name: "book",
        kind: "exact",
        description: "Book the invoice in the ledger",
        sideEffect: true,
        locked: true,
        params: [],
        options: {},
      },
    ]);
  });

  it("asks the model with the instructions and the model parameter", async () => {
    const { engine, modelRequests } = createFakeEngine({
      model: modelSays(400_000),
    });

    await invoiceWorkflow(fakeSystems()).run(engine, invoice);

    expect(modelRequests).toMatchObject([
      {
        step: "extract",
        model: "mistral-large",
        instructions:
          "Read the invoice's total amount in whole minor units (cents for EUR) and its ISO 4217 currency code.",
        input: "Total €8,000",
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
        default: 500_000,
        sensitive: true,
        currency: "EUR",
      },
      {
        name: "reviewer",
        kind: "person",
        label: "Reviewer",
        default: "team:finance",
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
    const { engine } = createFakeEngine({ model: modelSays(400_000) });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "booked", entry: "ledger-42" });
    expect(systems.asked).toStrictEqual([]);
    expect(systems.booked).toStrictEqual([{ idempotencyKey: "run-1:book" }]);
  });

  it("asks the reviewer above the threshold and books once approved", async () => {
    const systems = fakeSystems();
    const { engine } = createFakeEngine({
      model: modelSays(800_000),
      decisions: { review: { approved: true, by: "anna" } },
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "booked", entry: "ledger-42" });
    expect(systems.asked).toStrictEqual([
      {
        recipients: [
          {
            userId: "test-person",
            name: "Test Person",
            email: "test-person@grasp.test",
            link: "https://grasp.test/decisions/review",
          },
        ],
        reminder: false,
        idempotencyKey: "run-1:review#ask",
      },
    ]);
  });

  it("doesn't book an invoice the reviewer rejects", async () => {
    const systems = fakeSystems();
    const { engine } = createFakeEngine({
      model: modelSays(800_000),
      decisions: {
        review: {
          approved: false,
          by: "anna",
          payload: { comment: "Wrong PO" },
        },
      },
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
    const { engine, steps } = createFakeEngine({
      model: modelSays(800_000),
      // A wait that times out takes its time; move the frozen clock on.
      skipTime: (milliseconds) => {
        vi.setSystemTime(Date.now() + milliseconds);
      },
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result).toStrictEqual({ status: "timedOut" });
    expect(systems.asked.map(({ reminder }) => reminder)).toStrictEqual([
      false,
      true,
    ]);
    expect(
      steps.flatMap((record) =>
        record.type === "wait" ? [record.timeout] : []
      )
    ).toStrictEqual([2 * day, 4 * day]);
    expect(systems.booked).toStrictEqual([]);
  });

  it("uses the values people set instead of the defaults", async () => {
    const systems = fakeSystems();
    const { engine, modelRequests } = createFakeEngine({
      params: { threshold: 1_000_000, extractionModel: "small-model" },
      model: modelSays(800_000),
    });

    const result = await invoiceWorkflow(systems).run(engine, invoice);

    expect(result.status).toBe("booked");
    expect(systems.asked).toStrictEqual([]);
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
    const params: Record<string, unknown> = { threshold: 1_000_000 };
    const { engine } = createFakeEngine({
      params,
      model: modelSays(800_000),
    });
    const definition = invoiceWorkflow(systems);

    await expect(definition.run(engine, invoice)).rejects.toThrow(
      "Ledger went away"
    );
    params.threshold = 100_000;
    const result = await definition.run(engine, invoice);

    expect(result.status).toBe("booked");
    expect(systems.asked).toStrictEqual([]);
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
        return { amount: 400_000 };
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
      model: modelSays(400_000),
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
