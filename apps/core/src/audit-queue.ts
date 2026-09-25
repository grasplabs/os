import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";

import { auditLog } from "./audit-log.ts";
import { errorFields, log } from "./log.ts";

/**
 * Consumes the audit queue. Valid events are appended in one call and
 * acknowledged; malformed ones are retried until they reach the dead letter
 * queue, where they stay for inspection. If the append fails, the valid
 * events are retried; the log dedupes by event id, so a redelivered event is
 * acknowledged without being appended again. Logs its own outcome, as the
 * platform's invocation logs are off.
 */
export const consumeAuditQueue = async (
  batch: MessageBatch,
  env: Env
): Promise<void> => {
  const valid: { event: AuditEvent; message: Message }[] = [];
  for (const message of batch.messages) {
    const parsed = auditEventSchema.safeParse(message.body);
    if (parsed.success) {
      valid.push({ event: parsed.data, message });
    } else {
      log.warn("audit.malformed", {
        messageId: message.id,
        attempts: message.attempts,
      });
      message.retry();
    }
  }
  if (valid.length === 0) {
    return;
  }
  try {
    const { appended, duplicates } = await auditLog(env).append(
      valid.map(({ event }) => event)
    );
    for (const { message } of valid) {
      message.ack();
    }
    log.info("audit.appended", { events: appended, duplicates });
  } catch (error) {
    log.error("audit.append_failed", {
      events: valid.length,
      ...errorFields(error),
    });
    for (const { message } of valid) {
      message.retry();
    }
  }
};
