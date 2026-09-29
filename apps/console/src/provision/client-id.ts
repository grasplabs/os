/**
 * What's wrong with a client id staff typed, in words, checked with the
 * same rule the server applies (`newClientIdSchema`), so the form says so
 * before it sends anything.
 */
import { newClientIdSchema, reservedClientIds } from "@grasp-os/shared/router";

/** Why `id` can't be a client's id, or null when it can. */
export const clientIdProblem = (id: string): string | null => {
  if (newClientIdSchema.safeParse(id).success) {
    return null;
  }
  if (reservedClientIds.has(id)) {
    return `${id} is reserved for the platform's own hostnames (${[...reservedClientIds].join(", ")}): pick another.`;
  }
  return "A client id is its hostname: lowercase letters, digits and dashes, at most 50, starting and ending with a letter or digit.";
};
