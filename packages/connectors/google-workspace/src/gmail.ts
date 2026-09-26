import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import {
  checkReadable,
  contentAs,
  fromBase64,
  readAsSchema,
} from "@grasp-os/connector-kit/content";
import { z } from "zod";

import {
  gmailHost,
  googleJson,
  googleUrl,
  idSchema,
  jsonBody,
  nextPageOf,
  pageSchema,
  segment,
  topSchema,
} from "./google.ts";
import {
  addressesOf,
  attachmentsOf,
  bodyOf,
  headerOf,
  partSchema,
  rawMessage,
} from "./mime.ts";

// Gmail, one mailbox per call, always as `/gmail/v1/users/{mailbox}` with
// the mailbox's address, never `me`, so a call's capability binds every
// request to its mailbox. Google lets a person's token reach their own
// mailbox only; the binding still holds each call to the one a permission
// names. Each result names its mailbox and the IDs of the messages it came
// from. Labels aren't a scope: a permission is for a whole mailbox.

const users = "/gmail/v1/users/{mailbox}";

const get = (path: string) =>
  ({ method: "GET", host: gmailHost, path: `${users}${path}` }) as const;
const post = (path: string) =>
  ({ method: "POST", host: gmailHost, path: `${users}${path}` }) as const;

/** A mailbox: its address. Google's `me` alias isn't one. */
const mailboxSchema = z.email().max(256);

/** Gmail's path to a mailbox, encoded. */
const mailboxPath = (mailbox: string, path = ""): string =>
  `/gmail/v1/users/${segment(mailbox)}${path}`;

const gmailMessage = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
  labelIds: z.array(z.string()).nullish(),
  snippet: z.string().nullish(),
  internalDate: z.string().nullish(),
  payload: partSchema.nullish(),
});
type GmailMessage = z.infer<typeof gmailMessage>;

/** The headers a summary asks Gmail for. */
const summaryHeaders = ["Subject", "From", "To", "Cc", "Message-ID"];

const addressSchema = z.strictObject({
  name: z.string().nullable(),
  address: z.string().nullable(),
});

const summarySchema = z.strictObject({
  mailbox: z.string(),
  id: z.string(),
  threadId: z.string().nullable(),
  labelIds: z.array(z.string()),
  internetMessageId: z.string().nullable(),
  subject: z.string().nullable(),
  bodyPreview: z.string().nullable(),
  from: addressSchema.nullable(),
  to: z.array(addressSchema),
  cc: z.array(addressSchema),
  receivedAt: z.string().nullable(),
  isRead: z.boolean(),
  isDraft: z.boolean(),
});

/** When Gmail received a message, from its `internalDate` (ms), in ISO. */
const receivedAtOf = (internalDate: string | null | undefined) => {
  const ms = Number(internalDate ?? Number.NaN);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const summaryOf = (
  mailbox: string,
  message: GmailMessage
): z.infer<typeof summarySchema> => {
  const headers = message.payload?.headers;
  const labelIds = message.labelIds ?? [];
  const [from] = addressesOf(headerOf(headers, "From"));
  return {
    mailbox,
    id: message.id,
    threadId: message.threadId ?? null,
    labelIds,
    internetMessageId: headerOf(headers, "Message-ID") ?? null,
    subject: headerOf(headers, "Subject") ?? null,
    bodyPreview: message.snippet ?? null,
    from: from ?? null,
    to: addressesOf(headerOf(headers, "To")),
    cc: addressesOf(headerOf(headers, "Cc")),
    receivedAt: receivedAtOf(message.internalDate),
    isRead: !labelIds.includes("UNREAD"),
    isDraft: labelIds.includes("DRAFT"),
  };
};

/** A label's ID: a system one (`INBOX`, `UNREAD`) or the mailbox's own (`Label_12`). */
const labelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/u);

/** Messages a list returns unless asked for more. */
const defaultTop = 10;

/** Message reads a list sends at once. */
const concurrentReads = 5;

