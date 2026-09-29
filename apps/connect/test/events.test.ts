import type { EventListener } from "@grasp-os/shared/connect";
import { connectionIdSchema } from "@grasp-os/shared/ids";
import { env, exports } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import {
  maxDeliveryAttempts,
  outboxMax,
  pollIntervalMs,
  refusedLimit,
} from "../src/events.ts";
import { accessTokenFor } from "../src/tokens.ts";
import {
  addConnection,
  auditEvents,
  connectAccount,
  outcome,
  ownAccount,
  someone,
} from "./connect.ts";
import {
  createdFile,
  createdFolder,
  deletedItem,
  invoiceMail,
  itemId,
  removedMail,
} from "./fixtures/graph-events.ts";
import { financeDrive, invoices, messageId } from "./fixtures/graph.ts";
import { graphEventsFake } from "./graph-events-fake.ts";
import type { GraphEventsFake } from "./graph-events-fake.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// Connector events, as core's cron trigger drives them: it sends who
// listens where, connect listens exactly there, reads what changed from
// Graph's recorded delta answers with the connection's token, and keeps
// the events in its outbox until core settles them. Where it listens is
// only ever what a listener's permission covers.

const providers = fakeProviders();
let graph: GraphEventsFake = graphEventsFake();
/** Answers the next Graph request instead of the fake, when set. */
let instead: (() => Response) | undefined;
/** Drives Graph fails every request for. */
const failingDrives = new Set<string>();
const internet = fakeInternet((request, url) => {
  const answer = instead;
  if (answer !== undefined) {
    instead = undefined;
    return answer();
  }
  if (
    [...failingDrives].some((drive) =>
      decodeURIComponent(url.pathname).includes(`/drives/${drive}/`)
    )
  ) {
    return Response.json(
      { error: { code: "ServiceNotAvailable" } },
      { status: 500 }
    );
  }
  return url.hostname === "graph.microsoft.com"
    ? graph.answer(request, url)
    : new Response("Taken");
});
const audit = auditEvents();

/** A minute (or `ms`) passes. */
const later = (ms = pollIntervalMs): void => {
  vi.setSystemTime(Date.now() + ms);
};

/** Someone's Microsoft 365 connection: its ID, its owner and their account. */
const connected = async () => {
  const person = someone();
  const account = ownAccount(person);
  const id = connectionIdSchema.parse(
    await connectAccount(providers, person, account)
  );
  return { id, person, oid: account.subject };
};

type Connected = Awaited<ReturnType<typeof connected>>;

/** An App of `connection`'s owner listening for new mail on all of it. */
const listener = (
  { id, person }: Connected,
  changes: Partial<EventListener> = {}
): EventListener => ({
  type: "m365.mail.received",
  connection: id,
  resource: null,
  owner: person.userId,
  ...changes,
});

const sync = async (listeners: EventListener[]): Promise<void> => {
  await exports.default.syncEventSources(listeners);
};

const sourcesSchema = z.array(
  z.object({
    type: z.string(),
    resource: z.string(),
    cursor: z.string().nullable(),
    failures: z.number(),
    poll_at: z.number(),
  })
);

/** Where connect listens. */
const sources = async () => {
  const { results } = await env.DB.prepare(
    "SELECT type, resource, cursor, failures, poll_at FROM event_sources ORDER BY rowid"
  ).all();
  return sourcesSchema.parse(results);
};

/** The events waiting in the outbox, oldest first. */
const outboxed = async (): Promise<Record<string, unknown>[]> => {
  const { results } = await env.DB.prepare(
    "SELECT event FROM connector_events ORDER BY rowid"
  ).all<{ event: string }>();
  return results.map(({ event }) =>
    z.record(z.string(), z.unknown()).parse(JSON.parse(event))
  );
};

/** The paths Graph was asked for. */
const graphPaths = (): string[] =>
  internet.sent
    .filter(({ host }) => host === "graph.microsoft.com")
    .map(({ path }) => decodeURIComponent(path));

