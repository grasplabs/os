/**
 * Apps and workflows for the tests of workflow runs, shared by the files
 * they are split across: one file holds only so many runs' worth of
 * workers.
 */
import { expect, vi } from "vite-plus/test";

import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import type { Idp } from "./idp.ts";

/** Someone signed in, with their API. */
type Builder = Parameters<typeof release>[0];

/**
 * The sample App's server code: purchase orders, a ledger that books each
 * entry once per idempotency key, and counters that show how often a step
 * really ran.
 */
export const server = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; idempotencyKey?: string };

export class App extends DurableObject {
  hit(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO hits VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET count = count + 1", name);
    return this.hits(_caller, name);
  }

  hits(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    const [row] = this.ctx.storage.sql.exec("SELECT count FROM hits WHERE name = ?", name).toArray();
    return Number(row?.count ?? 0);
  }

  purchaseOrder(_caller: Caller, number: string): { amount: number } | null {
    return number === "PO-1" ? { amount: 800_000 } : null;
  }

  book(caller: Caller, entry: { invoice: string; total: number }, key: string): string {
    this.hit(caller, "book:" + key);
    return "ledger-" + entry.invoice + "-for-" + caller.userId;
  }

  // Mails the invoice with the caller's key, or with a key of its own.
  async mail(caller: Caller, ownKey: boolean): Promise<unknown> {
    const idempotencyKey = ownKey ? crypto.randomUUID() : caller.idempotencyKey;
    try {
      const { output } = await (this.env as any).MAIL.call(
        caller,
        "mail.send",
        { to: "ben@acme.test", subject: "Invoice INV-7" },
        { idempotencyKey }
      );
      return JSON.parse(output);
    } catch (error) {
      return { refused: (error as { code?: string }).code };
    }
  }
}
`;

/**
 * A workflow of the given steps' code, run as `id`, with a test that
 * mocks every step it names, so any workflow passes activation.
 */
export const workflowFiles = (
  id: string,
  body: string,
  mocks: Record<string, unknown> = {}
): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("${id}", { params: {}, input: z.unknown() }, async (step, { env, state, input }) => {
${body}
});
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: ${JSON.stringify(mocks)}, events: [{ type: "go", payload: null }], expect: {} },
]);
`,
});

/** A new App with the sample server and `files`. */
export const appWith = async (
  builder: Builder,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, { "app/server.ts": server, ...files });
  return id;
};

/**
 * A run's audit events, once the log has `last` of them, each as its
 * action and what it says of the step, the reason and the error, sorted.
 */
export const runEvents = async (run: string, last: string): Promise<string[]> =>
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      const ofRun = events.filter(({ target }) => target?.id === run);
      expect(ofRun.map(({ action }) => action)).toContain(last);
      return ofRun
        .map(({ action, detail }) =>
          [action, detail.reason, detail.feature, detail.step, detail.error]
            .filter((part) => part !== undefined)
            .join(" ")
        )
        .toSorted();
    },
    { timeout: 10_000, interval: 100 }
  );

/** Gives the App `MAIL`, for sending on the connection; an admin grants it. */
export const grantMail = async (
  idp: Idp,
  requester: Builder,
  app: string,
  connectionId: string
): Promise<void> => {
  await requestGranted(idp, requester, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId },
    actions: ["mail.send"],
    binding: "MAIL",
  });
};

/** The mail each test's workflow sends. */
export const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/**
 * A workflow `mailer` that sends the invoice mail in its side-effect step
 * `send`, with the step's idempotency key, with the step's `options`; then
 * runs `after` in the step, with the connector's answer as `sent`.
 */
export const mailer = (options: string, after = "") =>
  workflowFiles(
    "mailer",
    `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, ${options} },
    async ({ idempotencyKey, input: mail }) => {
      const sent = JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
${after}
      return sent;
    }
  );`,
    { send: { messageId: "mocked" } }
  );
