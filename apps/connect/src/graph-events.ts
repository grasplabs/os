import { segmentValuePattern } from "@grasp-os/connector-kit/manifest";
import { z } from "zod";

import {
  SourceError,
  isSince,
  newSince,
  providerLink,
  readFromProvider,
} from "./event-kinds.ts";
import type { EventKind, ReadEvents, SourceRead } from "./event-kinds.ts";

// Microsoft 365's events, read from Microsoft Graph with the connection's
// token, which stays in connect: Graph's delta queries say what changed in
// a mailbox's inbox or a drive since the last read, from the link the last
// read handed back. Nothing but graph.microsoft.com is ever sent the token:
// a link Graph hands back is kept only if it is on that host.
//
// A source is the resource a permission names (a mailbox, a drive) or,
// for a permission on the whole connection, the account's own mailbox or
// OneDrive (`''`), reached by its Entra object ID.
//
// Messages are asked for by their immutable IDs (`IdType="ImmutableId"`):
// a message's usual ID changes when it moves between folders, so one
// moved out of the inbox and back would be another event.

const graphHost = "graph.microsoft.com";
const hosts = [graphHost];
const v1 = `https://${graphHost}/v1.0`;

/**
 * A mailbox, as the connector's mail tools take it: an address or user
 * ID, never a dot segment.
 */
const isMailbox = (resource: string): boolean =>
  resource.length <= 256 &&
  segmentValuePattern.test(resource) &&
  resource !== "." &&
  resource !== "..";

/** A drive, as the connector's file tools take it: `b!...`. */
const isDrive = (resource: string): boolean =>
  resource.length <= 256 && /^b![\w=!.-]+$/u.test(resource);

/** The user a source of the account's own reaches: its Entra object ID. */
const ownUser = ({ connection }: SourceRead): string => {
  if (connection.accountId === null) {
    throw new SourceError("The connection names no account");
  }
  return encodeURIComponent(connection.accountId);
};

/**
 * A query string as OData reads it: each value percent-encoded, a space
 * as `%20` (never `+`, which OData may take as a plus).
 */
const queryOf = (query: Readonly<Record<string, string>>): string =>
  Object.entries(query)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");

const pageOf = <Item extends z.ZodType>(item: Item) =>
  z.object({
    value: z.array(item),
    "@odata.nextLink": z.string().optional(),
    "@odata.deltaLink": z.string().optional(),
  });

/** Graph, sent the token: only on its own host, over HTTPS. */
const graph = readFromProvider({
  name: "Microsoft Graph",
  hosts,
  // Pages of up to 50 items: a read takes a few. Immutable message IDs.
  headers: { prefer: 'odata.maxpagesize=50, IdType="ImmutableId"' },
});

/** Graph's page, as one read of a delta query goes through them. */
const graphPage =
  <Item extends z.ZodType>(item: Item) =>
  async (token: string, url: string) => {
    const page = pageOf(item).parse(await graph(token, url));
    return {
      items: page.value,
      next: providerLink(page["@odata.nextLink"], hosts),
      end: providerLink(page["@odata.deltaLink"], hosts),
    };
  };

