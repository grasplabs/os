import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { setCurrentVersion } from "../src/apps.ts";
import worker from "../src/index.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// Email triggers: Email Routing hands core's email handler each message
// for the deployment's domain, which starts the workflow that receives
// mail at its address, with the message as input. Tests deliver messages
// to the handler as Email Routing does.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * The invoice intake workflow, receiving mail at `address`: it returns
 * what it read of the message it started with.
 */
const intake = (
  address = "invoices",
  id = "intake"
): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "${id}",
  { params: {}, input: emailMessage, triggers: [{ type: "email", address: "${address}" }] },
  async (step, { input }) =>
    await step.do("read", { description: "Read the invoice mail" }, async () => ({
      id: input.id,
      from: input.from.address,
      to: input.to.length,
      subject: input.subject,
      text: input.text,
      last: [...input.text].at(-1) ?? "",
      truncated: input.truncated,
      attachments: input.attachments.map(({ filename, size }) => filename + ":" + size),
      size: JSON.stringify(input).length,
    }))
);
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

const input = { id: "m", from: { name: "", address: "a@b.test" }, to: [], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [] };

export default workflowTests(definition, [{ name: "runs", input, mocks: { read: null }, expect: { output: null } }]);
`,
});

/**
 * A message from Ben, with an attachment, as it goes over the wire: with a
 * Message-ID and a Received header when given, and `to`, the subject, the
 * attachment's name and the text as given.
 */
const invoiceMail = ({
  subject = "Invoice INV-7",
  messageId,
  receivedBy,
  to = "invoices@grasp.test",
  filename = "inv-7.pdf",
  text = "Please pay by Friday.",
}: {
  subject?: string;
  messageId?: string;
  receivedBy?: string;
  to?: string;
  filename?: string;
  text?: string;
} = {}): string =>
  [
    ...(receivedBy === undefined
      ? []
      : [`Received: from ${receivedBy}; Mon, 28 Sep 2026 08:00:01 +0000`]),
    ...(messageId === undefined ? [] : [`Message-ID: <${messageId}>`]),
    "From: Ben <ben@acme.test>",
    `To: ${to}`,
    `Subject: ${subject}`,
    "Date: Mon, 28 Sep 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "--b",
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0=",
    "--b--",
    "",
  ].join("\r\n");

/** An HTML-only message to `unclosed@`, with `subject` and `body`. */
const unclosed = (subject: string, body: string): string =>
  [
    "From: Ben <ben@acme.test>",
    "To: unclosed@grasp.test",
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");

/** A message of multiparts nested `depth` deep. */
const nestedMail = (depth: number): string =>
  [
    "From: Ben <ben@acme.test>",
    "To: invoices@grasp.test",
    "Subject: Nested",
    "MIME-Version: 1.0",
    ...Array.from({ length: depth }, (_, level) => [
      `Content-Type: multipart/mixed; boundary="b${level}"`,
      "",
      `--b${level}`,
    ]).flat(),
    "Content-Type: text/plain",
    "",
    "Deep.",
    "",
  ].join("\r\n");

/** What became of a delivery: the reason it was rejected with, if it was. */
interface Delivery {
  rejected: string | undefined;
}

/**
 * Delivers `raw` to `to`, as Email Routing does, on an env with `changes`;
 * `rawSize` is the size the message says it is.
 */
const deliver = async (
  to: string,
  raw: string,
  { changes = {}, rawSize }: { changes?: Partial<Env>; rawSize?: number } = {}
): Promise<Delivery> => {
  const bytes = new TextEncoder().encode(raw);
  const delivery: Delivery = { rejected: undefined };
  const message: ForwardableEmailMessage = {
    from: "bounces@acme.test",
    to,
    raw: new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers(),
    rawSize: rawSize ?? bytes.byteLength,
    setReject: (reason) => {
      delivery.rejected = reason;
    },
    forward: async () =>
      await Promise.reject(new Error("Core never forwards mail")),
    reply: async () =>
      await Promise.reject(new Error("Core never replies to mail")),
  };
  await worker.email(message, { ...env, ...changes });
  return delivery;
};

/** The App's runs, as its builder sees them. */
const runsOf = async (builder: Person, app: string) =>
  await builder.api.workflows.list(app);

const outputSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.number(),
  subject: z.string(),
  text: z.string(),
  last: z.string(),
  truncated: z.boolean(),
  attachments: z.array(z.string()),
  size: z.number(),
});

/**
 * A message's key in the audit log: the App and workflow, and a hash,
 * nothing the message says.
 */
const messageKey = /^email:[\w-]+:intake:[0-9a-f]{64}$/u;

/** What each of the App's runs read of the message it started with. */
const readByRuns = async (builder: Person, app: string) => {
  const runs = await runsOf(builder, app);
  return await Promise.all(
    runs.map(async ({ id }) => {
      await finished(id);
      const { output } = await builder.api.workflows.status(id);
      return outputSchema.parse(output);
    })
  );
};

/** What the App's only run read of the message it started with. */
const readByRun = async (builder: Person, app: string) => {
  const [read] = await readByRuns(builder, app);
  if (!read) {
    throw new Error(`App ${app} has no run`);
  }
  return read;
};

/** Every object in R2, as its key and when it was stored. */
const storedObjects = async (): Promise<string[]> => {
  const listed = await env.FILES.list({ limit: 1000 });
  return listed.objects.map(
    ({ key, uploaded }) => `${key}@${uploaded.toISOString()}`
  );
};

describe("email triggers", () => {
  afterEach(endLiveRuns);

  it("start a run with the message as input, and store nothing of it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake());
    const before = await storedObjects();

    const delivery = await deliver("Invoices@grasp.test", invoiceMail());
    const { id, ...read } = await readByRun(builder, app);

    expect(delivery.rejected).toBeUndefined();
    expect(id).toMatch(/^[0-9a-f]{64}$/u);
    expect(read).toMatchObject({
      from: "ben@acme.test",
      subject: "Invoice INV-7",
      text: "Please pay by Friday.\n",
      truncated: false,
      attachments: ["inv-7.pdf:5"],
    });
    // Nothing added to R2, nothing replaced: the message went nowhere.
    await expect(storedObjects()).resolves.toStrictEqual(before);
  });

  it("start the same message once across a new version of the workflow", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("again"));
    const to = "again@grasp.test";
    const mail = invoiceMail({
      to,
      messageId: `${crypto.randomUUID()}@acme.test`,
    });

    await deliver(to, mail);
    // A new version: its triggers are registered anew.
    await release(builder, app, {
      "workflows/lib/note.ts": "export const note = 2;\n",
    });
    await deliver(to, mail);

    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("pass the text of a message that has only HTML", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("html"));
    const html = [
      "From: Ben <ben@acme.test>",
      "To: html@grasp.test",
      "Subject: HTML",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><body><p>Pay <b>INV-7</b> &amp; thanks</p><script>steal()</script><p>Ben</p></body></html>",
      "",
    ].join("\r\n");

    await deliver("html@grasp.test", html);

    await expect(readByRun(builder, app)).resolves.toMatchObject({
      text: "Pay INV-7 & thanks\nBen",
    });
  });

  it("read the text of HTML that never closes its tags in time that grows with its length alone", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("unclosed"));
    // Scripts and tags opened and never closed, over 2 MB each: a scan
    // from each to the end, as a lazy pattern does, takes over a minute
    // here; one pass, a few milliseconds.
    const startedAt = performance.now();
    await deliver(
      "unclosed@grasp.test",
      unclosed("scripts", `<p>Pay INV-7</p>${"<script".repeat(300_000)}`)
    );
    await deliver(
      "unclosed@grasp.test",
      unclosed("tags", `<p>Pay INV-7</p>${"<a <b".repeat(500_000)}`)
    );
    const took = performance.now() - startedAt;
    const reads = await readByRuns(builder, app);

    expect(took).toBeLessThan(5000);
    expect(
      Object.fromEntries(
        reads.map(({ subject, text }) => [subject, text.slice(0, 20)])
      )
    ).toStrictEqual({
      // A script that never ends ends the text.
      scripts: "Pay INV-7",
      // A tag that never closes is text, as far as it fits.
      tags: "Pay INV-7\n<a <b<a <b",
    });
  });

  it("start a message's run when delivered again after its start failed, once", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("retried"));
    const mail = invoiceMail({
      to: "retried@grasp.test",
      messageId: `${crypto.randomUUID()}@acme.test`,
    });
    // An ID core's record takes but Workflows refuses (over 100
    // characters), so creating the run fails after its row is written.
    const unstartable: ReturnType<typeof crypto.randomUUID> =
      `run-${"x".repeat(100)}-${crypto.randomUUID()}`;
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(unstartable);
    let first: string;
    try {
      first = await outcome(deliver("retried@grasp.test", mail));
    } finally {
      uuid.mockRestore();
    }

    const again = await outcome(deliver("retried@grasp.test", mail));
    const third = await outcome(deliver("retried@grasp.test", mail));
    const started = await runsOf(builder, app);
    await Promise.all(
      started
        .filter(({ id }) => id !== unstartable)
        .map(async ({ id }) => {
          await finished(id);
        })
    );
    const runs = await runsOf(builder, app);

    expect({
      first: first === "ok",
      again,
      third,
      runs: runs
        .map(
          ({ id, status }) =>
            `${id === unstartable ? "failed start" : "new"}: ${status}`
        )
        .toSorted(),
    }).toStrictEqual({
      first: false,
      again: "ok",
      third: "ok",
      runs: ["failed start: failed", "new: completed"],
    });
  });

  it("keep a < that starts no tag as text", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("math"));
    const html = [
      "From: Ben <ben@acme.test>",
      "To: math@grasp.test",
      "Subject: Math",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<!DOCTYPE html><p>5 < 10 and 10 > 5</p><p>x <3 y</p>",
      "",
    ].join("\r\n");

    await deliver("math@grasp.test", html);

    await expect(readByRun(builder, app)).resolves.toMatchObject({
      text: "5 < 10 and 10 > 5\nx <3 y",
    });
  });

  it("stop a workflow going over its hourly limit, start the others, and start each run once when the mail comes again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...intake("busy"),
      ...intake("busy", "tally"),
    });
    // The hour's runs from mail, as recorded: `intake` at its 60, `tally`
    // one short, so this message's run is `tally`'s 60th.
    const now = Date.now();
    const hours = [
      ...Array.from({ length: 60 }, (_, index) => ({
        workflow: "intake",
        index,
      })),
      ...Array.from({ length: 59 }, (_, index) => ({
        workflow: "tally",
        index,
      })),
    ].map((run) => ({ ...run, id: crypto.randomUUID() }));
    const seeded = new Set(hours.map(({ id }) => id));
    await env.DB.batch(
      hours.map(({ id, workflow, index }) =>
        env.DB.prepare(
          "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, trigger_key) VALUES (?, ?, ?, 1, NULL, 'completed', ?, ?, ?)"
        ).bind(
          id,
          app,
          workflow,
          now - index * 1000,
          now,
          `email:${app}:${workflow}:${index}`
        )
      )
    );
    const mail = invoiceMail({
      to: "busy@grasp.test",
      messageId: `${crypto.randomUUID()}@acme.test`,
    });
    const started = async () => {
      const runs = await runsOf(builder, app);
      return runs
        .filter(({ id }) => !seeded.has(id))
        .map(({ workflow }) => workflow)
        .toSorted();
    };

    const first = await outcome(deliver("busy@grasp.test", mail));
    const whileCapped = await started();
    // The hour moves on for `intake`; `tally` is at its 60 now, one of
    // them this message's. The sender tries again.
    await env.DB.prepare(
      "UPDATE workflow_runs SET created_at = ? WHERE app_id = ? AND workflow_id = 'intake'"
    )
      .bind(now - 2 * 60 * 60 * 1000, app)
      .run();
    const again = await outcome(deliver("busy@grasp.test", mail));

    expect({
      first: first.includes("over a workflow's hourly limit"),
      whileCapped,
      again,
      afterwards: await started(),
    }).toStrictEqual({
      first: true,
      whileCapped: ["tally"],
      again: "ok",
      afterwards: ["intake", "tally"],
    });
  });

  it("cut text of characters UTF-16 splits in two on a character's edge, to fit", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("emoji"));
    const to = "emoji@grasp.test";
    // Quotes JSON escapes and characters UTF-16 splits in two, shifted by
    // up to five: whatever the size of the rest of the input, at least one
    // of these first cuts falls between the halves of a character, and
    // still fits.
    const texts = Array.from(
      { length: 6 },
      (_, shift) => `${"a".repeat(shift)}${'"😀'.repeat(60_000)}`
    );

    for (const [shift, text] of texts.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
      await deliver(to, invoiceMail({ to, subject: `shift ${shift}`, text }));
    }
    const reads = await readByRuns(builder, app);

    expect(
      reads.map(({ last, truncated, size }) => ({
        whole: last === "😀" || last === '"',
        truncated,
        fits: size <= 128 * 1024,
      }))
    ).toStrictEqual(
      texts.map(() => ({ whole: true, truncated: true, fits: true }))
    );
  });

  it("start one run for a message delivered again, by its Message-ID or else its bytes", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("twice"));
    const messageId = `${crypto.randomUUID()}@acme.test`;
    const to = "twice@grasp.test";

    // Redelivered through another server: new Received header, same ID.
    await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx1" }));
    await deliver(to, invoiceMail({ to, messageId, receivedBy: "mx2" }));
    // Without a Message-ID, the same bytes are the same message.
    await deliver(to, invoiceMail({ to, subject: "INV-8" }));
    await deliver(to, invoiceMail({ to, subject: "INV-8" }));
    await deliver(to, invoiceMail({ to, subject: "INV-9" }));
    // An empty Message-ID names no message: two messages with it are two.
    await deliver(to, invoiceMail({ to, subject: "INV-10", messageId: "" }));
    await deliver(to, invoiceMail({ to, subject: "INV-11", messageId: "" }));

    await expect(runsOf(builder, app)).resolves.toHaveLength(5);
    const events = await allEvents();

    expect(
      events
        .filter(
          ({ action, detail }) =>
            action === "workflow.run.started" && detail.app === app
        )
        .map(({ actor, detail }) => [
          actor.type,
          detail.trigger,
          messageKey.test(String(detail.key)),
        ])
    ).toStrictEqual(Array.from({ length: 5 }, () => ["system", "email", true]));
  });

  it("bounce mail to an address nobody receives at, and fail it for now while switched off", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("switched"));
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const mail = invoiceMail({ to: "switched@grasp.test" });

    const unknown = await deliver("nobody@grasp.test", mail);

    expect(unknown.rejected).toBe("No such address.");
    await expect(
      outcome(
        deliver("switched@grasp.test", mail, {
          changes: { FEATURES: { ...on, triggers: false } },
        })
      )
    ).resolves.toMatch(/switched off: try again later/u);
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("bounce a message that can't be read, such as one nested too deep", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("nested"));

    const delivery = await deliver("nested@grasp.test", nestedMail(300));

    expect(delivery.rejected).toBe("The message can't be read.");
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("fit a hostile message into a run's input", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("hostile"));
    const to = Array.from(
      { length: 500 },
      (_, index) => `"${"N".repeat(300)}" <r${index}@acme.test>`
    ).join(", ");

    await deliver(
      "hostile@grasp.test",
      invoiceMail({
        to,
        subject: "S".repeat(5000),
        filename: `${"f".repeat(1000)}.pdf`,
        // Quotes and backslashes take two characters each in JSON.
        text: '"\\'.repeat(200_000),
      })
    );
    const read = await readByRun(builder, app);

    expect({
      to: read.to,
      subject: read.subject.length,
      attachment: read.attachments[0]?.split(":")[0]?.length,
      truncated: read.truncated,
      fits: read.size <= 128 * 1024,
    }).toStrictEqual({
      to: 100,
      subject: 1000,
      attachment: 256,
      truncated: true,
      fits: true,
    });
  });

  it("bounce a message over 10 MiB, whatever size it says it is", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("large"));
    const large = `${invoiceMail()}${"x".repeat(10 * 1024 * 1024)}`;

    const delivery = await deliver("large@grasp.test", large, { rawSize: 1 });

    expect(delivery.rejected).toBe("The message is too large.");
    await expect(runsOf(builder, app)).resolves.toHaveLength(0);
  });

  it("say in the audit log which addresses a version receives mail at", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("audited"));
    const events = await allEvents();

    expect(
      events.filter(
        ({ action, target }) =>
          action === "app.version.current" && target?.id === app
      )
    ).toMatchObject([
      { detail: { schedules: 0, emails: "audited", events: "" } },
    ]);
  });

  it("go to one App: another can't take an address that's taken", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("taken"));
    const { id: other } = await builder.api.apps.create({ name: "Other" });

    await expect(
      outcome(release(builder, other, intake("taken")))
    ).resolves.toBe("workflow.email_taken");
    // The App that has it keeps it in its next version.
    await expect(
      outcome(
        release(builder, app, {
          "workflows/lib/note.ts": "export const note = 1;\n",
        })
      )
    ).resolves.toBe("ok");
    await deliver("taken@grasp.test", invoiceMail());
    await expect(runsOf(builder, app)).resolves.toHaveLength(1);
  });

  it("go to one App even when two take an address at once", async () => {
    const builder = await personApi("builder");
    const first = await appWith(builder, intake("inbox"));
    const { id: second } = await builder.api.apps.create({ name: "Second" });
    await builder.api.apps.files.write(second, intake("raced"));
    const { version } = await builder.api.apps.files.commit(second, "Raced");
    // The first App takes the address just before the second's batch
    // lands: after the second checked it was free.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare(
            "UPDATE workflow_triggers SET address = 'raced' WHERE app_id = ?"
          )
          .bind(first)
          .run()
    );

    const refused = await outcome(
      setCurrentVersion(
        { ...env, DB: racing },
        await builder.api.whoami(),
        second,
        version
      )
    );
    const { results } = await env.DB.prepare(
      "SELECT app_id FROM workflow_triggers WHERE address = 'raced'"
    ).all<{ app_id: string }>();

    expect({
      refused,
      receivers: results.map(({ app_id }) => app_id),
    }).toStrictEqual({
      refused: "app.conflict",
      receivers: [first],
    });
  });
});
