import { model, money, person, workflow, z } from "@grasp-os/sdk/workflow";
import type { DecisionRequest } from "@grasp-os/sdk/workflow";

/**
 * The outside systems the sample invoice workflow talks to. Connectors aren't
 * part of the SDK yet, so the sample takes them as arguments and tests stand
 * them in.
 */
export interface InvoiceSystems {
  findPurchaseOrder: (number: string) => Promise<{ amount: number } | null>;
  book: (
    entry: { invoice: string; total: number },
    idempotencyKey: string
  ) => Promise<string>;
  askReviewer: (request: DecisionRequest) => Promise<void>;
}

export const extractionSchema = z.object({
  total: z.number(),
  currency: z.string(),
});

/**
 * Matches an incoming invoice to its purchase order, reads the total with a
 * model, asks a person to approve large invoices and books the invoice.
 */
export const invoiceWorkflow = (systems: InvoiceSystems) =>
  workflow(
    "invoice-approval",
    {
      input: z.object({
        number: z.string(),
        purchaseOrder: z.string(),
        text: z.string(),
      }),
      params: {
        threshold: money({
          label: "Review invoices above",
          default: 5000,
          sensitive: true,
        }),
        reviewer: person({ label: "Reviewer", default: "finance-team" }),
        extractionModel: model({
          label: "Extraction model",
          default: "mistral-large",
          sensitive: true,
        }),
      },
      triggers: [{ type: "event", event: "invoice.received" }],
    },
    async (step, { input, params }) => {
      const order = await step.do(
        "match-po",
        {
          description: "Find the purchase order the invoice refers to",
          locked: true,
        },
        async () => await systems.findPurchaseOrder(input.purchaseOrder)
      );
      if (!order) {
        return { status: "unmatched" } as const;
      }

      const extracted = await step.llm("extract", {
        description: "Read the total and currency from the invoice",
        model: params.extractionModel,
        instructions:
          "Read the invoice's total amount and its ISO 4217 currency code.",
        input: input.text,
        schema: extractionSchema,
        retries: 2,
      });

      if (extracted.total > params.threshold) {
        const decision = await step.decision("review", {
          description: "Ask the reviewer to approve invoices above the limit",
          from: params.reviewer,
          ask: systems.askReviewer,
          timeout: "7 days",
          remindAfter: "2 days",
        });
        if (decision.outcome !== "approved") {
          return { status: decision.outcome };
        }
      }

      const entry = await step.do(
        "book",
        {
          description: "Book the invoice in the ledger",
          sideEffect: true,
          locked: true,
          input: { invoice: input.number, total: extracted.total },
        },
        async ({ idempotencyKey, input: booking }) =>
          await systems.book(booking, idempotencyKey)
      );
      return { status: "booked", entry } as const;
    }
  );