const now = (): string => new Date().toISOString();

/** The audit events of listening and reading, in the order recorded. */
const listening = async () => {
  const events = await audit.events();
  return events
    .filter(({ action }) => action.startsWith("connection.events."))
    .map(({ action, actor, target, detail, provenance }) => ({
      action,
      actor: actor.type,
      target: target?.id,
      detail,
      provenance,
    }));
};

/** `count` events of `connection` in the outbox, waiting for core. */
const fillOutbox = async (connection: string, count: number) => {
  await env.DB.prepare(
    "INSERT INTO connector_events (id, key, connection_id, event, retry_at, created_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT 'filler-' || i, 'filler-' || i, ?, '{}', 0, 0 FROM n"
  )
    .bind(count, connection)
    .run();
};

const heldCount = async (): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS held FROM connector_events"
  ).first<{ held: number }>();
  return row?.held ?? 0;
};

const eventIdsOf = (taken: { event: string }[]): string[] =>
  taken.map(
    ({ event }) => z.object({ id: z.string() }).parse(JSON.parse(event)).id
  );

describe("connector events", () => {
  beforeEach(async () => {
    graph = graphEventsFake();
    instead = undefined;
    failingDrives.clear();
    vi.useFakeTimers({ toFake: ["Date"] });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event_sources"),
      env.DB.prepare("DELETE FROM connector_events"),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listen where a listener's permission covers, and read new mail into the outbox once", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    const token = await accessTokenFor(env, outlook.id);
    const mail = invoiceMail(outlook.oid, 1, now());
    graph.receive(outlook.oid, mail);
    later();
    await sync([listener(outlook)]);
    later();
    await sync([listener(outlook)]);

    // The account's own mailbox, by its object ID, with its token, each
    // read going on from where the last one ended.
    expect({
      paths: graphPaths(),
      tokens: internet.sent.map(({ headers }) => headers.authorization),
    }).toStrictEqual({
      paths: [
        expect.stringMatching(
          new RegExp(
            `^/v1\\.0/users/${outlook.oid}/mailFolders/inbox/messages/delta\\?.*receivedDateTime ge `,
            "u"
          )
        ),
        expect.stringContaining("$deltatoken=0"),
        expect.stringContaining("$deltatoken=1"),
      ],
      tokens: [`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`],
    });
    await expect(outboxed()).resolves.toStrictEqual([
      {
        id: mail.id,
        connection: outlook.id,
        owner: outlook.person.userId,
        action: "mail.list",
        type: "m365.mail.received",
        payload: {
          mailbox: outlook.oid,
          id: mail.id,
          folder: "inbox",
          subject: "Invoice INV-1",
          from: {
            name: "Northwind Billing",
            address: "billing@northwind.example.com",
          },
          receivedAt: mail.receivedDateTime,
          hasAttachments: true,
          conversationId: mail.conversationId,
          internetMessageId: mail.internetMessageId,
          webLink: mail.webLink,
        },
      },
    ]);
    await expect(listening()).resolves.toStrictEqual([
      {
        action: "connection.events.started",
        actor: "system",
        target: outlook.id,
        detail: { type: "m365.mail.received" },
        provenance: [],
      },
      {
        action: "connection.events.read",
        actor: "system",
        target: outlook.id,
        detail: { type: "m365.mail.received", count: 1 },
        provenance: [mail.id],
      },
    ]);
  });

  it("report only mail that arrived in the inbox after they started", async () => {
    const outlook = await connected();
    graph.receive(
      outlook.oid,
      invoiceMail(outlook.oid, 1, new Date(Date.now() - 1000).toISOString())
    );
    await sync([listener(outlook)]);
    later();
    const fresh = invoiceMail(outlook.oid, 2, now());
    // An old message moved into the inbox, one removed, then a new one.
    graph.receive(
      outlook.oid,
      invoiceMail(outlook.oid, 3, "2026-01-05T09:00:00Z")
    );
    graph.receive(outlook.oid, removedMail(outlook.oid, 4));
    graph.receive(outlook.oid, fresh);
    await sync([listener(outlook)]);
    const events = await outboxed();

    expect(events.map(({ id }) => id)).toStrictEqual([fresh.id]);
  });

  it("listen on a mailbox a permission names, and only there", async () => {
    const outlook = await connected();
    await sync([listener(outlook, { resource: invoices })]);
    const mail = invoiceMail(invoices, 1, now());
    graph.receive(invoices, mail);
    graph.receive(outlook.oid, invoiceMail(outlook.oid, 2, now()));
    later();
    await sync([listener(outlook, { resource: invoices })]);

    expect(graphPaths()).toStrictEqual([
      expect.stringMatching(
        /^\/v1\.0\/users\/invoices@example\.com\/mailFolders\/inbox\/messages\/delta\?/u
      ),
      expect.stringMatching(
        /^\/v1\.0\/users\/invoices@example\.com\/mailFolders\('inbox'\)\/messages\/delta\?/u
      ),
    ]);
    await expect(outboxed()).resolves.toMatchObject([
      {
        id: mail.id,
        resource: invoices,
        payload: { mailbox: invoices, id: mail.id },
      },
    ]);
  });

  it("listen nowhere a listener's permission doesn't cover", async () => {
    const outlook = await connected();
    const composio = connectionIdSchema.parse(await addConnection());
    const gone = await connected();
    await exports.default.disconnect({
      person: gone.person,
      connectionId: gone.id,
    });
    await sync([
      // Someone else's App, on a personal connection.
      listener(outlook, { owner: someone().userId }),
      // Not a mailbox.
      listener(outlook, { resource: "a/b" }),
      // A drive's events, on a permission for a mailbox.
      listener(outlook, { type: "m365.file.created", resource: invoices }),
      // A mailbox that is a dot segment.
      listener(outlook, { resource: ".." }),
      // An event type nothing reports.
      listener(outlook, { type: "m365.mail.sent" }),
      // A connection no native Microsoft 365 connector carries.
      listener(outlook, { connection: composio }),
      // A disconnected connection, and one that doesn't exist.
      listener(gone),
      listener(outlook, {
        connection: connectionIdSchema.parse("connection-nowhere"),
      }),
    ]);

    await expect(sources()).resolves.toStrictEqual([]);
    expect(graphPaths()).toStrictEqual([]);
    await expect(listening()).resolves.toStrictEqual([]);
  });

  it("stop listening where no listener is left, and say so in the audit log", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    graph.receive(outlook.oid, invoiceMail(outlook.oid, 1, now()));
    later();
    await sync([]);

    await expect(sources()).resolves.toStrictEqual([]);
    // Nothing read once it stopped.
    expect(graphPaths()).toHaveLength(1);
    const events = await listening();

    expect(events.map(({ action, detail }) => [action, detail])).toStrictEqual([
      ["connection.events.started", { type: "m365.mail.received" }],
      ["connection.events.stopped", { type: "m365.mail.received" }],
    ]);
  });

  it("report files created in a drive after they started, not folders or deletions", async () => {
    const outlook = await connected();
    const own = listener(outlook, { type: "m365.file.created" });
    const finance = { ...own, resource: financeDrive };
    await sync([own, finance]);
    const file = createdFile(financeDrive, 1, now());
    graph.change(financeDrive, createdFolder(financeDrive, 2, now()));
    graph.change(financeDrive, deletedItem(financeDrive, 3));
    graph.change(
      financeDrive,
      createdFile(financeDrive, 4, "2026-01-05T09:00:00Z")
    );
    graph.change(financeDrive, file);
    later();
    await sync([own, finance]);

    // What the drives held is never read: each starts from now.
    expect(graphPaths().slice(0, 2).toSorted()).toStrictEqual([
      expect.stringMatching(
        new RegExp(
          `^/v1\\.0/drives/${financeDrive}/root/delta\\?token=latest&`,
          "u"
        )
      ),
      expect.stringMatching(
        new RegExp(
          `^/v1\\.0/users/${outlook.oid}/drive/root/delta\\?token=latest&`,
          "u"
        )
      ),
    ]);
    await expect(outboxed()).resolves.toStrictEqual([
      {
        id: itemId(1),
        connection: outlook.id,
        owner: outlook.person.userId,
        resource: financeDrive,
        action: "files.list",
        type: "m365.file.created",
        payload: {
          drive: financeDrive,
          id: itemId(1),
          name: "Invoice INV-1.pdf",
          mimeType: "application/pdf",
          size: 48_213,
          folderId: file.parentReference.id,
          createdAt: file.createdDateTime,
          webUrl: file.webUrl,
        },
      },
    ]);
  });

  it("read a flood of mail a hundred at a time, the rest at once", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    for (let n = 1; n <= 150; n += 1) {
      graph.receive(outlook.oid, invoiceMail(outlook.oid, n, now()));
    }
    later();
    await sync([listener(outlook)]);
    const first = await outboxed();
    // The rest is due at once, without waiting for the next minute.
    await sync([listener(outlook)]);
    const all = await outboxed();

    expect([first.length, all.length]).toStrictEqual([100, 150]);
  });

  it("read nothing while the outbox is full, and keep their place", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    await fillOutbox(outlook.id, outboxMax);
    const mail = invoiceMail(outlook.oid, 1, now());
    graph.receive(outlook.oid, mail);
    later();
    await sync([listener(outlook)]);

    expect(graphPaths()).toHaveLength(1);
    await env.DB.prepare(
      "DELETE FROM connector_events WHERE id LIKE 'filler-%'"
    ).run();
    await sync([listener(outlook)]);
    const events = await outboxed();

    expect(events.map(({ id }) => id)).toStrictEqual([mail.id]);
  });

  it("read a source only while the outbox has room for all it can find, so it never overflows", async () => {
    const outlook = await connected();
    const own = listener(outlook);
    const shared = listener(outlook, { resource: invoices });
    await sync([own, shared]);
    // Room for one read of up to 150 events, not two.
    await fillOutbox(outlook.id, outboxMax - 150);
    for (let n = 1; n <= 100; n += 1) {
      graph.receive(outlook.oid, invoiceMail(outlook.oid, n, now()));
      graph.receive(invoices, invoiceMail(invoices, n, now()));
    }
    later();
    await sync([own, shared]);
    const held = await heldCount();
    const left = await sources();

    expect({
      held,
      stillDue: left.filter(({ poll_at: pollAt }) => pollAt <= Date.now())
        .length,
    }).toStrictEqual({ held: outboxMax - 50, stillDue: 1 });
  });

  it("take a drive's position as soon as it starts, so a first read that comes late misses nothing", async () => {
    const outlook = await connected();
    const files = listener(outlook, {
      type: "m365.file.created",
      resource: financeDrive,
    });
    // No room to read: the first read has to wait.
    await fillOutbox(outlook.id, outboxMax);
    await sync([files]);
    const primed = await sources();
    const file = createdFile(financeDrive, 1, now());
    graph.change(financeDrive, file);
    await env.DB.prepare(
      "DELETE FROM connector_events WHERE id LIKE 'filler-%'"
    ).run();
    later();
    await sync([files]);
    const events = await outboxed();

    expect({
      primed: primed.map(({ cursor }) => cursor?.includes("token=0")),
      events: events.map(({ id }) => id),
    }).toStrictEqual({ primed: [true], events: [file.id] });
  });

  it("read nothing of a drive until its position is taken", async () => {
    const outlook = await connected();
    const files = listener(outlook, {
      type: "m365.file.created",
      resource: financeDrive,
    });
    instead = () =>
      Response.json(
        { error: { code: "ServiceNotAvailable" } },
        { status: 500 }
      );
    await sync([files]);
    const unprimed = await sources();
    later();
    await sync([files]);
    const primed = await sources();

    // Asked where the drive stands, and read nothing while it had no
    // position; once it had one, read on from there.
    expect({
      unprimed: unprimed.map(({ cursor }) => cursor),
      primed: primed.map(({ cursor }) => cursor?.includes("token=0")),
      asked: graphPaths().map((path) => path.includes("token=latest")),
    }).toStrictEqual({
      unprimed: [null],
      primed: [true],
      asked: [true, true, false],
    });
  });

  it("never let drives that keep failing to prime hold up another", async () => {
    const outlook = await connected();
    const failing = Array.from({ length: 25 }, (_, n) => `b!failing-${n}`);
    for (const drive of failing) {
      failingDrives.add(drive);
    }
    const listeners = [...failing, financeDrive].map((drive) =>
      listener(outlook, { type: "m365.file.created", resource: drive })
    );
    await sync(listeners);
    await sync(listeners);
    const { results } = await env.DB.prepare(
      "SELECT resource, failures FROM event_sources WHERE cursor IS NOT NULL"
    ).all<{ resource: string; failures: number }>();
    const failed = await sources();

    // The failing ones wait longer each time, as failed reads do.
    expect({
      primed: results.map(({ resource }) => resource),
      failures: [
        ...new Set(
          failed
            .filter(({ cursor }) => cursor === null)
            .map(({ failures }) => failures)
        ),
      ],
    }).toStrictEqual({ primed: [financeDrive], failures: [1] });
  });

  it("never hand core an event of a connection disconnected since, and drop it", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    graph.receive(outlook.oid, invoiceMail(outlook.oid, 1, now()));
    later();
    await sync([listener(outlook)]);
    await exports.default.disconnect({
      person: outlook.person,
      connectionId: outlook.id,
    });
    const taken = await exports.default.takeConnectorEvents();
    await sync([]);
    const held = await heldCount();
    const events = await listening();

    expect({ taken, held }).toStrictEqual({ taken: [], held: 0 });
    expect(
      events.filter(({ action }) => action === "connection.events.dropped")
    ).toStrictEqual([
      {
        action: "connection.events.dropped",
        actor: "system",
        target: outlook.id,
        detail: { reason: "disconnected", count: 1 },
        provenance: [],
      },
    ]);
  });

  it("wait as long as Graph asks when it throttles, and longer after each failure", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    instead = () =>
      Response.json(
        { error: { code: "TooManyRequests" } },
        { status: 429, headers: { "retry-after": "300" } }
      );
    later();
    const throttledAt = Date.now();
    await sync([listener(outlook)]);
    const throttled = await sources();
    later(299_000);
    await sync([listener(outlook)]);
    const asked = graphPaths().length;
    instead = () =>
      Response.json({ error: { code: "ServiceUnavailable" } }, { status: 500 });
    later(1000);
    const failedAt = Date.now();
    await sync([listener(outlook)]);
    const failed = await sources();
    later(2 * 60_000);
    await sync([listener(outlook)]);

    expect({
      throttled,
      failed,
      // Not asked again before the wait was over.
      asked,
    }).toMatchObject({
      throttled: [{ failures: 1, poll_at: throttledAt + 300_000 }],
      // Two failures in a row: two minutes.
      failed: [{ failures: 2, poll_at: failedAt + 2 * 60_000 }],
      asked: 2,
    });
    await expect(sources()).resolves.toMatchObject([{ failures: 0 }]);
  });

  it("start mail over from the last read when Graph no longer has the cursor, losing nothing", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    const lastRead = new Date().toISOString();
    later();
    const mail = invoiceMail(outlook.oid, 1, now());
    graph.receive(outlook.oid, mail);
    instead = () =>
      Response.json({ error: { code: "SyncStateNotFound" } }, { status: 410 });
    await sync([listener(outlook)]);
    const gone = await sources();
    later();
    await sync([listener(outlook)]);
    const events = await outboxed();

    expect(gone).toMatchObject([{ cursor: null, failures: 1 }]);
    expect({
      fromLastRead: graphPaths()
        .at(-1)
        ?.includes(`receivedDateTime ge ${lastRead}`),
      events: events.map(({ id }) => id),
    }).toStrictEqual({
      fromLastRead: true,
      events: [mail.id],
    });
  });

  it("report a message moved out of the inbox and back once, by its immutable ID", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    const mail = invoiceMail(outlook.oid, 1, now());
    graph.receive(outlook.oid, mail);
    later();
    await sync([listener(outlook)]);
    const [taken] = await exports.default.takeConnectorEvents();
    await exports.default.ackConnectorEvents({
      done: [taken?.id ?? ""],
      failed: [],
    });
    graph.moveBack(outlook.oid, mail, `${mail.id.slice(0, -1)}Mvd=`);
    later();
    await sync([listener(outlook)]);
    const events = await outboxed();

    expect({
      prefer: internet.sent.at(-1)?.headers.prefer,
      again: events.map(({ id }) => id),
    }).toStrictEqual({
      prefer: 'odata.maxpagesize=50, IdType="ImmutableId"',
      // The same ID as before: core starts nothing for it again.
      again: [mail.id],
    });
  });

  it("leave out a message shown again long after it arrived, only because it changed", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    const mail = invoiceMail(outlook.oid, 1, now());
    graph.receive(outlook.oid, mail);
    later();
    await sync([listener(outlook)]);
    await env.DB.prepare("DELETE FROM connector_events").run();
    later(15 * 60_000);
    await sync([listener(outlook)]);
    graph.receive(outlook.oid, { ...mail, isRead: true, flag: "flagged" });
    later();
    await sync([listener(outlook)]);

    await expect(outboxed()).resolves.toStrictEqual([]);
  });

  it("put every item of a read with short pages in the audit log, a hundred to an event", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    graph.shortenPages(30);
    for (let n = 1; n <= 120; n += 1) {
      graph.receive(outlook.oid, invoiceMail(outlook.oid, n, now()));
    }
    later();
    await sync([listener(outlook)]);
    const reads = await listening();
    const events = await outboxed();

    expect({
      reads: reads
        .filter(({ action }) => action === "connection.events.read")
        .map(({ provenance }) => provenance.length),
      events: events.length,
    }).toStrictEqual({ reads: [100, 20], events: 120 });
    const [source] = await sources();

    expect({
      failures: source?.failures,
      cursorAtEnd: source?.cursor?.includes("$deltatoken=120"),
    }).toStrictEqual({ failures: 0, cursorAtEnd: true });
  });

  it("read a source refused access only daily after ten refusals in a row, and say so once", async () => {
    const outlook = await connected();
    await sync([listener(outlook, { resource: invoices })]);
    const refusedAt: number[] = [];
    for (let attempt = 1; attempt <= refusedLimit + 1; attempt += 1) {
      instead = () =>
        Response.json(
          { error: { code: "ErrorAccessDenied" } },
          { status: 403 }
        );
      // oxlint-disable-next-line no-await-in-loop -- each read after the last one's wait
      const [source] = await sources();
      vi.setSystemTime(Math.max(Date.now(), source?.poll_at ?? 0));
      refusedAt.push(Date.now());
      // oxlint-disable-next-line no-await-in-loop -- reads in turn
      await sync([listener(outlook, { resource: invoices })]);
    }
    const [source] = await sources();
    const listed = await listening();
    const refused = listed.filter(
      ({ action }) => action === "connection.events.refused"
    );

    expect({
      failures: source?.failures,
      wait: (source?.poll_at ?? 0) - (refusedAt.at(-1) ?? 0),
      refused: refused.map(({ detail }) => detail),
    }).toStrictEqual({
      failures: refusedLimit + 1,
      wait: 24 * 60 * 60_000,
      refused: [
        {
          type: "m365.mail.received",
          resource: invoices,
          status: 403,
          failures: refusedLimit,
        },
      ],
    });
  });

  it("never send the token anywhere but Graph, whatever link it hands back", async () => {
    const outlook = await connected();
    instead = () =>
      Response.json({
        value: [],
        "@odata.deltaLink":
          "https://graph.example.com/v1.0/users/x/mailFolders('inbox')/messages/delta?$deltatoken=1",
      });
    await sync([listener(outlook)]);

    expect(
      internet.sent.filter(({ host }) => host !== "graph.microsoft.com")
    ).toStrictEqual([]);
    // Never kept: the source starts over instead.
    await expect(sources()).resolves.toMatchObject([
      { cursor: null, failures: 1 },
    ]);
  });

  it("hand core the events due, and have each that failed wait longer", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    graph.receive(outlook.oid, invoiceMail(outlook.oid, 1, now()));
    graph.receive(outlook.oid, invoiceMail(outlook.oid, 2, now()));
    later();
    await sync([listener(outlook)]);
    const taken = await exports.default.takeConnectorEvents();
    const [first = "", second = ""] = taken.map(({ id }) => id);
    await exports.default.ackConnectorEvents({
      done: [first],
      failed: [second],
    });
    const takes = [await exports.default.takeConnectorEvents()];
    later();
    takes.push(await exports.default.takeConnectorEvents());
    await exports.default.ackConnectorEvents({ done: [], failed: [second] });
    // A second failure: two minutes.
    later();
    takes.push(await exports.default.takeConnectorEvents());
    later();
    takes.push(await exports.default.takeConnectorEvents());

    expect(eventIdsOf(taken)).toStrictEqual([
      messageId(outlook.oid, 1),
      messageId(outlook.oid, 2),
    ]);
    expect(takes.map((each) => each.map(({ id }) => id))).toStrictEqual([
      [],
      [second],
      [],
      [second],
    ]);
  });

  it("drop an event after its last try, and say so in the audit log", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    graph.receive(outlook.oid, invoiceMail(outlook.oid, 1, now()));
    later();
    await sync([listener(outlook)]);
    await env.DB.prepare("UPDATE connector_events SET attempts = ?")
      .bind(maxDeliveryAttempts - 1)
      .run();
    const [taken] = await exports.default.takeConnectorEvents();
    await exports.default.ackConnectorEvents({
      done: [],
      failed: [taken?.id ?? ""],
    });
    later(24 * 60 * 60_000);

    await expect(exports.default.takeConnectorEvents()).resolves.toStrictEqual(
      []
    );
    const events = await listening();

    expect(events.at(-1)).toStrictEqual({
      action: "connection.events.dropped",
      actor: "system",
      target: outlook.id,
      detail: { type: "m365.mail.received", attempts: maxDeliveryAttempts },
      provenance: [],
    });
  });

  it("drop an event core will never take at once, and say so in the audit log", async () => {
    const outlook = await connected();
    await sync([listener(outlook)]);
    graph.receive(outlook.oid, invoiceMail(outlook.oid, 1, now()));
    later();
    await sync([listener(outlook)]);
    const [taken] = await exports.default.takeConnectorEvents();
    await exports.default.ackConnectorEvents({
      done: [],
      failed: [],
      rejected: [taken?.id ?? ""],
    });
    const events = await listening();

    await expect(exports.default.takeConnectorEvents()).resolves.toStrictEqual(
      []
    );
    expect(events.at(-1)).toMatchObject({
      action: "connection.events.dropped",
      target: outlook.id,
      detail: { type: "m365.mail.received", reason: "invalid" },
    });
  });

  it("refuse listeners and settlements that aren't valid", async () => {
    await expect(
      outcome(exports.default.ackConnectorEvents({ done: ["x"], failed: [] }))
    ).resolves.toBe("connect.invalid");
    await expect(outcome(exports.default.syncEventSources([{}]))).resolves.toBe(
      "connect.invalid"
    );
  });
});
