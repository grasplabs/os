import { readAtMost } from "@grasp-os/shared/http";
import { log } from "@grasp-os/shared/log";
import {
  inboundEmailMaxBytes,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import PostalMime from "postal-mime";
import type { Attachment, Email } from "postal-mime";

// A message with attachments that an email trigger received
// (inbound-email.ts) is kept, so its runs can read them (`keptMessage` and `attachmentOf`, through
// workflows/host.ts): its bytes as they arrived, in R2 (`FILES`, in the
// EU), for the App whose runs it starts, before any starts, under the UTC
// day it was kept, the App and its ID. The run's input names it by day and
// ID (`stored`), never the App: a run reads only what its own App
// received, so a name another App's run passes finds nothing. A message
// with no attachment but inline ones (images in its HTML, say), or one
// received while the feature is off, isn't kept (`stored: null`). Only its
// day's name says when a message goes: the 15-minute cron trigger deletes
// a day's messages once 30 days have passed since that day ended
// (`deleteExpiredEmail`), so a message is kept 30 to 31 days.
//
// An attachment is read by its index in the run's input, which lists the
// message's attachments in the order postal-mime gives them when the
// message arrives; a read parses the kept bytes again with the same
// parser, so the order is the same as long as postal-mime's is.

/** Where kept messages are, in `FILES`: by day, then App, then ID. */
const keptPrefix = "inbound-email/";

/** How many days a kept message is kept, at least (see above). */
const emailRetentionDays = 30;

const dayMs = 24 * 60 * 60 * 1000;

/** The UTC day of `time`, as `2026-09-29`. */
const dayOf = (time: Date): string => time.toISOString().slice(0, 10);

/** The first day whose messages are still kept at `now`. */
const firstKeptDay = (now: Date): string =>
  dayOf(new Date(now.getTime() - emailRetentionDays * dayMs));

/** The key of message `stored` (`day/id`) kept for `app`. */
const keptKey = (app: string, stored: string): string => {
  const [day, id] = stored.split("/");
  return `${keptPrefix}${day}/${app}/${id}`;
};

/** The most kept messages one cron run deletes: one R2 list and delete. */
const maxDeletedPerRun = 1000;

/** `raw` parsed, or undefined for a message that doesn't parse. */
export const parsedOf = async (raw: Uint8Array): Promise<Email | undefined> => {
  try {
    return await PostalMime.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * Whether a message with these attachments is kept: it has one that isn't
 * inline. Its runs' input lists them all, inline ones too, so an index
 * means the same whether or not it's kept.
 */
export const isWorthKeeping = (attachments: readonly Attachment[]): boolean =>
  attachments.some(({ disposition }) => disposition !== "inline");

/**
 * Keeps message `id` (`raw`, its bytes) for each of `appIds`, today, and
 * returns what its runs' input names it by; null when there are no Apps
 * to keep it for.
 */
export const keepMessage = async (
  env: Env,
  appIds: readonly string[],
  id: string,
  raw: Uint8Array
): Promise<string | null> => {
  if (appIds.length === 0) {
    return null;
  }
  const stored = `${dayOf(new Date())}/${id}`;
  await Promise.all(
    [...new Set(appIds)].map(
      async (appId) => await env.FILES.put(keptKey(appId, stored), raw)
    )
  );
  return stored;
};

/**
 * Message `stored` (`day/id`) as `app` received it, parsed from the kept
 * bytes, counted as they're read (never by the size R2 reports). Refuses
 * with `workflow.attachment_not_found` when `app` has no such message
 * (never kept for it, or deleted), and with `workflow.attachment_unreadable`
 * when what's kept is over the limit or doesn't parse any more (a newer
 * parser, say): trying again wouldn't change either.
 */
export const keptMessage = async (
  env: Env,
  app: string,
  stored: string
): Promise<Email> => {
  const object = await env.FILES.get(keptKey(app, stored));
  if (object === null) {
    throw workflowErrors.create("workflow.attachment_not_found");
  }
  const body = object.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>()
  );
  const raw = await readAtMost(body, inboundEmailMaxBytes);
  const parsed = raw === undefined ? undefined : await parsedOf(raw);
  if (parsed === undefined) {
    log.error("workflow.email_unreadable", { app, stored });
    throw workflowErrors.create("workflow.attachment_unreadable");
  }
  return parsed;
};

/**
 * The content of attachment `index` of `message`, as bytes; refuses with
 * `workflow.attachment_not_found` for an index it has no attachment at.
 */
export const attachmentOf = (message: Email, index: number): Uint8Array => {
  const attachment = message.attachments[index];
  if (attachment === undefined) {
    throw workflowErrors.create("workflow.attachment_not_found");
  }
  const { content } = attachment;
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
};

/**
 * Deletes kept messages once their days are over: up to
 * `maxDeletedPerRun` of the oldest day's at `now`, so a day of any size is
 * gone within a few runs, and days missed (an outage) one after another.
 * R2 lists a day only while it holds a message.
 */
export const deleteExpiredEmail = async (
  env: Env,
  now: Date
): Promise<void> => {
  const { delimitedPrefixes } = await env.FILES.list({
    prefix: keptPrefix,
    delimiter: "/",
  });
  const firstKept = `${keptPrefix}${firstKeptDay(now)}/`;
  const [oldest] = delimitedPrefixes.toSorted();
  if (oldest === undefined || oldest >= firstKept) {
    return;
  }
  const { objects } = await env.FILES.list({
    prefix: oldest,
    limit: maxDeletedPerRun,
  });
  if (objects.length === 0) {
    return;
  }
  await env.FILES.delete(objects.map(({ key }) => key));
  log.info("workflow.email_deleted", {
    day: oldest.slice(keptPrefix.length, -1),
    messages: objects.length,
  });
};
