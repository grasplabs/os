import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

/** Roles a person can have inside a deployment (from Better Auth). */
export const roleSchema = z.enum(["admin", "builder", "user"]);
export type Role = z.infer<typeof roleSchema>;

// What each role may do, as allow-lists: a role not named here, such as
// one added later or one a membership row holds by mistake, gets nothing.

/** Admins: manage members, teams and permissions. */
export const isAdmin = (role: string): boolean => role === "admin";

/** Admins and builders: build Apps and ask for the permissions they need. */
export const canBuild = (role: string): boolean =>
  role === "admin" || role === "builder";

/** Why a call was refused for the caller's role. */
export const roleErrors = defineErrorFamily({
  "role.forbidden": "Your role doesn't allow that.",
});
