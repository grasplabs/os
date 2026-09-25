import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";

import { auditLog } from "./audit-log.ts";
import type { AppendResult } from "./audit-log.ts";
import { errorFields, log } from "./log.ts";

/** First retry delay; doubles with each attempt. */
const retryBaseSeconds = 10;
/** Longest retry delay, so ten attempts span hours rather than days. */
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
 * Consumes the audit queue. Valid events are appended in one call and
 * acknowledged; malformed ones are retried until they reach the dead letter
 * queue, where they stay for inspection. If the batch append fails, the
 * events are appended one at a time. The log dedupes by event ID, so a
 * redelivered event is acknowledged without being appended again. Logs its
 * own outcome, as the platform's invocation logs are off.
 */
export const consumeAuditQueue = async (
  batch: MessageBatch,
  env: Env
): Promise<void> => {
  const valid: Valid[] = [];
  for (const message of batch.messages) {
    const parsed = auditEventSchema.safeParse(message.body);
    if (parsed.success) {
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
