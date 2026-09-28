import type { Role } from "@grasp-os/shared/roles";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { deliverConnectorEvent } from "../src/workflows/connector-events.ts";
import { outlook, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// Event triggers: connect delivers the events connections report to
// core's `ConnectorEvents` entrypoint, which starts the workflows whose
// trigger names the event, in Apps with a permission on its connection.
// Tests deliver events to the entrypoint as connect would.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * The inbox workflow, on mail received in the inbox: it returns the event
 * it started with.
 */
const inbox = (
  filter = `{ folder: "inbox" }`,
  triggers = `[{ type: "event", event: "m365.mail.received", filter: ${filter} }]`
): Record<string, string> => ({
  "workflows/inbox.ts": `import { connectorEvent, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "inbox",
  { params: {}, input: connectorEvent, triggers: ${triggers} },
  async (step, { input }) =>
    await step.do("read", { description: "Read the mail event" }, async () => ({ id: input.id, payload: input.payload }))
);
`,
  "workflows/inbox.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./inbox.ts";

const input = { id: "e", connection: "c", owner: null, action: "mail.list", type: "m365.mail.received", payload: null };

export default workflowTests(definition, [{ name: "runs", input, mocks: { read: null }, expect: { output: null } }]);
`,
});

/** A mail event on Outlook, the connection `outlook()` grants. */
const mailEvent = (
  changes: {
    id?: string;
    resource?: string;
    folder?: string;
    owner?: string;
  } = {}
) => ({
  id: changes.id ?? crypto.randomUUID(),
  connection: "connection-outlook",
  owner: changes.owner ?? null,
  ...(changes.resource === undefined ? {} : { resource: changes.resource }),
  action: "mail.list",
  type: "m365.mail.received",
  payload: { folder: changes.folder ?? "inbox", subject: "Invoice INV-7" },
});

/** Delivers `event`, as connect does. */
const deliver = async (event: unknown): Promise<{ runs: number }> =>
  await exports.ConnectorEvents.deliver(event);

/**
 * An App with the inbox workflow, granted Outlook: on `resource` when
 * given, for `actions` (listing mail by default), masking `mask`. The
 * workflow's `triggers` replace its one, on `filter`, when given.
 */
const inboxApp = async (
  builder: Person,
  {
    filter,
    triggers,
    resource,
    actions,
    mask,
  }: {
    filter?: string;
    triggers?: string;
    resource?: string;
    actions?: string[];
    mask?: string[];
  } = {}
): Promise<string> => {
  const app = await appWith(builder, inbox(filter, triggers));
  const request = outlook(app);
  await requestGranted(idp, builder, {
    ...request,
    ...(actions === undefined ? {} : { actions }),
    object: {
      ...request.object,
      ...(resource === undefined ? {} : { resource }),
      ...(mask === undefined ? {} : { mask }),
    },
  });
  return app;
};

const runsOf = async (builder: Person, app: string) =>
  await builder.api.workflows.list(app);

describe("event triggers", () => {
  afterEach(endLiveRuns);

  it("start a run with the event as input, once however often it's delivered", async () => {
    const builder = await personApi("builder");
    const app = await inboxApp(builder);
    const event = mailEvent();

    await expect(deliver(event)).resolves.toStrictEqual({ runs: 1 });
    await expect(deliver(event)).resolves.toStrictEqual({ runs: 1 });
    const runs = await runsOf(builder, app);

    expect(runs).toHaveLength(1);
    await finished(runs[0]?.id ?? "");
    const { output } = await builder.api.workflows.status(runs[0]?.id ?? "");

    expect(output).toStrictEqual({ id: event.id, payload: event.payload });
    const events = await allEvents();

    // Its key: the App and workflow, and a hash, nothing the event says.
    expect(
      events
        .filter(
          ({ action, detail }) =>
            action === "workflow.run.started" && detail.app === app
        )
        .map(({ actor, detail }) => [
          actor.type,
          detail.trigger,
          /^event:[\w-]+:inbox:[0-9a-f]{64}$/u.test(String(detail.key)),
        ])
    ).toStrictEqual([["system", "event", true]]);
  });

  it("start a workflow once for an event two of its triggers match, and count it once", async () => {
    const builder = await personApi("builder");
    const app = await inboxApp(builder, {
      triggers: `[
        { type: "event", event: "m365.mail.received", filter: { folder: "both" } },
        { type: "event", event: "m365.mail.received", filter: { folder: "both", subject: "Invoice INV-7" } },
      ]`,
    });

    await expect(deliver(mailEvent({ folder: "both" }))).resolves.toStrictEqual(
      {
        runs: 1,
      }
    );
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("start nothing for an event its filter doesn't match", async () => {
    const builder = await personApi("builder");
    const app = await inboxApp(builder);

    await expect(deliver(mailEvent({ folder: "spam" }))).resolves.toStrictEqual(
      { runs: 0 }
    );
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("reach only Apps with a permission on the event's connection, or on its part", async () => {
    const builder = await personApi("builder");
    // Declares the trigger, but may not read Outlook.
    const unpermitted = await appWith(builder, inbox());
    const bens = await inboxApp(builder, {
      filter: `{ folder: "ben" }`,
      resource: "mailbox-ben",
    });

    await deliver(mailEvent({ folder: "ben", resource: "mailbox-ann" }));

    await expect(runsOf(builder, bens)).resolves.toHaveLength(0);

    await deliver(mailEvent({ folder: "ben", resource: "mailbox-ben" }));

    await expect(runsOf(builder, bens)).resolves.toHaveLength(1);
    await expect(runsOf(builder, unpermitted)).resolves.toHaveLength(0);
  });

  it("reach no App whose current version no admin approved, as no call on the connection would", async () => {
    const builder = await personApi("builder");
    const app = await inboxApp(builder, { filter: `{ folder: "unapproved" }` });
    // Its permission stays active; its code, as for a version a builder
    // made current without an admin, isn't approved.
    await env.DB.prepare(
      "UPDATE app_versions SET approved = 0 WHERE app_id = ?"
    )
      .bind(app)
      .run();

    await expect(
      deliver(mailEvent({ folder: "unapproved" }))
    ).resolves.toStrictEqual({ runs: 0 });
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("reach only Apps whose permission allows the event's read action and masks nothing", async () => {
    const builder = await personApi("builder");
    const sender = await inboxApp(builder, {
      filter: `{ folder: "rules" }`,
      actions: ["mail.send"],
    });
    const masked = await inboxApp(builder, {
      filter: `{ folder: "rules" }`,
      mask: ["body"],
    });
    const reader = await inboxApp(builder, {
      filter: `{ folder: "rules" }`,
      actions: ["mail.send", "mail.list"],
    });

    await deliver(mailEvent({ folder: "rules" }));

    await expect(
      Promise.all(
        [sender, masked, reader].map(async (app) => {
          const runs = await runsOf(builder, app);
          return runs.length;
        })
      )
    ).resolves.toStrictEqual([0, 0, 1]);
  });

  it("reach, from a personal connection, only the Apps its owner owns", async () => {
    const ann = await personApi("builder");
    const ben = await personApi("builder");
    const anns = await inboxApp(ann, { filter: `{ folder: "personal" }` });
    const bens = await inboxApp(ben, { filter: `{ folder: "personal" }` });

    await deliver(mailEvent({ folder: "personal", owner: ann.userId }));
    await deliver(
      mailEvent({ folder: "personal", owner: crypto.randomUUID() })
    );

    await expect(
      Promise.all([
        runsOf(ann, anns).then(({ length }) => length),
        runsOf(ben, bens).then(({ length }) => length),
      ])
    ).resolves.toStrictEqual([1, 0]);
  });

  it("start the same event once across a new version of the workflow, and say what they start on in the audit log", async () => {
    const builder = await personApi("builder");
    const app = await inboxApp(builder);
    const event = mailEvent();

    await deliver(event);
    // A new version: its triggers are registered anew.
    await release(builder, app, {
      "workflows/lib/note.ts": "export const note = 2;\n",
    });
    await deliver(event);
    const events = await allEvents();

    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
    expect(
      events
        .filter(
          ({ action, target }) =>
            action === "app.version.current" && target?.id === app
        )
        .map(({ detail }) => detail.events)
    ).toStrictEqual(["m365.mail.received", "m365.mail.received"]);
  });

  it("stop once a version without the trigger is made current", async () => {
    const builder = await personApi("builder");
    const app = await inboxApp(builder);
    // The same workflow, started only by hand.
    await release(builder, app, inbox("{}", `[{ type: "manual" }]`));

    await deliver(mailEvent());

    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("refuse an event that isn't one, or while switched off", async () => {
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const off = { ...env, FEATURES: { ...on, triggers: false } };

    await expect(outcome(deliver({ id: "e", type: "x" }))).resolves.toBe(
      "workflow.invalid"
    );
    await expect(
      outcome(
        deliver({
          ...mailEvent(),
          payload: { body: "x".repeat(64 * 1024) },
        })
      )
    ).resolves.toBe("workflow.invalid");
    await expect(
      outcome(deliverConnectorEvent(off, mailEvent()))
    ).resolves.toBe("feature.disabled");
  });
});
