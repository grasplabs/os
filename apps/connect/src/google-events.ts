import { addressesOf } from "@grasp-os/connector-google-workspace/mime";
import { z } from "zod";

import {
  SourceError,
  isSince,
  newSince,
  postToProvider,
  providerJson,
  readFromProvider,
  readMaxItems,
} from "./event-kinds.ts";
import type {
  EventKind,
  ProviderAccess,
  ReadEvent,
  ReadEvents,
  SourceRead,
} from "./event-kinds.ts";

// Google Workspace's events, read with the connection's token, which stays
// in connect: Gmail's history says which messages reached a mailbox's
// inbox since a history ID, and Drive's changes what changed in a shared
// drive since a page token. Nothing from before a source started is read.
// Nothing but Google's API hosts is ever sent the token. Gmail's message and Drive's file IDs don't change as a
// message is labelled or a file edited, and Gmail's history only reports
// a message once as added, so nothing is reported twice for a change.
// Neither reads on from a time, only from a position: a source takes
// where the mailbox's history or the drive's changes stand as soon as it
// starts (`prime`), so a first read that comes late misses nothing. Nor
// can either replay what came before a position: while a source has none
// (its prime failing, or its history ID or page token gone), what comes
// isn't reported. Priming is tried again within five minutes, and a late
// one is recorded (`connection.events.primed_late`, events.ts).
//
// A mailbox is its address, as the connector's Gmail tools take it: the
// one a permission names, or, for a permission on the whole connection,
// the account's own. A drive is a shared drive a permission names: as for
// the connector's tools, a person's My Drive has no drive ID to hold a
// read to, so a permission on the whole connection hears no file events.

const gmailHost = "gmail.googleapis.com";
const apisHost = "www.googleapis.com";

/** Google, sent the token: only on its API hosts, over HTTPS. */
const googleSpec = {
  name: "Google",
  hosts: [gmailHost, apisHost],
  // Gmail answers a history ID it no longer keeps with a 404.
  resyncStatuses: [404],
};
const google = readFromProvider(googleSpec);
const googlePost = postToProvider(googleSpec);

/** A query string, each value percent-encoded. */
const queryOf = (query: Readonly<Record<string, string>>): string =>
  Object.entries(query)
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    )
    .join("&");

/** A mailbox, as the connector's Gmail tools take it: an address. */
const isMailbox = (resource: string): boolean =>
  z.email().max(256).safeParse(resource).success;

/** A shared drive's ID, as the connector's Drive tools take it. */
const isDrive = (resource: string): boolean =>
  resource.length <= 256 && /^[\w-]+$/u.test(resource);

/** The mailbox a source reads: the one it names, or the account's own. */
const mailboxOf = ({ source, connection }: SourceRead): string => {
  const mailbox =
    source.resource === "" ? connection.accountName : source.resource;
  if (mailbox === null || !isMailbox(mailbox)) {
    throw new SourceError("The connection names no mailbox");
  }
  return mailbox;
};

const gmail = (mailbox: string, path: string): string =>
  `https://${gmailHost}/gmail/v1/users/${encodeURIComponent(mailbox)}${path}`;

const profileSchema = z.object({ historyId: z.string().min(1) });

const historySchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string().min(1),
        messagesAdded: z
          .array(
            z.object({
              message: z.object({
                id: z.string(),
                labelIds: z.array(z.string()).nullish(),
              }),
            })
          )
          .nullish(),
      })
    )
    .nullish(),
  nextPageToken: z.string().nullish(),
  historyId: z.string().min(1),
});

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
  internalDate: z.string().nullish(),
  payload: z
    .object({
      headers: z
        .array(z.object({ name: z.string(), value: z.string() }))
        .nullish(),
    })
    .nullish(),
});

/** Messages whose metadata one batch request reads. */
const messagesPerBatch = 50;

/** Longest subject an event carries, in characters. */
const subjectMaxLength = 1000;

