import { connectorEventActions } from "@grasp-os/shared/connect";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { invoiceMail } from "../../connect/test/fixtures/graph-events.ts";
import { listenersOf } from "../src/workflows/connector-events.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphControlUrl } from "./connect-providers.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";
import { appWith } from "./workflow-apps.ts";

// Connector events end to end: a builder's App listens for new mail on
// their Microsoft 365 connection; core's cron trigger tells the real
// connect where to listen, connect reads Graph's recorded delta answers
// (the stand-in behind it, test/connect-providers.ts), and core delivers
// what it read to the workflow.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** A message arriving in `mailbox`'s inbox, at Graph. */
const receive = async (mailbox: string, message: unknown): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(graphControlUrl, {
    method: "POST",
    body: JSON.stringify({ mailbox, message }),
  });
};

/** The person's own Microsoft 365 account, connected: its ID. */
const connectOwn = async (person: Person): Promise<string> => {
  const oid = String(person.person.oid);
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, oid),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const [connection] = await person.api.connections.list();
  if (connection === undefined) {
    throw new Error("Expected the connection");
  }
  return connection.id;
};

/** The inbox workflow, on `triggers`: it returns the event it started with. */
const inbox = (
  triggers = `[{ type: "event", event: "m365.mail.received", filter: { folder: "inbox" } }]`
): Record<string, string> => ({
  "workflows/inbox.ts": `import { connectorEvent, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "inbox",
  { params: {}, input: connectorEvent, triggers: ${triggers} },
  async (step, { input }) =>
    await step.do("read", { description: "Read the mail event" }, async () => ({ id: input.id, subject: input.payload.subject }))
);
`,
  "workflows/inbox.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./inbox.ts";

const input = { id: "e", connection: "c", owner: null, action: "mail.list", type: "m365.mail.received", payload: { subject: "x" } };

export default workflowTests(definition, [{ name: "runs", input, mocks: { read: null }, expect: { output: null } }]);
`,
});

/** A builder's App listening for new mail on their own connection. */
const listening = async () => {
  const builder = await personApi("builder");
  const connection = await connectOwn(builder);
  const app = await appWith(builder, inbox());
  await requestGranted(idp, builder, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId: connection },
    actions: ["mail.list"],
    binding: "OUTLOOK",
  });
  return { builder, connection, app, mailbox: String(builder.person.oid) };
};

/** Where connect listens on `connection`: the event types. */
const sources = async (connection: string): Promise<string[]> => {
  const { results } = await connectDb()
    .prepare("SELECT type FROM event_sources WHERE connection_id = ?")
    .bind(connection)
    .all();
  return z
    .array(z.object({ type: z.string() }))
    .parse(results)
    .map(({ type }) => type);
};

/** A minute passes for connect's sources: each is due for a read. */
const aMinuteLater = async (): Promise<void> => {
  await connectDb().prepare("UPDATE event_sources SET poll_at = 0").run();
};

describe("connector events", () => {
  afterEach(endLiveRuns);

  it("start the listening workflow once for a new mail in its mailbox", async () => {
    const { builder, connection, app, mailbox } = await listening();
    await runCron();
    const mail = invoiceMail(mailbox, 7, new Date().toISOString());
    await receive(mailbox, mail);
    await aMinuteLater();
    await runCron();
    // Graph shows the message again once it's read: the same message.
    await receive(mailbox, { ...mail, isRead: true });
    await aMinuteLater();
    await runCron();
    const runs = await builder.api.workflows.list(app);

    expect(runs).toHaveLength(1);
    await finished(runs[0]?.id ?? "");
    const { output } = await builder.api.workflows.status(runs[0]?.id ?? "");

    expect(output).toStrictEqual({ id: mail.id, subject: "Invoice INV-7" });
    const events = await allEvents();

    expect(
      events
        .filter(
          ({ action, target }) =>
            action.startsWith("connection.events.") && target?.id === connection
        )
        .map(({ action, provenance }) => [action, provenance])
    ).toStrictEqual([
      ["connection.events.started", []],
      ["connection.events.read", [mail.id]],
      ["connection.events.read", [mail.id]],
    ]);
  });

  it("deliver only so many events a run, and the rest the next", async () => {
    const { builder, app, mailbox } = await listening();
    await runCron();
    await receive(mailbox, invoiceMail(mailbox, 1, new Date().toISOString()));
    await receive(mailbox, invoiceMail(mailbox, 2, new Date().toISOString()));
    await aMinuteLater();
    await runCron({ CONNECTOR_EVENTS_PER_RUN: "1" });
    const first = await builder.api.workflows.list(app);
    await runCron({ CONNECTOR_EVENTS_PER_RUN: "1" });
    const second = await builder.api.workflows.list(app);

    expect([first.length, second.length]).toStrictEqual([1, 2]);
  });

  it("stop listening once the workflow no longer listens", async () => {
    const { builder, connection, app } = await listening();
    await runCron();
    const before = await sources(connection);
    // The same workflow, started only by hand.
    await release(builder, app, inbox(`[{ type: "manual" }]`));
    await runCron();

    expect({ before, after: await sources(connection) }).toStrictEqual({
      before: ["m365.mail.received"],
      after: [],
    });
  });

  it("listen nowhere while connector events are switched off", async () => {
    const { connection } = await listening();
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    await runCron({ FEATURES: { ...on, connector_events: false } });

    await expect(sources(connection)).resolves.toStrictEqual([]);
  });

  it("find who listens by index, reading no table whole", async () => {
    await listening();
    const recorded = await recordedQueries(async () => await listenersOf(env));
    const plans = await Promise.all(
      recorded.map(async (query) => await planOf(query))
    );
    const steps = plans.flat();

    // One query per event type.
    expect(plans).toHaveLength(Object.keys(connectorEventActions).length);
    expect(steps.filter((step) => fullScan.test(step))).toStrictEqual([]);
    expect(steps.filter((step) => step.includes("TEMP B-TREE"))).toStrictEqual(
      []
    );
  });
});
