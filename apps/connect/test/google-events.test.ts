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

import { SourceError, requestBudget } from "../src/event-kinds.ts";
import { outboxMax, pollIntervalMs, requestsPerSync } from "../src/events.ts";
import { accessTokenFor } from "../src/tokens.ts";
import { auditEvents, connectAccount, ownAccount, someone } from "./connect.ts";
import {
  driveFile,
  driveFileId,
  driveFolder,
  driveShortcut,
  driveTrashed,
  gmailId,
  gmailInvoice,
  gmailSent,
} from "./fixtures/google-events.ts";
import { googleEventsFake } from "./google-events-fake.ts";
import type { GoogleEventsFake } from "./google-events-fake.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// Google Workspace's connector events: Gmail's history of messages added
// to the inbox, and a shared drive's changes, read from their recorded
// answers with the connection's token, into connect's outbox, as the
// Microsoft 365 events are (events.test.ts covers what they share:
// listening, the outbox, floods, failures).

const providers = fakeProviders();
let google: GoogleEventsFake = googleEventsFake();
/** Whether Google fails every request for where a mailbox or drive stands. */
let positionsFail = false;
const internet = fakeInternet(async (request, url) =>
  positionsFail &&
  (url.pathname.endsWith("/profile") ||
    url.pathname.endsWith("/changes/startPageToken"))
    ? Response.json({ error: { code: 503 } }, { status: 500 })
    : await google.answer(request, url)
);
const audit = auditEvents();

/** Finance's shared drive. */
const financeDrive = "0AFk3nRq9GkTnUk9PVA";

const later = (ms = pollIntervalMs): void => {
  vi.setSystemTime(Date.now() + ms);
};

/** Someone's Google Workspace connection: its ID, its owner and address. */
const connected = async () => {
  const person = someone();
  const account = ownAccount(person, "google");
  const id = connectionIdSchema.parse(
    await connectAccount(providers, person, account)
  );
  return { id, person, address: account.email };
};

type Connected = Awaited<ReturnType<typeof connected>>;

const listener = (
  { id, person }: Connected,
  changes: Partial<EventListener> = {}
): EventListener => ({
  type: "google.mail.received",
  connection: id,
  resource: null,
  owner: person.userId,
  ...changes,
});

const sync = async (listeners: EventListener[]): Promise<void> => {
  await exports.default.syncEventSources(listeners);
};

const outboxed = async (): Promise<Record<string, unknown>[]> => {
  const { results } = await env.DB.prepare(
    "SELECT event FROM connector_events ORDER BY rowid"
  ).all<{ event: string }>();
  return results.map(({ event }) =>
    z.record(z.string(), z.unknown()).parse(JSON.parse(event))
  );
};

const sources = async () => {
  const { results } = await env.DB.prepare(
    "SELECT resource, cursor, failures FROM event_sources ORDER BY rowid"
  ).all();
  return z
    .array(
      z.object({
        resource: z.string(),
        cursor: z.string().nullable(),
        failures: z.number(),
      })
    )
    .parse(results);
};

/** `count` events of `connection` in the outbox, waiting for core. */
const fillOutbox = async (connection: string, count: number) => {
  await env.DB.prepare(
    "INSERT INTO connector_events (id, key, connection_id, event, retry_at, created_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT 'filler-' || i, 'filler-' || i, ?, '{}', 0, 0 FROM n"
  )
    .bind(count, connection)
    .run();
};

const emptyOutbox = async () => {
  await env.DB.prepare(
    "DELETE FROM connector_events WHERE id LIKE 'filler-%'"
  ).run();
};

