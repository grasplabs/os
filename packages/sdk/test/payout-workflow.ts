import { money, workflow, z } from "@grasp-os/sdk/workflow";

const payoutSchema = z.object({
  id: z.string(),
  supplier: z.string(),
  amount: z.number(),
});

/** Pays a batch of suppliers, one payment step per payout. */
export const payoutWorkflow = (
  pay: (
    payout: z.infer<typeof payoutSchema>,
    idempotencyKey: string
  ) => Promise<string>
) =>
  workflow(
    "supplier-payouts",
    {
      input: z.object({ payouts: z.array(payoutSchema) }),
      params: {
        limit: money({
          label: "Pay at most",
          currency: "EUR",
          default: 10_000,
        }),
      },
    },
    async (step, { input, params }) => {
      const paid: string[] = [];
      for (const payout of input.payouts) {
        if (payout.amount <= params.limit) {
          paid.push(
            // Payouts run one after another, each its own durable step.
            // oxlint-disable-next-line no-await-in-loop
            await step.do(
              "pay",
              {
                key: payout.id,
                description: "Pay the supplier",
                sideEffect: true,
                input: payout,
              },
              async ({ idempotencyKey, input: payment }) =>
                await pay(payment, idempotencyKey)
            )
          );
        }
      }
      return paid;
    }
  );
