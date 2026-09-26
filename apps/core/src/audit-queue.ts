import { auditEventSchema, isAuditEventTooLarge } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";

import { auditLog } from "./audit-log.ts";
import type { AppendResult } from "./audit-log.ts";

/** The audit queue's dead letter queue, as wrangler.jsonc names it. */
export const auditDeadLetterQueue = "grasp-os-audit-dlq";

/**
 * The dead letter queue consumer's `max_retries` in wrangler.jsonc: a
 * message is delivered once more than that, then dropped.
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

interface Valid {
  event: AuditEvent;
  message: Message;
}

const logAppended = ({ appended, duplicates, conflicts }: AppendResult) => {
  log.info("audit.appended", { events: appended, duplicates, conflicts });
};

/**
 * Appends events one at a time, after the batch as a whole failed, so one
 * event the log refuses can't hold back the others: each is acknowledged or
 * retried on its own.
 */
const appendOneByOne = async (valid: Valid[], env: Env): Promise<void> => {
  for (const { event, message } of valid) {
    try {
      // In order, as the batch would have been.
      // oxlint-disable-next-line no-await-in-loop
      logAppended(await auditLog(env).append([event]));
      message.ack();
    } catch (error) {
      log.error("audit.append_failed", {
        eventId: event.id,
        attempts: message.attempts,
        ...errorFields(error),
      });
      retryLater(message);
    }
  }
};

/**
 * Moves an event the log would refuse for its size straight to the dead
 * letter queue, which records it as lost (`consumeDeadLetters`): no retry
 * could ever append it. Retried as usual only if that send fails.
 */
const refuseOversized = async (
  { event, message }: Valid,
  env: Env
): Promise<void> => {
  log.error("audit.oversized", { eventId: event.id });
  try {
    await env.AUDIT_DLQ.send(message.body);
    message.ack();
  } catch (error) {
    log.error("audit.dead_letter_failed", {
      eventId: event.id,
      ...errorFields(error),
    });
    retryLater(message);
  }
};

/**
 * Consumes the dead letter queue: events the audit queue gave up on after
 * its retries, and those it moved there as too large (threat model AU4).
 * Every one raises an alert: an error log naming the message, and the
 * event when it is one. Those the log can take are appended late, and an
 * `audit.gap` after them records how many and which; those it never can
 * (malformed, too large) are counted in the gap as lost, their content
 * kept out of the chain and the logs alike, and so are conflicts: events
 * whose ID the log (or the batch) already has with other content. Only once the gap is recorded
 * is the batch acknowledged: while the log can't take it, it is retried,
 * so nothing leaves the dead letter queue unrecorded, until its last
 * attempt: a message that fails then is dropped by the queue, and logged
 * as `audit.dead_letter_dropped`. A batch redelivered after it was
 * recorded counts its lost ones again, never none.
 */
export const consumeDeadLetters = async (
  batch: MessageBatch,
  env: Env
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

/**
 * Consumes the audit queue. Valid events are appended in one call and
 * acknowledged; malformed ones are retried until they reach the dead letter
 * queue (`consumeDeadLetters`). Events over the log's size cap go there at
 * once. If the batch append fails, the events are appended one at
 * a time. The log dedupes by event ID, so a redelivered event is
 * acknowledged without being appended again. Logs its own outcome, as the
 * platform's invocation logs are off.
 */
export const consumeAuditQueue = async (
  batch: MessageBatch,
  env: Env
): Promise<void> => {
  const valid: Valid[] = [];
  for (const message of batch.messages) {
    const parsed = auditEventSchema.safeParse(message.body);
    if (!parsed.success) {
      log.warn("audit.malformed", {
        messageId: message.id,
        attempts: message.attempts,
      });
      retryLater(message);
    } else if (isAuditEventTooLarge(canonicalJson(parsed.data))) {
      // Rare, so one at a time.
      // oxlint-disable-next-line no-await-in-loop
      await refuseOversized({ event: parsed.data, message }, env);
    } else {
      valid.push({ event: parsed.data, message });
    }
  }
  if (valid.length === 0) {
    return;
  }
  try {
    logAppended(await auditLog(env).append(valid.map(({ event }) => event)));
    for (const { message } of valid) {
      message.ack();
    }
  } catch (error) {
    log.warn("audit.batch_append_failed", {
      events: valid.length,
      ...errorFields(error),
    });
    await appendOneByOne(valid, env);
  }
};