const address = z
  .object({
    emailAddress: z
      .object({
        name: z.string().nullish(),
        address: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();

const message = z.object({
  id: z.string(),
  "@removed": z.unknown().optional(),
  receivedDateTime: z.string().nullish(),
  subject: z.string().nullish(),
  from: address,
  hasAttachments: z.boolean().nullish(),
  conversationId: z.string().nullish(),
  internetMessageId: z.string().nullish(),
  webLink: z.string().nullish(),
});

const messageFields = [
  "id",
  "receivedDateTime",
  "subject",
  "from",
  "hasAttachments",
  "conversationId",
  "internetMessageId",
  "webLink",
].join(",");

/**
 * `m365.mail.received`: mail that arrived in the mailbox's inbox after the
 * source started. A message a delta read shows again (read, flagged) is
 * left out once it's dated well before the last read, and has the same
 * ID anyway, so core starts nothing for it twice. A read that starts over
 * (its cursor gone) starts from the last read that succeeded: nothing
 * that arrived in between is lost, and what came before it is the same
 * events again.
 */
const mailReceived: EventKind = {
  provider: "microsoft",
  server: "microsoft-365",
  isResource: isMailbox,
  read: async (read): Promise<ReadEvents> => {
    const { source } = read;
    const mailbox =
      source.resource === ""
        ? ownUser(read)
        : encodeURIComponent(source.resource);
    const from = (source.readAt ?? source.createdAt).toISOString();
    const start = `${v1}/users/${mailbox}/mailFolders/inbox/messages/delta?${queryOf(
      {
        $select: messageFields,
        $filter: `receivedDateTime ge ${from}`,
      }
    )}`;
    const { items, cursor, more } = await read.pages(
      graphPage(message),
      source.cursor ?? start
    );
    const since = newSince(source);
    const events = items.flatMap((item) =>
      item["@removed"] === undefined && isSince(item.receivedDateTime, since)
        ? [
            {
              id: item.id,
              payload: {
                mailbox:
                  source.resource === ""
                    ? (read.connection.accountId ?? "")
                    : source.resource,
                id: item.id,
                folder: "inbox",
                subject: item.subject ?? null,
                from:
                  item.from?.emailAddress === null ||
                  item.from?.emailAddress === undefined
                    ? null
                    : {
                        name: item.from.emailAddress.name ?? null,
                        address: item.from.emailAddress.address ?? null,
                      },
                receivedAt: item.receivedDateTime ?? null,
                hasAttachments: item.hasAttachments ?? false,
                conversationId: item.conversationId ?? null,
                internetMessageId: item.internetMessageId ?? null,
                webLink: item.webLink ?? null,
              },
            },
          ]
        : []
    );
    return { events, cursor, more };
  },
};

const driveItem = z.object({
  id: z.string(),
  name: z.string().nullish(),
  file: z.object({ mimeType: z.string().nullish() }).nullish(),
  deleted: z.unknown().optional(),
  createdDateTime: z.string().nullish(),
  size: z.number().nullish(),
  webUrl: z.string().nullish(),
  parentReference: z
    .object({ driveId: z.string().nullish(), id: z.string().nullish() })
    .nullish(),
});

const driveItemFields = [
  "id",
  "name",
  "file",
  "deleted",
  "createdDateTime",
  "size",
  "webUrl",
  "parentReference",
].join(",");

/**
 * `m365.file.created`: files created in the drive after the source
 * started, in any folder of it. A drive's delta can't start from a time,
 * only from now (`token=latest`): the source takes that position as soon
 * as it starts (`prime`), so what the drive already holds is never read,
 * and a first read that comes late misses nothing. When its cursor is
 * gone, it takes the position again, and files created in between aren't
 * reported.
 */
const fileCreated: EventKind = {
  provider: "microsoft",
  server: "microsoft-365",
  isResource: isDrive,
  prime: async (read): Promise<string> => {
    const { source } = read;
    const drive =
      source.resource === ""
        ? `users/${ownUser(read)}/drive`
        : `drives/${encodeURIComponent(source.resource)}`;
    const now = await graphPage(driveItem)(
      read.token,
      `${v1}/${drive}/root/delta?${queryOf({
        token: "latest",
        $select: driveItemFields,
      })}`
    );
    if (now.end === undefined) {
      throw new SourceError("Graph handed back no delta link for now");
    }
    return now.end;
  },
  read: async (read): Promise<ReadEvents> => {
    const { source } = read;
    if (source.cursor === null) {
      throw new SourceError("The drive's position isn't taken yet");
    }
    const { items, cursor, more } = await read.pages(
      graphPage(driveItem),
      source.cursor
    );
    const since = newSince(source);
    const events = items.flatMap((item) =>
      item.deleted === undefined &&
      item.file !== null &&
      item.file !== undefined &&
      isSince(item.createdDateTime, since)
        ? [
            {
              id: item.id,
              payload: {
                drive:
                  item.parentReference?.driveId ??
                  (source.resource === "" ? null : source.resource),
                id: item.id,
                name: item.name ?? null,
                mimeType: item.file.mimeType ?? null,
                size: item.size ?? null,
                folderId: item.parentReference?.id ?? null,
                createdAt: item.createdDateTime ?? null,
                webUrl: item.webUrl ?? null,
              },
            },
          ]
        : []
    );
    return { events, cursor, more };
  },
};

/** Microsoft 365's event types. */
export const microsoftEventKinds: Readonly<Record<string, EventKind>> = {
  "m365.mail.received": mailReceived,
  "m365.file.created": fileCreated,
};