/** A message's metadata, or `null` if it's gone since it was listed. */
const metadataOf = async (
  mailbox: string,
  id: string
): Promise<GmailMessage | null> => {
  try {
    return await googleJson(
      googleUrl(gmailHost, mailboxPath(mailbox, `/messages/${segment(id)}`), {
        format: "metadata",
        metadataHeaders: summaryHeaders,
      }),
      gmailMessage
    );
  } catch (error) {
    if (error instanceof ToolError && error.details?.code === "not_found") {
      return null;
    }
    throw error;
  }
};

const messageList = z.object({
  messages: z.array(z.object({ id: z.string() })).nullish(),
  nextPageToken: z.string().nullish(),
});

const listMessages = defineTool({
  name: "mail.list",
  description:
    "Lists messages in a mailbox, newest first, optionally only those with a label (a label ID from mail.labels, or a system one such as INBOX), unread, received after a time, or matching a Gmail search.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    label: labelIdSchema.optional(),
    search: z.string().min(1).max(512).optional(),
    unreadOnly: z.boolean().optional(),
    receivedAfter: z.iso.datetime({ offset: true }).optional(),
    top: topSchema(25),
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    messages: z.array(summarySchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  resource: "mailbox",
  mask: ["messages.subject", "messages.bodyPreview"],
  // Gmail's search looks through subjects, bodies and attachments.
  searches: { search: ["subject", "body", "bodyPreview", "content"] },
  // Gmail lists IDs only; each message's metadata is one more request.
  routes: [get("/messages"), get("/messages/{message}")],
  run: async ({
    mailbox,
    label,
    search,
    unreadOnly,
    receivedAfter,
    top,
    page,
  }) => {
    const after =
      receivedAfter === undefined
        ? undefined
        : `after:${Math.floor(Date.parse(receivedAfter) / 1000)}`;
    const q = [search, after].filter((each) => each !== undefined).join(" ");
    const labelIds = [
      ...(label === undefined ? [] : [label]),
      ...(unreadOnly === true ? ["UNREAD"] : []),
    ];
    const { messages, nextPageToken } = await googleJson(
      googleUrl(
        gmailHost,
        mailboxPath(mailbox, "/messages"),
        {
          maxResults: String(top ?? defaultTop),
          q: q === "" ? undefined : q,
          labelIds,
        },
        page
      ),
      messageList
    );
    // No more than a page, a few at a time; one deleted since it was
    // listed (404) is left out.
    const ids = (messages ?? [])
      .slice(0, top ?? defaultTop)
      .map(({ id }) => id);
    const found: GmailMessage[] = [];
    for (let start = 0; start < ids.length; start += concurrentReads) {
      // oxlint-disable-next-line no-await-in-loop -- a few reads at a time
      const read = await Promise.all(
        ids
          .slice(start, start + concurrentReads)
          .map(async (id) => await metadataOf(mailbox, id))
      );
      found.push(...read.filter((message) => message !== null));
    }
    return {
      output: {
        mailbox,
        messages: found.map((message) => summaryOf(mailbox, message)),
        nextPage: nextPageOf(nextPageToken ?? undefined),
      },
      provenance: found.map(({ id }) => id),
    };
  },
});

const attachmentSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  contentType: z.string().nullable(),
  size: z.number(),
  isInline: z.boolean(),
});

/** How a message's body comes back: as its text part, or its HTML part. */
const bodyTypeSchema = z.enum(["text", "html"]);

/** A message with all its parts. */
const fullMessage = async (mailbox: string, id: string) =>
  await googleJson(
    googleUrl(gmailHost, mailboxPath(mailbox, `/messages/${segment(id)}`), {
      format: "full",
    }),
    gmailMessage
  );

