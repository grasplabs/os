import { auditLogger } from "@grasp-os/shared/audit";
import type { AuditActor, AuditLogger } from "@grasp-os/shared/audit";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";

/** Records audit events from core: `await audit(env).log({ ... })`. */
export const audit = (env: Pick<Env, "AUDIT_QUEUE">): AuditLogger =>
  auditLogger(env.AUDIT_QUEUE, "core");

/** A signed-in person as the audit log names them: staff apart. */
export const actorOf = ({
  userId,
  staff,
}: Pick<Identity, "userId" | "staff">): AuditActor =>
  staff ? { type: "staff", userId } : { type: "person", userId };

/** An App or agent, acting for a person, as the audit log names it. */
export const delegateActorOf = ({
  subject,
  onBehalfOf,
}: Authority): AuditActor =>
  subject.type === "agent"
    ? { type: "agent", agentId: subject.agentId, onBehalfOf }
    : { type: "app", appId: subject.appId, part: "server" };
