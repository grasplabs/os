import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
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
    migrateOnWake(ctx, migrations);
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

  // Restricted mode of a chat (see restricted.ts). A chat that isn't here
  // has nowhere to keep it, so both throw for one, and whatever asked is
  // refused.

  /** Whether the chat has read restricted data. */
  isChatRestricted(chatId: ChatId): boolean {
    const chat = this.#db
      .select({ restricted: chats.restricted })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
    if (!chat) {
      throw new Error("No such chat in this workspace");
    }
    return chat.restricted;
  }

  /** Puts the chat in restricted mode, for good. */
  restrictChat(chatId: ChatId): void {
    const changed = this.#db
      .update(chats)
      .set({ restricted: true })
      .where(eq(chats.id, chatId))
      .returning({ id: chats.id })
      .all();
    if (changed.length === 0) {
      throw new Error("No such chat in this workspace");
    }
  }
}

/** A workspace's object. */
export const workspace = (
  env: Env,
  id: WorkspaceId
): DurableObjectStub<Workspace> =>
  inJurisdiction(env, env.WORKSPACES).getByName(id);
