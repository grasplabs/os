import { auditLogger } from "@grasp-os/shared/audit";
import type { AuditActor, AuditLogger } from "@grasp-os/shared/audit";
import type { Identity } from "@grasp-os/shared/rpc";

/** Records audit events from core: `await audit(env).log({ ... })`. */
export const audit = (env: Env): AuditLogger =>
  auditLogger(env.AUDIT_QUEUE, "core");

/** A signed-in person as the audit log names them: staff apart. */
export const actorOf = ({ userId, staff }: Identity): AuditActor =>
  staff ? { type: "staff", userId } : { type: "person", userId };
