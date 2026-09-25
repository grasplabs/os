import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";

import { auditLog } from "./audit-log.ts";
import { errorFields, log } from "./log.ts";

/**
 * Consumes the audit queue. Valid events are appended in one call and
 * acknowledged; malformed ones are retried until they reach the dead letter
 * queue, where they stay for inspection. If the append fails, the valid
 * events are retried; the log dedupes by event id. Logs its own outcome, as
 * the platform's invocation logs are off.
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
    await auditLog(env).append(valid.map(({ event }) => event));
  } catch (error) {
    log.error("audit.append_failed", {
      events: valid.length,
      ...errorFields(error),
    });
    for (const { message } of valid) {
      message.retry();
    }
    return;
  }
  for (const { message } of valid) {
    message.ack();
  }
  log.info("audit.appended", { events: valid.length });
};
