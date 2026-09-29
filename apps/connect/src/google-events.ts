import { z } from "zod";

import {
  SourceError,
  isSince,
  newSince,
  readFromProvider,
} from "./event-kinds.ts";
import type {
  EventKind,
  ReadEvent,
  ReadEvents,
  SourceRead,
} from "./event-kinds.ts";

// Google Workspace's events, read with the connection's token, which stays
// in connect: Gmail's history says which messages reached a mailbox's
// inbox since a history ID, and Drive's changes what changed in a shared
// drive since a page token. The first read of a source only asks for
// where Gmail's history or Drive's changes stand now, so nothing from
// before it started is read. Nothing but Google's API hosts is ever sent
// the token. Gmail's message and Drive's file IDs don't change as a
// message is labelled or a file edited, and Gmail's history only reports
// a message once as added, so nothing is reported twice for a change.
// Neither can replay what it no longer keeps: a source whose history ID
// or page token has gone starts over from now, and what came in between
// isn't reported.
//
// A mailbox is its address, as the connector's Gmail tools take it: the
// one a permission names, or, for a permission on the whole connection,
// the account's own. A drive is a shared drive a permission names: as for
// the connector's tools, a person's My Drive has no drive ID to hold a
// read to, so a permission on the whole connection hears no file events.

const gmailHost = "gmail.googleapis.com";
const apisHost = "www.googleapis.com";

/** Google, sent the token: only on its API hosts, over HTTPS. */
const google = readFromProvider({
  name: "Google",
  hosts: [gmailHost, apisHost],
  // Gmail answers a history ID it no longer keeps with a 404.
  resyncStatuses: [404],
});

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

/** Messages whose metadata is read at once. */
const concurrentReads = 5;

/** `Name <address>`, `<address>` or `address`, as a From header has it. */
const addressOf = (
  header: string | undefined
): { name: string | null; address: string | null } | null => {
  if (header === undefined) {
    return null;
  }
  const found = /^\s*(?:"?(?<name>[^"<]*?)"?\s*)?<(?<address>[^>]+)>\s*$/u.exec(
    header
  )?.groups;
  if (found?.address === undefined) {
    return { name: null, address: header.trim() };
  }
  const name = found.name?.trim() ?? "";
  return { name: name === "" ? null : name, address: found.address.trim() };
};

/** When Gmail received a message, from its `internalDate` (ms), in ISO. */
const receivedAtOf = (internalDate: string | null | undefined) => {
  const ms = Number(internalDate ?? Number.NaN);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** A message's event, or none if it's gone since it arrived. */
const mailEventOf = async (
  token: string,
  mailbox: string,
  id: string
): Promise<ReadEvent[]> => {
  let body: unknown;
  try {
    body = await google(
      token,
      `${gmail(mailbox, `/messages/${encodeURIComponent(id)}`)}?${queryOf({
        format: "metadata",
      })}&metadataHeaders=Subject&metadataHeaders=From`
    );
  } catch (error) {
    // Deleted since: nothing to report.
    if (error instanceof SourceError && error.resync) {
      return [];
    }
    throw error;
  }
  const message = messageSchema.parse(body);
  const header = (name: string) =>
    message.payload?.headers?.find(
      (each) => each.name.toLowerCase() === name.toLowerCase()
    )?.value;
  return [
    {
      id: message.id,
      payload: {
        mailbox,
        id: message.id,
        threadId: message.threadId ?? null,
        folder: "inbox",
        subject: header("Subject") ?? null,
        from: addressOf(header("From")),
        receivedAt: receivedAtOf(message.internalDate),
      },
    },
  ];
};

/**
 * `google.mail.received`: mail that reached the mailbox's inbox after the
 * source started, by Gmail's history of messages added with the INBOX
 * label. Each message's subject and sender are read from its metadata.
 */
const mailReceived: EventKind = {
  provider: "google",
  server: "google-workspace",
  isResource: isMailbox,
  wholeConnection: true,
  read: async (read): Promise<ReadEvents> => {
    const mailbox = mailboxOf(read);
    const historyFrom = (historyId: string): string =>
      `${gmail(mailbox, "/history")}?${queryOf({
        startHistoryId: historyId,
        historyTypes: "messageAdded",
        labelId: "INBOX",
        maxResults: "50",
      })}`;
    if (read.source.cursor === null) {
      const { historyId } = profileSchema.parse(
        await google(read.token, gmail(mailbox, "/profile"))
      );
      return { events: [], cursor: historyFrom(historyId), more: false };
    }
    const { items, cursor, more } = await read.pages(async (token, url) => {
      const page = historySchema.parse(await google(token, url));
      const next = new URL(url);
      if (page.nextPageToken !== null && page.nextPageToken !== undefined) {
        next.searchParams.set("pageToken", page.nextPageToken);
      }
      return {
        items: (page.history ?? []).flatMap(({ messagesAdded }) =>
          (messagesAdded ?? [])
            .filter(
              ({ message }) => message.labelIds?.includes("INBOX") === true
            )
            .map(({ message }) => message.id)
        ),
        ...(page.nextPageToken === null || page.nextPageToken === undefined
          ? { end: historyFrom(page.historyId) }
          : { next: next.href }),
      };
    }, read.source.cursor);
    const ids = [...new Set(items)];
    const events: ReadEvent[] = [];
    for (let at = 0; at < ids.length; at += concurrentReads) {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      const found = await Promise.all(
        ids
          .slice(at, at + concurrentReads)
          .map(async (id) => await mailEventOf(read.token, mailbox, id))
      );
      events.push(...found.flat());
    }
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

const folderMimeType = "application/vnd.google-apps.folder";

/**
 * `google.file.created`: files created in the shared drive after the
 * source started, in any folder of it, by Drive's changes of that drive.
 */
const fileCreated: EventKind = {
  provider: "google",
  server: "google-workspace",
  isResource: isDrive,
  wholeConnection: false,
  read: async (read): Promise<ReadEvents> => {
    const { source } = read;
    const drive = source.resource;
    const shared = {
      driveId: drive,
      supportsAllDrives: "true",
    };
    const changesFrom = (pageToken: string): string =>
      `https://${apisHost}/drive/v3/changes?${queryOf({
        ...shared,
        pageToken,
        includeItemsFromAllDrives: "true",
        pageSize: "50",
        fields:
          "nextPageToken,newStartPageToken,changes(removed,file(id,name,mimeType,size,createdTime,parents,driveId,trashed,webViewLink))",
      })}`;
    if (source.cursor === null) {
      const { startPageToken } = z
        .object({ startPageToken: z.string().min(1) })
        .parse(
          await google(
            read.token,
            `https://${apisHost}/drive/v3/changes/startPageToken?${queryOf(shared)}`
          )
        );
      return { events: [], cursor: changesFrom(startPageToken), more: false };
    }
    const { items, cursor, more } = await read.pages(async (token, url) => {
      const page = changesSchema.parse(await google(token, url));
      const { nextPageToken, newStartPageToken } = page;
      return {
        items: page.changes ?? [],
        ...(nextPageToken !== null && nextPageToken !== undefined
          ? { next: changesFrom(nextPageToken) }
          : {}),
        ...(newStartPageToken !== null && newStartPageToken !== undefined
          ? { end: changesFrom(newStartPageToken) }
          : {}),
      };
    }, source.cursor);
    const events = items.flatMap(({ removed, file }): ReadEvent[] =>
      removed !== true &&
      file !== null &&
      file !== undefined &&
      file.trashed !== true &&
      file.mimeType !== folderMimeType &&
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