const getMessage = defineTool({
  name: "mail.get",
  description:
    "Gets one message of a mailbox with its body, and its attachments' names, types and sizes (read one with mail.readAttachment).",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    bodyType: bodyTypeSchema.optional(),
  }),
  output: z.strictObject({
    message: summarySchema.extend({
      body: z
        .strictObject({ contentType: bodyTypeSchema, content: z.string() })
        .nullable(),
      bcc: z.array(addressSchema),
      replyTo: z.array(addressSchema),
      attachments: z.array(attachmentSchema),
    }),
  }),
  readOnly: true,
  resource: "mailbox",
  mask: ["message.subject", "message.bodyPreview", "message.body"],
  routes: [get("/messages/{message}")],
  run: async ({ mailbox, message: id, bodyType }) => {
    const message = await fullMessage(mailbox, id);
    const headers = message.payload?.headers;
    return {
      output: {
        message: {
          ...summaryOf(mailbox, message),
          body: bodyOf(message.payload ?? undefined, bodyType ?? "text") ?? {
            contentType: "text",
            content: "",
          },
          bcc: addressesOf(headerOf(headers, "Bcc")),
          replyTo: addressesOf(headerOf(headers, "Reply-To")),
          attachments: attachmentsOf(message.payload ?? undefined).map(
            ({ part: _part, ...attachment }) => attachment
          ),
        },
      },
      provenance: [message.id],
    };
  },
});

const gmailAttachment = z.object({
  size: z.number().int().nonnegative().nullish(),
  data: z.string(),
});

const readAttachment = defineTool({
  name: "mail.readAttachment",
  description:
    "Reads an attachment of a message (its ID from mail.get): as text, or as base64 to extract its content (a PDF, say). Up to 4 MiB.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    attachment: z
      .string()
      .max(64)
      .regex(/^\d+(?:\.\d+)*$/u),
    as: readAsSchema.optional(),
  }),
  output: z.strictObject({
    mailbox: z.string(),
    messageId: z.string(),
    id: z.string(),
    name: z.string(),
    contentType: z.string().nullable(),
    size: z.number(),
    encoding: readAsSchema,
    content: z.string().nullable(),
  }),
  readOnly: true,
  resource: "mailbox",
  mask: ["content"],
  routes: [
    get("/messages/{message}"),
    get("/messages/{message}/attachments/{attachment}"),
  ],
  run: async ({ mailbox, message: id, attachment: partId, as }) => {
    // The message first, for the part's name, size and current attachment
    // ID: Gmail's attachment IDs change on every read, its part IDs don't.
    const message = await fullMessage(mailbox, id);
    const found = attachmentsOf(message.payload ?? undefined).find(
      (each) => each.id === partId
    );
    if (found === undefined) {
      throw new ToolError("This message has no such attachment", {
        code: "not_found",
      });
    }
    checkReadable(found.size);
    const { attachmentId, data: inline } = found.part.body ?? {};
    const fetched =
      inline === undefined
        ? await googleJson(
            googleUrl(
              gmailHost,
              mailboxPath(
                mailbox,
                `/messages/${segment(id)}/attachments/${segment(attachmentId ?? "")}`
              )
            ),
            gmailAttachment
          )
        : undefined;
    const bytes = fromBase64(inline ?? fetched?.data ?? "");
    return {
      output: {
        mailbox,
        messageId: message.id,
        id: found.id,
        name: found.name,
        contentType: found.contentType,
        size: bytes.byteLength,
        ...contentAs(bytes, as ?? "base64"),
      },
      provenance: [message.id],
    };
  },
});

const listLabels = defineTool({
  name: "mail.labels",
  description:
    "Lists a mailbox's labels, system ones (INBOX, UNREAD) and its own, with the IDs mail.list and mail.label take.",
  input: z.strictObject({ mailbox: mailboxSchema }),
  output: z.strictObject({
    mailbox: z.string(),
    labels: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        type: z.string().nullable(),
      })
    ),
  }),
  readOnly: true,
  resource: "mailbox",
  routes: [get("/labels")],
  run: async ({ mailbox }) => {
    const { labels } = await googleJson(
      googleUrl(gmailHost, mailboxPath(mailbox, "/labels")),
      z.object({
        labels: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              type: z.string().nullish(),
            })
          )
          .nullish(),
      })
    );
    return {
      output: {
        mailbox,
        labels: (labels ?? []).map(({ id, name, type }) => ({
          id,
          name,
          type: type ?? null,
        })),
      },
    };
  },
});

