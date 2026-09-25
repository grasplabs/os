import { z } from "zod";

/** Roles a person can have inside a deployment (from Better Auth). */
export const roleSchema = z.enum(["admin", "builder", "user"]);
export type Role = z.infer<typeof roleSchema>;