describe("Google Workspace connector events", () => {
  beforeEach(async () => {
    google = googleEventsFake();
    positionsFail = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event_sources"),
      env.DB.prepare("DELETE FROM connector_events"),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("report mail that reached the inbox after they started, once", async () => {
    const gmail = await connected();
    google.receive(gmail.address, gmailInvoice(1, Date.now() - 1000));
    await sync([listener(gmail)]);
    later();
    // Mail the owner sent, one deleted since, then a new invoice.
    google.receive(gmail.address, gmailSent(2, Date.now()));
    google.receive(gmail.address, gmailInvoice(3, Date.now()));
    google.remove(gmailId(3));
    google.receive(gmail.address, gmailInvoice(4, Date.now()));
    await sync([listener(gmail)]);
    later();
    await sync([listener(gmail)]);
    const token = `Bearer ${await accessTokenFor(env, gmail.id)}`;

    // Only Gmail, with the connection's token, and the own mailbox by its
    // address, never `me`: in the paths and in each batched request.
    expect({
      hosts: [...new Set(internet.sent.map(({ host }) => host))],
      tokens: [
        ...new Set(internet.sent.map(({ headers }) => headers.authorization)),
      ],
      mailbox: internet.sent.every(
        ({ path, body }) =>
          !`${path}${body}`.includes("/users/me/") &&
          (path.startsWith("/batch/") ||
            path.includes(`/users/${encodeURIComponent(gmail.address)}/`))
      ),
    }).toStrictEqual({
      hosts: ["gmail.googleapis.com"],
      tokens: [token],
      mailbox: true,
    });
    await expect(outboxed()).resolves.toStrictEqual([
      {
        id: gmailId(4),
        connection: gmail.id,
        owner: gmail.person.userId,
        action: "mail.list",
        type: "google.mail.received",
        payload: {
          mailbox: gmail.address,
          id: gmailId(4),
          threadId: gmailId(4),
          folder: "inbox",
          subject: "Invoice INV-4",
          from: {
            name: "Northwind Billing",
            address: "billing@northwind.example.com",
          },
          receivedAt: new Date(Date.now() - pollIntervalMs).toISOString(),
        },
      },
    ]);
    const events = await audit.events();

    expect(
      events
        .filter(({ action }) => action.startsWith("connection.events."))
        .map(({ action, provenance }) => [action, provenance])
    ).toStrictEqual([
      ["connection.events.started", []],
      ["connection.events.read", [gmailId(4)]],
    ]);
  });

  it("take a hundred messages a read, going on inside a history record where it stopped", async () => {
    const gmail = await connected();
    await sync([listener(gmail)]);
    // Forty history records of three messages each.
    for (let record = 0; record < 40; record += 1) {
      google.receive(
        gmail.address,
        ...[1, 2, 3].map((n) => gmailInvoice(record * 3 + n, Date.now()))
      );
    }
    later();
    await sync([listener(gmail)]);
    const first = await outboxed();
    await sync([listener(gmail)]);
    const all = await outboxed();
    const events = await audit.events();

    // The 34th record's first message is the hundredth: its other two come
    // with the rest, each message once.
    expect({
      first: first.length,
      reads: events
        .filter(({ action }) => action === "connection.events.read")
        .map(({ provenance }) => provenance.length),
      all: all.length,
      once: new Set(all.map(({ id }) => id)).size,
    }).toStrictEqual({ first: 100, reads: [100, 20], all: 120, once: 120 });
  });

  it("read a record of 600 messages a hundred at a time near a full outbox, never twice, and the others in between", async () => {
    const [big, small] = await Promise.all([connected(), connected()]);
    const listeners = [listener(big), listener(small)];
    await sync(listeners);
    // Room for one read at a time, as core takes what's read.
    await fillOutbox(big.id, outboxMax - 150);
    google.receive(
      big.address,
      ...Array.from({ length: 600 }, (_, n) => gmailInvoice(n + 1, Date.now()))
    );
    google.receive(small.address, gmailInvoice(1000, Date.now()));
    later();
    const delivered: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      // A moment between syncs: a source due longer is read first.
      later(1000);
      // oxlint-disable-next-line no-await-in-loop -- one sync after another
      await sync(listeners);
      // oxlint-disable-next-line no-await-in-loop -- core takes what's read
      const read = await env.DB.prepare(
        "DELETE FROM connector_events WHERE id NOT LIKE 'filler-%' RETURNING event"
      ).all<{ event: string }>();
      delivered.push(
        ...read.results.map(
          ({ event }) =>
            z.object({ id: z.string() }).parse(JSON.parse(event)).id
        )
      );
    }
    const bigBatches = internet.sent.filter(
      ({ path, body }) =>
        path.startsWith("/batch/") &&
        body.includes(`/users/${encodeURIComponent(big.address)}/`)
    );

    expect({
      delivered: delivered.length,
      once: new Set(delivered).size,
      // Each of the big record's messages' metadata read once: 600 / 50.
      bigBatches: bigBatches.length,
      smallBeforeBigDone: delivered.indexOf(gmailId(1000)) < 600,
    }).toStrictEqual({
      delivered: 601,
      once: 601,
      bigBatches: 12,
      smallBeforeBigDone: true,
    });
  });

  it("report a message a history entry names without its labels, as it asked for the inbox's", async () => {
    const gmail = await connected();
    await sync([listener(gmail)]);
    const { labelIds: _labels, ...unlabelled } = gmailInvoice(1, Date.now());
    google.receive(gmail.address, unlabelled);
    google.receive(gmail.address, gmailSent(2, Date.now()));
    later();
    await sync([listener(gmail)]);
    const events = await outboxed();

    expect(events.map(({ id }) => id)).toStrictEqual([gmailId(1)]);
  });

  it("keep every sync within its request budget through a flood of many-message records, and move on", async () => {
    const [big, busy] = await Promise.all([connected(), connected()]);
    const listeners = [listener(big), listener(busy)];
    await sync(listeners);
    // One record of 600 messages, and sixty of five.
    google.receive(
      big.address,
      ...Array.from({ length: 600 }, (_, n) => gmailInvoice(n + 1, Date.now()))
    );
    for (let record = 0; record < 60; record += 1) {
      google.receive(
        busy.address,
        ...Array.from({ length: 5 }, (_, n) =>
          gmailInvoice(1000 + record * 5 + n, Date.now())
        )
      );
    }
    later();
    const perSync: number[] = [];
    for (let run = 0; run < 8; run += 1) {
      const before = internet.sent.length;
      // oxlint-disable-next-line no-await-in-loop -- one sync after another
      await sync(listeners);
      perSync.push(internet.sent.length - before);
    }
    const events = await outboxed();

    expect({
      withinBudget: perSync.every((requests) => requests <= requestsPerSync),
      events: events.length,
    }).toStrictEqual({ withinBudget: true, events: 900 });
  });

  it("hold a sync to its request budget: a request past it stops the read, as spent, not failed", () => {
    const budget = requestBudget(2);
    budget.spend();
    budget.spend();
    let thrown: unknown;
    try {
      budget.spend();
    } catch (error) {
      thrown = error;
    }

    expect({
      left: budget.left,
      spent: thrown instanceof SourceError && thrown.spent,
      resync: thrown instanceof SourceError && thrown.resync,
    }).toStrictEqual({ left: 0, spent: true, resync: false });
  });

  it("take where a mailbox's history stands as soon as they start, so a first read that comes late misses nothing", async () => {
    const gmail = await connected();
    // No room to read: the first read has to wait.
    await fillOutbox(gmail.id, outboxMax);
    await sync([listener(gmail)]);
    google.receive(gmail.address, gmailInvoice(1, Date.now()));
    await emptyOutbox();
    later();
    await sync([listener(gmail)]);
    const events = await outboxed();

    expect(events.map(({ id }) => id)).toStrictEqual([gmailId(1)]);
  });

  it("read near a full outbox only as far as fits, and the rest once there's room", async () => {
    const gmail = await connected();
    await sync([listener(gmail)]);
    // Room for one read of up to 150 events; forty records of four.
    await fillOutbox(gmail.id, outboxMax - 150);
    for (let record = 0; record < 40; record += 1) {
      google.receive(
        gmail.address,
        ...[1, 2, 3, 4].map((n) => gmailInvoice(record * 4 + n, Date.now()))
      );
    }
    later();
    await sync([listener(gmail)]);
    const nearFull = await outboxed();
    // No room for another read.
    await sync([listener(gmail)]);
    const stillNearFull = await outboxed();
    await emptyOutbox();
    await sync([listener(gmail)]);
    const afterwards = await outboxed();

    expect({
      read: nearFull.length - (outboxMax - 150),
      waited: stillNearFull.length === nearFull.length,
      all: afterwards.length,
    }).toStrictEqual({ read: 100, waited: true, all: 160 });
  });

  it("read a sender's From header in time however it's padded, and unescape its name", async () => {
    const gmail = await connected();
    await sync([listener(gmail)]);
    const padded = gmailInvoice(1, Date.now());
    const escaped = gmailInvoice(2, Date.now());
    google.receive(gmail.address, {
      ...padded,
      payload: {
        ...padded.payload,
        headers: [
          { name: "From", value: `${"\u00A0".repeat(50_000)}"x" <` },
          { name: "Subject", value: "S".repeat(20_000) },
        ],
      },
    });
    google.receive(gmail.address, {
      ...escaped,
      payload: {
        ...escaped.payload,
        headers: [
          {
            name: "From",
            value: String.raw`"Billing \"Dept\"" <billing@northwind.example.com>`,
          },
        ],
      },
    });
    later();
    await sync([listener(gmail)]);
    const events = await outboxed();
    const payloads = events.map(({ payload }) =>
      z
        .object({
          subject: z.string().nullable(),
          from: z.object({ name: z.string().nullable() }).nullable(),
        })
        .parse(payload)
    );

    expect(
      payloads.map(({ subject, from }) => [
        subject?.length ?? 0,
        from?.name ?? null,
      ])
    ).toStrictEqual([
      [1000, null],
      [0, 'Billing "Dept"'],
    ]);
  }, 10_000);

  it("back off taking a position that keeps failing, as a failed read does", async () => {
    const gmail = await connected();
    positionsFail = true;
    await sync([
      listener(gmail),
      listener(gmail, { type: "google.file.created", resource: financeDrive }),
    ]);
    const failed = await sources();
    const asked = internet.sent.length;
    // Within the wait, nothing is asked again.
    await sync([
      listener(gmail),
      listener(gmail, { type: "google.file.created", resource: financeDrive }),
    ]);
    const askedAgain = internet.sent.length - asked;
    positionsFail = false;
    later();
    await sync([
      listener(gmail),
      listener(gmail, { type: "google.file.created", resource: financeDrive }),
    ]);
    const events = await audit.events();

    expect({
      failed: failed.map(({ cursor, failures }) => [cursor, failures]),
      askedAgain,
      // Once primed, how long each went without a position.
      primedLate: events
        .filter(({ action }) => action === "connection.events.primed_late")
        .map(({ detail }) => [detail.type, detail.failures, detail.delayMs])
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
    }).toStrictEqual({
      failed: [
        [null, 1],
        [null, 1],
      ],
      askedAgain: 0,
      primedLate: [
        ["google.file.created", 1, pollIntervalMs],
        ["google.mail.received", 1, pollIntervalMs],
      ],
    });
  });

  it("start over from now when Gmail no longer keeps the history", async () => {
    const gmail = await connected();
    await sync([listener(gmail)]);
    google.receive(gmail.address, gmailInvoice(1, Date.now()));
    google.forget(gmail.address);
    later();
    await sync([listener(gmail)]);
    const gone = await sources();
    later();
    await sync([listener(gmail)]);

    const [resynced] = await sources();

    expect(gone).toMatchObject([{ cursor: null, failures: 1 }]);
    expect({
      from: new URL(resynced?.cursor ?? "https://x.test").searchParams.get(
        "startHistoryId"
      ),
      failures: resynced?.failures,
    }).toStrictEqual({ from: "1804001", failures: 0 });
  });

  it("report files created in a shared drive a permission names, not folders, the trash or other drives", async () => {
    const gmail = await connected();
    const files = listener(gmail, { type: "google.file.created" });
    // A permission on the whole connection: My Drive has no drive ID.
    await sync([files, { ...files, resource: financeDrive }]);
    const created = new Date().toISOString();
    google.change(financeDrive, driveFolder(financeDrive, 1, created));
    google.change(financeDrive, driveTrashed(financeDrive, 2, created));
    google.change(financeDrive, driveShortcut(financeDrive, 6, created));
    google.change(financeDrive, driveFile("0AOtherDrive", 3, created));
    google.change(
      financeDrive,
      driveFile(financeDrive, 4, "2026-01-05T09:00:00Z")
    );
    const file = driveFile(financeDrive, 5, created);
    google.change(financeDrive, file);
    later();
    await sync([files, { ...files, resource: financeDrive }]);

    await expect(sources()).resolves.toMatchObject([
      { resource: financeDrive },
    ]);
    // Drive only, each request held to the shared drive.
    expect(
      internet.sent.every(
        ({ host, path }) =>
          host === "www.googleapis.com" &&
          path.startsWith("/drive/v3/changes") &&
          new URL(`https://${host}${path}`).searchParams.get("driveId") ===
            financeDrive
      )
    ).toBeTruthy();
    await expect(outboxed()).resolves.toStrictEqual([
      {
        id: driveFileId(5),
        connection: gmail.id,
        owner: gmail.person.userId,
        resource: financeDrive,
        action: "files.list",
        type: "google.file.created",
        payload: {
          drive: financeDrive,
          id: driveFileId(5),
          name: "Invoice INV-5.pdf",
          mimeType: "application/pdf",
          size: 48_213,
          folderId: financeDrive,
          createdAt: created,
          webUrl: file.file.webViewLink,
        },
      },
    ]);
  });
});