/** When Gmail received a message, from its `internalDate` (ms), in ISO. */
const receivedAtOf = (internalDate: string | null | undefined) => {
  const ms = Number(internalDate ?? Number.NaN);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** A message's event, from its metadata. */
const mailEventOf = (mailbox: string, body: unknown): ReadEvent => {
  const message = messageSchema.parse(body);
  const header = (name: string) =>
    message.payload?.headers?.find(
      (each) => each.name.toLowerCase() === name.toLowerCase()
    )?.value;
  const [from] = addressesOf(header("From"));
  return {
    id: message.id,
    payload: {
      mailbox,
      id: message.id,
      threadId: message.threadId ?? null,
      folder: "inbox",
      subject: header("Subject")?.slice(0, subjectMaxLength) ?? null,
      from:
        from === undefined ? null : { name: from.name, address: from.address },
      receivedAt: receivedAtOf(message.internalDate),
    },
  };
};

/** Gmail's batch endpoint, on its own host. */
const gmailBatchUrl = `https://${gmailHost}/batch/gmail/v1`;

/** The `boundary` a multipart answer's content type names. */
const boundaryOf = (contentType: string): string | undefined => {
  const at = contentType.toLowerCase().indexOf("boundary=");
  if (at === -1) {
    return undefined;
  }
  const [value = ""] = contentType.slice(at + "boundary=".length).split(";");
  const boundary = value.trim().replaceAll('"', "");
  return boundary === "" ? undefined : boundary;
};

/**
 * The parts of Gmail's batch answer: each one's HTTP status and body. No
 * regex: the answer is split at its boundary and each part's status line
 * and body found by position.
 */
const batchParts = (
  text: string,
  contentType: string
): { status: number; body: string }[] => {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) {
    throw new SourceError("Gmail's batch answer names no boundary");
  }
  return text
    .replaceAll("\r\n", "\n")
    .split(`--${boundary}`)
    .slice(1)
    .filter((part) => !part.startsWith("--"))
    .map((part) => {
      const line = part.indexOf("HTTP/1.1 ");
      const status = Number(part.slice(line + 9, line + 12));
      const bodyAt = part.indexOf("\n\n", line);
      if (line === -1 || !Number.isInteger(status) || bodyAt === -1) {
        throw new SourceError("Gmail's batch answer has a part it can't read");
      }
      return { status, body: part.slice(bodyAt + 2).trim() };
    });
};

/**
 * The events of messages `ids`, their metadata read through Gmail's batch
 * endpoint, a request per `messagesPerBatch` messages. A message deleted
 * since it arrived is left out; any other failure fails the read.
 */
const mailEventsOf = async (
  access: ProviderAccess,
  mailbox: string,
  ids: readonly string[]
): Promise<ReadEvent[]> => {
  const events: ReadEvent[] = [];
  for (let at = 0; at < ids.length; at += messagesPerBatch) {
    const boundary = `batch_${crypto.randomUUID()}`;
    const body = `${ids
      .slice(at, at + messagesPerBatch)
      .map(
        (id, index) =>
          `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${index}>\r\n\r\nGET /gmail/v1/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From\r\n\r\n`
      )
      .join("")}--${boundary}--`;
    // oxlint-disable-next-line no-await-in-loop -- a batch at a time, each counted
    const answer = await googlePost(
      access,
      gmailBatchUrl,
      body,
      `multipart/mixed; boundary=${boundary}`
    );
    for (const part of batchParts(answer.text, answer.contentType)) {
      if (part.status === 404) {
        continue;
      }
      if (part.status !== 200) {
        throw new SourceError(`Gmail answered ${part.status} in a batch`, {
          status: part.status,
          ...(part.status === 429 ? { retryAfterMs: 60_000 } : {}),
        });
      }
      events.push(mailEventOf(mailbox, providerJson("Gmail", part.body)));
    }
  }
  return events;
};

/** Gmail's history of messages added to `mailbox`'s inbox from `historyId`. */
const historyFrom = (mailbox: string, historyId: string): string =>
  `${gmail(mailbox, "/history")}?${queryOf({
    startHistoryId: historyId,
    historyTypes: "messageAdded",
    labelId: "INBOX",
    maxResults: "20",
  })}`;

/** One history record: its ID, and the messages it added to the inbox. */
interface HistoryRecord {
  id: string;
  messages: string[];
}

/**
 * `google.mail.received`: mail that reached the mailbox's inbox after the
 * source started, by Gmail's history of messages added with the INBOX
 * label, from where the mailbox's history stood as the source started
 * (`prime`). Gmail's history reports a message as added once, when it
 * arrives: a message moved into the inbox later isn't reported.
 *
 * A read stops at the history record that brings its messages to
 * `readMaxItems`, and reads on from that record next time, so its
 * requests (pages, and a batch request per 50 messages' metadata) and its
 * events stay bounded: 100 messages and the rest of one record. A record
 * is never split, so one whose batches alone passed a sync's request
 * budget (some 20,000 messages in one record) would never move on.
 */
