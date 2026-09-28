/**
 * Rotating a client's derived secrets: raising its generation
 * (src/deploy/secrets.ts). The next deploy gives its Workers the new
 * secrets, and for `rotationWindowMs` the previous ones where a Worker
 * takes them. So a rotation is refused while the last one's window is
 * open: the previous values would be the ones still in use.
 */
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { actIfChanged } from "../db/act.ts";
import type { Actor, ConsoleDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { rotationWindowMs } from "./secrets.ts";

/**
 * Raises client `clientId`'s secrets generation, audited, unless its last
 * rotation was less than `rotationWindowMs` before `now`. Returns whether
 * it did. Everyone signs in again once the next deploy is live.
 */
export const rotateClientSecrets = async (
  db: ConsoleDatabase,
  actor: Actor,
  clientId: string,
  now: Date
): Promise<boolean> =>
  await actIfChanged(
    db,
    actor,
    db
      .update(clients)
      .set({
        generation: sql`${clients.generation} + 1`,
        rotatedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(clients.id, clientId),
          or(
            isNull(clients.rotatedAt),
            lte(clients.rotatedAt, new Date(now.getTime() - rotationWindowMs))
          )
        )
      ),
    { action: "client.rotate_secrets", clientId }
  );
