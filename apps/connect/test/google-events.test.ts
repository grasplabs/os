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

import { pollIntervalMs } from "../src/events.ts";
import { accessTokenFor } from "../src/tokens.ts";
import { auditEvents, connectAccount, ownAccount, someone } from "./connect.ts";
import {
  driveFile,
  driveFileId,
  driveFolder,
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
const internet = fakeInternet((request, url) => google.answer(request, url));
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

/** The paths Google was asked for, without their queries. */
const paths = (): string[] =>
  internet.sent.map(({ host, path }) => `${host}${path.split("?")[0]}`);

describe("Google Workspace connector events", () => {
  beforeEach(async () => {
    google = googleEventsFake();
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
    const address = encodeURIComponent(gmail.address);

    // The own mailbox by its address, never `me`: where history stood,
    // then what came since, then each new message's metadata.
    expect(paths()).toStrictEqual([
      `gmail.googleapis.com/gmail/v1/users/${address}/profile`,
      `gmail.googleapis.com/gmail/v1/users/${address}/history`,
      `gmail.googleapis.com/gmail/v1/users/${address}/messages/${gmailId(3)}`,
      `gmail.googleapis.com/gmail/v1/users/${address}/messages/${gmailId(4)}`,
      `gmail.googleapis.com/gmail/v1/users/${address}/history`,
    ]);
    expect(internet.sent[0]?.headers.authorization).toBe(
      `Bearer ${await accessTokenFor(env, gmail.id)}`
    );
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

  it("name every message a large read found in the audit log, a hundred to an event", async () => {
    const gmail = await connected();
    await sync([listener(gmail)]);
    // Fifty history records of three messages each: one page, 150 events.
    for (let record = 0; record < 50; record += 1) {
      google.receive(
        gmail.address,
        ...[1, 2, 3].map((n) => gmailInvoice(record * 3 + n, Date.now()))
      );
    }
    later();
    await sync([listener(gmail)]);
    const events = await audit.events();
    const reads = events.filter(
      ({ action }) => action === "connection.events.read"
    );

    expect(
      reads.map(({ provenance, detail }) => [provenance.length, detail.count])
    ).toStrictEqual([
      [100, 100],
      [50, 50],
    ]);
    await expect(outboxed()).resolves.toHaveLength(150);
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
    expect(paths()).toStrictEqual([
      "www.googleapis.com/drive/v3/changes/startPageToken",
      "www.googleapis.com/drive/v3/changes",
    ]);
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
