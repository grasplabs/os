import { chatIdSchema } from "@grasp-os/shared/ids";
import type { WorkspaceId } from "@grasp-os/shared/ids";
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";

import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/workspace/migrations/migrations.js";
import { chats } from "./db/workspace/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";

export type Chat = typeof chats.$inferSelect;

/** A person's or team's workspace: chats and the Code Mode agent on Pi. */
export class Workspace extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void migrateOnWake(ctx, migrations);
  }

  createChat(title: string): Chat {
    return this.#db
      .insert(chats)
      .values({
        id: chatIdSchema.parse(crypto.randomUUID()),
        title,
        createdAt: new Date(),
      })
      .returning()
      .get();
  }
}

/** A workspace's object. */
export const workspace = (
  env: Env,
  id: WorkspaceId
): DurableObjectStub<Workspace> =>
  inJurisdiction(env, env.WORKSPACES).getByName(id);