const labelMessage = defineTool({
  name: "mail.label",
  description:
    "Adds labels to a message of a mailbox and removes others: to label it, mark it read (remove UNREAD) or move it (add a label, remove INBOX to archive). Adding SPAM also reports the message to Google as spam.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    message: idSchema,
    add: z.array(labelIdSchema).max(100).optional(),
    remove: z.array(labelIdSchema).max(100).optional(),
  }),
  output: z.strictObject({
    mailbox: z.string(),
    id: z.string(),
    labelIds: z.array(z.string()),
  }),
  readOnly: false,
  destructive: true,
  resource: "mailbox",
  routes: [post("/messages/{message}/modify")],
  run: async ({ mailbox, message: id, add = [], remove = [] }) => {
    if (add.length === 0 && remove.length === 0) {
      throw new ToolError("Name a label to add or to remove", {
        code: "invalid_request",
      });
    }
    const modified = await googleJson(
      googleUrl(
        gmailHost,
        mailboxPath(mailbox, `/messages/${segment(id)}/modify`)
      ),
      gmailMessage,
      jsonBody({ addLabelIds: add, removeLabelIds: remove })
    );
    return {
      output: {
        mailbox,
        id: modified.id,
        labelIds: modified.labelIds ?? [],
      },
    };
  },
});

const recipientsSchema = z.array(z.email().max(256)).max(100);

/** A message to send or keep as a draft. */
const draftInput = z.strictObject({
  mailbox: mailboxSchema,
  subject: z.string().max(1024),
  body: z.string().max(1024 * 1024),
  bodyType: bodyTypeSchema.optional(),
  to: recipientsSchema.min(1),
  cc: recipientsSchema.optional(),
  bcc: recipientsSchema.optional(),
  replyTo: recipientsSchema.optional(),
});

/** The message as Gmail's `raw` takes it, from the mailbox itself. */
const rawOf = (input: z.output<typeof draftInput>): string =>
  rawMessage({
    from: input.mailbox,
    subject: input.subject,
    body: input.body,
    bodyType: input.bodyType ?? "text",
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    replyTo: input.replyTo ?? [],
  });

const sentMessage = z.object({
  id: z.string(),
  threadId: z.string().nullish(),
});

const sendMail = defineTool({
  name: "mail.send",
  description:
    "Sends a message from a mailbox, keeping a copy in its Sent label.",
  input: draftInput,
  output: z.strictObject({
    mailbox: z.string(),
    sent: z.literal(true),
    id: z.string(),
    threadId: z.string().nullable(),
  }),
  readOnly: false,
  destructive: false,
  resource: "mailbox",
  routes: [post("/messages/send")],
  run: async (input) => {
    const sent = await googleJson(
      googleUrl(gmailHost, mailboxPath(input.mailbox, "/messages/send")),
      sentMessage,
      jsonBody({ raw: rawOf(input) })
    );
    return {
      output: {
        mailbox: input.mailbox,
        sent: true as const,
        id: sent.id,
        threadId: sent.threadId ?? null,
      },
    };
  },
});

const createDraft = defineTool({
  name: "mail.createDraft",
  description: "Creates a draft in a mailbox, for a person to review and send.",
  input: draftInput,
  output: z.strictObject({
    mailbox: z.string(),
    id: z.string(),
    messageId: z.string(),
    threadId: z.string().nullable(),
  }),
  readOnly: false,
  destructive: false,
  resource: "mailbox",
  routes: [post("/drafts")],
  run: async (input) => {
    const draft = await googleJson(
      googleUrl(gmailHost, mailboxPath(input.mailbox, "/drafts")),
      z.object({ id: z.string(), message: sentMessage }),
      jsonBody({ message: { raw: rawOf(input) } })
    );
    return {
      output: {
        mailbox: input.mailbox,
        id: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId ?? null,
      },
    };
  },
});

export const gmailTools = [
  listMessages,
  getMessage,
  readAttachment,
  listLabels,
  labelMessage,
  sendMail,
  createDraft,
];
