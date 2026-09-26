import { auditLogger } from "@grasp-os/shared/audit";
import type { AuditLogger } from "@grasp-os/shared/audit";

/** Records audit events from core: `await audit(env).log({ ... })`. */
export const audit = (env: Pick<Env, "AUDIT_QUEUE">): AuditLogger =>
  auditLogger(env.AUDIT_QUEUE, "core");
