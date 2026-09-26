import { workflowTests } from "@grasp-os/sdk/testing";

import { invoiceWorkflow } from "./invoice-approval.ts";

// Every step that reaches a system is mocked, so the systems never answer.
const unreachable = async (): Promise<never> =>
  await Promise.reject(new Error("Mock the step instead"));

const invoice = {
  number: "INV-7",
  purchaseOrder: "PO-1",
  text: "Total €8,000",
};

const matched = { "match-po": { amount: 800_000 }, book: "ledger-42" };
const extracted = (total: number) => ({ total, currency: "EUR" });
const asked = {
  name: "review#ask",
  input: { from: "team:finance", reminder: false },
};
const booked = (total: number) => ({
  name: "book",
  input: { invoice: "INV-7", total },
});

export default workflowTests(
  invoiceWorkflow({
    findPurchaseOrder: unreachable,
    book: unreachable,
    askReviewer: unreachable,
  }),
  [
    {
      name: "books an invoice below the threshold without asking anyone",
      input: invoice,
      mocks: { ...matched, extract: extracted(400_000) },
      expect: {
        output: { status: "booked", entry: "ledger-42" },
        sideEffects: [booked(400_000)],
      },
    },
    {
      name: "asks the reviewer above the threshold and books once approved",
      input: invoice,
      mocks: { ...matched, extract: extracted(800_000) },
      decisions: { review: { approved: true, by: "anna" } },
      expect: {
        output: { status: "booked", entry: "ledger-42" },
        sideEffects: [asked, booked(800_000)],
      },
    },
    {
      name: "doesn't book an invoice the reviewer rejects",
      input: invoice,
      mocks: { ...matched, extract: extracted(800_000) },
      decisions: {
        review: {
          approved: false,
          by: "anna",
          payload: { comment: "Wrong PO" },
        },
      },
      expect: { output: { status: "rejected" }, sideEffects: [asked] },
    },
    {
      name: "books nothing when the purchase order system is down",
      input: invoice,
      failures: { "match-po": "Purchase order system unavailable" },
      expect: { error: "Purchase order system unavailable", sideEffects: [] },
    },
  ]
);
