import { auditLogger } from "@grasp-os/shared/audit";
import type { AuditLogger } from "@grasp-os/shared/audit";

/** Records audit events from connect: `await audit(env).log({ ... })`. */
export const audit = (env: Env): AuditLogger =>
  auditLogger(env.AUDIT_QUEUE, "connect");
