import { z } from "zod";

/** Roles a person can have inside a deployment (from Better Auth). */
export const roleSchema = z.enum(["admin", "builder", "user"]);
export type Role = z.infer<typeof roleSchema>;

/** Roles a person can have on a single App. */
export const appRoleSchema = z.enum(["builder", "user"]);
export type AppRole = z.infer<typeof appRoleSchema>;

/** The four states of one workflow. */
export const workflowStateSchema = z.enum([
  "drawn",
  "designed",
  "compiled",
  "running",
]);
export type WorkflowState = z.infer<typeof workflowStateSchema>;

/** A connection runs with the user's own login, or a shared service account. */
export const connectionScopeSchema = z.enum(["personal", "shared"]);
export type ConnectionScope = z.infer<typeof connectionScopeSchema>;
