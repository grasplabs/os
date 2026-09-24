import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";

import { auditLog } from "./audit-log.ts";

/**
 * Consumes the audit queue. Valid events are appended in one call and
 * acknowledged; malformed ones are retried until they reach the dead letter
 * queue, where they stay for inspection. If the append fails, the whole batch
 * is retried; the log dedupes by event id.
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
      message.retry();
    }
  }
  if (valid.length === 0) {
    return;
  }
  await auditLog(env).append(valid.map(({ event }) => event));
  for (const { message } of valid) {
    message.ack();
  }
};
