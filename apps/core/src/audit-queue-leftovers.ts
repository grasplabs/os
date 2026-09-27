import { auditEventSchema, isAuditEventTooLarge } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";

import { auditLog } from "./audit-log.ts";
import type { AppendResult, AuditLogEnv } from "./audit-log.ts";

// Audit events an older release put on the audit queue or its dead letter
// queue just before this one replaced them. Nothing new goes on either, but
// their consumers stay registered to core (a deploy doesn't remove them),
// and so does the queue's config: retries, then the dead letter queue. The
// audit queue's events are appended; its malformed ones are retried until
// they reach the dead letter queue, whose consumer is the one the older
// release had, `audit.gap` and all. Remove this file, `AuditLog.recover`
// and the queues themselves in a later release.

/** The audit queue's dead letter queue, as the older release named it. */
export const auditDeadLetterQueue = "grasp-os-audit-dlq";

/**
 * The dead letter queue consumer's `max_retries` in the older release's
 * wrangler.jsonc: a message is delivered once more than that, then dropped.
 */
const deadLetterMaxRetries = 100;

/** First retry delay; doubles with each attempt. */
const retryBaseSeconds = 10;
/**
 * Longest retry delay: the audit queue's ten retries span hours, and the
 * dead letter queue's hundred about two days.
 */
const retryMaxSeconds = 30 * 60;

/** Retries a message later, backing off as its attempts add up. */
const retryLater = (message: Message): void => {
  message.retry({
    delaySeconds: Math.min(
      retryMaxSeconds,
      retryBaseSeconds * 2 ** Math.max(0, message.attempts - 1)
    ),
  });
};

const logAppended = ({ appended, duplicates, conflicts }: AppendResult) => {
  log.info("audit.appended", { events: appended, duplicates, conflicts });
};

/**
 * Consumes the audit queue: valid events are appended in one call, which
 * the log dedupes, and acknowledged; malformed or oversized ones are
 * retried until they reach the dead letter queue (`consumeDeadLetters`). A
 * batch the log can't take throws, and the queue delivers it again.
 */
const consumeAuditQueue = async (
  batch: MessageBatch,
  env: AuditLogEnv
): Promise<void> => {
  const valid: { event: AuditEvent; message: Message }[] = [];
  for (const message of batch.messages) {
    const parsed = auditEventSchema.safeParse(message.body);
    if (parsed.success && !isAuditEventTooLarge(canonicalJson(parsed.data))) {
      valid.push({ event: parsed.data, message });
    } else {
      log.warn("audit.malformed", {
        messageId: message.id,
        attempts: message.attempts,
      });
      retryLater(message);
    }
  }
  if (valid.length === 0) {
    return;
  }
  logAppended(await auditLog(env).append(valid.map(({ event }) => event)));
  for (const { message } of valid) {
    message.ack();
  }
};

/**
 * Consumes the dead letter queue: events the audit queue gave up on after
 * its retries. Every one raises an alert: an error log naming the message,
 * and the event when it is one. Those the log can take are appended late,
 * and an `audit.gap` after them records how many and which; those it never
 * can (malformed, too large) are counted in the gap as lost, their content
 * kept out of the chain and the logs alike, and so are conflicts: events
 * whose ID the log (or the batch) already has with other content. Only once
 * the gap is recorded is the batch acknowledged: while the log can't take
 * it, it is retried, so nothing leaves the dead letter queue unrecorded,
 * until its last attempt: a message that fails then is dropped by the
 * queue, and logged as `audit.dead_letter_dropped`.
 */
const consumeDeadLetters = async (
  batch: MessageBatch,
  env: AuditLogEnv
): Promise<void> => {
  const recovered: AuditEvent[] = [];
  const eventIds = new Map<Message, string | undefined>();
  let lost = 0;
  for (const message of batch.messages) {
    const parsed = auditEventSchema.safeParse(message.body);
    const event = parsed.success ? parsed.data : undefined;
    eventIds.set(message, event?.id);
    log.error("audit.dead_lettered", {
      messageId: message.id,
      attempts: message.attempts,
      eventId: event?.id,
    });
    if (event === undefined || isAuditEventTooLarge(canonicalJson(event))) {
      lost += 1;
    } else {
      recovered.push(event);
    }
  }
  try {
    logAppended(await auditLog(env).recover(recovered, lost));
    for (const message of batch.messages) {
      message.ack();
    }
  } catch (error) {
    log.error("audit.recovery_failed", {
      messages: batch.messages.length,
      ...errorFields(error),
    });
    for (const message of batch.messages) {
      if (message.attempts > deadLetterMaxRetries) {
        log.error("audit.dead_letter_dropped", {
          messageId: message.id,
          eventId: eventIds.get(message),
        });
      }
      retryLater(message);
    }
  }
};

/** Consumes a batch from either queue an older release left. */
export const consumeLeftoverAuditQueue = async (
  batch: MessageBatch,
  env: AuditLogEnv
): Promise<void> => {
  await (batch.queue === auditDeadLetterQueue
    ? consumeDeadLetters(batch, env)
    : consumeAuditQueue(batch, env));
};