const mailReceived: EventKind = {
  provider: "google",
  server: "google-workspace",
  isResource: isMailbox,
  wholeConnection: true,
  prime: async (read): Promise<string> => {
    const mailbox = mailboxOf(read);
    const { historyId } = profileSchema.parse(
      await google(read.access, gmail(mailbox, "/profile"))
    );
    return historyFrom(mailbox, historyId);
  },
  read: async (read): Promise<ReadEvents> => {
    const mailbox = mailboxOf(read);
    if (read.source.cursor === null) {
      throw new SourceError("The mailbox's history position isn't taken yet");
    }
    const walked = await read.pages(async (access, url) => {
      const page = historySchema.parse(await google(access, url));
      const next = new URL(url);
      if (page.nextPageToken !== null && page.nextPageToken !== undefined) {
        next.searchParams.set("pageToken", page.nextPageToken);
      }
      return {
        items: (page.history ?? []).map(
          ({ id, messagesAdded }): HistoryRecord => ({
            id,
            messages: (messagesAdded ?? [])
              .filter(
                ({ message }) => message.labelIds?.includes("INBOX") === true
              )
              .map(({ message }) => message.id),
          })
        ),
        ...(page.nextPageToken === null || page.nextPageToken === undefined
          ? { end: historyFrom(mailbox, page.historyId) }
          : { next: next.href }),
      };
    }, read.source.cursor);
    let { cursor, more } = walked;
    const ids = new Set<string>();
    for (const [index, record] of walked.items.entries()) {
      for (const id of record.messages) {
        ids.add(id);
      }
      if (ids.size >= readMaxItems && index < walked.items.length - 1) {
        // The rest from after this record, next time.
        cursor = historyFrom(mailbox, record.id);
        more = true;
        break;
      }
    }
    const events = await mailEventsOf(read.access, mailbox, [...ids]);
    return { events, cursor, more };
  },
};

const changesSchema = z.object({
  changes: z
    .array(
      z.object({
        removed: z.boolean().nullish(),
        file: z
          .object({
            id: z.string(),
            name: z.string().nullish(),
            mimeType: z.string().nullish(),
            size: z.string().nullish(),
            createdTime: z.string().nullish(),
            parents: z.array(z.string()).nullish(),
            driveId: z.string().nullish(),
            trashed: z.boolean().nullish(),
            webViewLink: z.string().nullish(),
          })
          .nullish(),
      })
    )
    .nullish(),
  nextPageToken: z.string().nullish(),
  newStartPageToken: z.string().nullish(),
});

/** Drive items that aren't files of their own: folders and shortcuts. */
const notFiles = new Set([
  "application/vnd.google-apps.folder",
  "application/vnd.google-apps.shortcut",
]);

/** The query that holds a Drive request to shared drive `drive`. */
const sharedDrive = (drive: string) => ({
  driveId: drive,
  supportsAllDrives: "true",
});

/** Drive's changes of shared drive `drive` from `pageToken`. */
const changesFrom = (drive: string, pageToken: string): string =>
  `https://${apisHost}/drive/v3/changes?${queryOf({
    ...sharedDrive(drive),
    pageToken,
    includeItemsFromAllDrives: "true",
    pageSize: "50",
    fields:
      "nextPageToken,newStartPageToken,changes(removed,file(id,name,mimeType,size,createdTime,parents,driveId,trashed,webViewLink))",
  })}`;

/**
 * `google.file.created`: files created in the shared drive after the
 * source started, in any folder of it, by Drive's changes of that drive,
 * from where they stood as the source started (`prime`).
 */
const fileCreated: EventKind = {
  provider: "google",
  server: "google-workspace",
  isResource: isDrive,
  wholeConnection: false,
  prime: async (read): Promise<string> => {
    const drive = read.source.resource;
    const { startPageToken } = z
      .object({ startPageToken: z.string().min(1) })
      .parse(
        await google(
          read.access,
          `https://${apisHost}/drive/v3/changes/startPageToken?${queryOf(sharedDrive(drive))}`
        )
      );
    return changesFrom(drive, startPageToken);
  },
  read: async (read): Promise<ReadEvents> => {
    const { source } = read;
    const drive = source.resource;
    if (source.cursor === null) {
      throw new SourceError("The drive's position isn't taken yet");
    }
    const { items, cursor, more } = await read.pages(async (access, url) => {
      const page = changesSchema.parse(await google(access, url));
      const { nextPageToken, newStartPageToken } = page;
      return {
        items: page.changes ?? [],
        ...(nextPageToken !== null && nextPageToken !== undefined
          ? { next: changesFrom(drive, nextPageToken) }
          : {}),
        ...(newStartPageToken !== null && newStartPageToken !== undefined
          ? { end: changesFrom(drive, newStartPageToken) }
          : {}),
      };
    }, source.cursor);
    const events = items.flatMap(({ removed, file }): ReadEvent[] =>
      removed !== true &&
      file !== null &&
      file !== undefined &&
      file.trashed !== true &&
      !notFiles.has(file.mimeType ?? "") &&
      file.driveId === drive &&
      isSince(file.createdTime, newSince(source))
        ? [
            {
              id: file.id,
              payload: {
                drive,
                id: file.id,
                name: file.name ?? null,
                mimeType: file.mimeType ?? null,
                size:
                  file.size === null || file.size === undefined
                    ? null
                    : Number(file.size),
                folderId: file.parents?.[0] ?? null,
                createdAt: file.createdTime ?? null,
                webUrl: file.webViewLink ?? null,
              },
            },
          ]
        : []
    );
    return { events, cursor, more };
  },
};

/** Google Workspace's event types. */
export const googleEventKinds: Readonly<Record<string, EventKind>> = {
  "google.mail.received": mailReceived,
  "google.file.created": fileCreated,
};
