/**
 * The sample invoice App the workflow-on-screens tests run: invoices its
 * screen shows live, and an intake workflow the screen starts, which marks
 * the invoice received, waits for its reviewer's decision and books it
 * (or rejects it) through the App's own server, typed by its class. The
 * reviewer is a parameter, all admins until someone sets it.
 */

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string };
type Invoice = { id: string; status: string };
type Watcher = ((invoices: Invoice[]) => Promise<void>) & Disposable & { dup(): Watcher };

export class App extends DurableObject {
  #watchers = new Set<Watcher>();

  invoices(): Invoice[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    return this.ctx.storage.sql
      .exec("SELECT id, status FROM invoices ORDER BY id")
      .toArray()
      .map((row) => ({ id: String(row.id), status: String(row.status) }));
  }

  setStatus(_caller: Caller, id: string, status: string): void {
    this.invoices();
    this.ctx.storage.sql.exec(
      "INSERT INTO invoices VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status",
      id,
      status
    );
    const invoices = this.invoices();
    for (const watcher of this.#watchers) {
      void this.#send(watcher, invoices);
    }
  }

  watchInvoices(_caller: Caller, onChange: Watcher): void {
    const watcher = onChange.dup();
    this.#watchers.add(watcher);
    void this.#send(watcher, this.invoices());
  }

  async #send(watcher: Watcher, invoices: Invoice[]): Promise<void> {
    try {
      await watcher(invoices);
    } catch {
      this.#watchers.delete(watcher);
      watcher[Symbol.dispose]();
    }
  }
}
`;

const intakeCode = `import { appServer, person, workflow, z } from "@grasp-os/sdk/workflow";

import type { App } from "../app/server.ts";

export default workflow(
  "invoice-intake",
  {
    params: { reviewer: person({ label: "Reviewer", default: "role:admin" }) },
    input: z.object({ invoice: z.string() }),
  },
  async (step, { input, params, env }) => {
    const app = appServer<App>(env);
    await step.do("receive", { description: "Mark the invoice received", input: input.invoice }, async ({ input: invoice }) => {
      await app.setStatus(invoice, "received");
    });
    const review = await step.decision("review", {
      description: \`Approve \${input.invoice}\`,
      from: params.reviewer,
      ask: async () => {},
      timeout: "7 days",
    });
    const status = !review.timedOut && review.approved ? "booked" : "rejected";
    await step.do(
      "book",
      { description: "Book the invoice", sideEffect: true, input: { invoice: input.invoice, status } },
      async ({ input: booking }) => {
        await app.setStatus(booking.invoice, booking.status);
      }
    );
    return { status };
  }
);
`;

const intakeTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import intake from "./invoice-intake.ts";

export default workflowTests(intake, [
  {
    name: "books an invoice the reviewer approves",
    input: { invoice: "INV-7" },
    mocks: { receive: null },
    decisions: { review: { approved: true, by: "anna" } },
    expect: { output: { status: "booked" } },
  },
]);
`;

const screenCode = `import { useLive, useWorkflow } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

type Invoice = { id: string; status: string };

export default function Intake() {
  const invoices = useLive<Invoice[]>("watchInvoices", []);
  const intake = useWorkflow("invoice-intake");
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-medium">Invoices</h1>
      <Button onClick={() => void intake.start({ invoice: "INV-7" })}>Start intake</Button>
      <ul aria-label="Invoices">
        {invoices.map((invoice) => (
          <li key={invoice.id}>{\`\${invoice.id}: \${invoice.status}\`}</li>
        ))}
      </ul>
      <ul aria-label="Runs">
        {intake.runs.map((run) => (
          <li key={run.id} className="flex items-center gap-2">
            <span>{run.status}</span>
            {run.waitingFor.map((decision) => (
              <Button
                key={decision.name}
                onClick={() => void intake.decide(run.id, decision.name, { approved: true })}
                variant="outline"
              >
                {\`Approve \${decision.name}\`}
              </Button>
            ))}
          </li>
        ))}
      </ul>
    </main>
  );
}
`;

/** The App's files. */
export const invoiceAppFiles: Record<string, string> = {
  "app/server.ts": serverCode,
  "workflows/invoice-intake.ts": intakeCode,
  "workflows/invoice-intake.workflow-tests.ts": intakeTests,
  "screens/intake.tsx": screenCode,
};
