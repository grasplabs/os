import type { Message } from "@earendil-works/pi-ai";
import { agentErrors } from "@grasp-os/shared/agent";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import type { ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { DurableObject } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { agentApis } from "./agent-apis.ts";
import { runTurn } from "./agent.ts";
import type { TurnResult } from "./agent.ts";
import { memberRole } from "./auth/identity.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/workspace/migrations/migrations.js";
import { chatMessages, chats } from "./db/workspace/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { requireFeature } from "./features.ts";
import { models } from "./models.ts";

export type Chat = typeof chats.$inferSelect;

/** A question for a chat's agent, and the model to answer it with. */
const questionSchema = z.strictObject({
  text: z.string().trim().min(1).max(100_000),
  /** `<provider>/<model>`, one the deployment allows. */
  model: z.string().min(1),
});
export type Question = z.input<typeof questionSchema>;

/**
 * A stored message, as pi shapes it. Stored by this object only, so the
 * shape is checked as far as telling the roles apart.
 */
const storedMessageSchema = z.custom<Message>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    ["system", "user", "assistant", "toolResult"].includes(String(value.role))
);

/** A person's or team's workspace: chats and the Code Mode agent on Pi. */
export class Workspace extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  /**
   * The turns running now, by chat, to cancel them. Only in memory: a turn
   * ends with the object, and the chat goes on from what it stored.
   */
  readonly #turns = new Map<ChatId, AbortController>();

  /**
   * The code runs going on now, as `<chat>/<run>`: their stubs answer only
   * while they are here. In memory too, so a restart ends every run.
   */
  readonly #codeRuns = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
  }

  /** A new chat, which belongs to `personId`: its agent acts for them. */
  createChat(title: string, personId: string): Chat {
    return this.#db
      .insert(chats)
      .values({
        id: chatIdSchema.parse(crypto.randomUUID()),
        title,
        createdAt: new Date(),
        personId,
      })
      .returning()
      .get();
  }

  // Restricted mode of a chat (see restricted.ts). A chat that isn't here
  // has nowhere to keep it: both say so, and whatever asked is refused.

  /** Whether the chat has read restricted data; `undefined`: no such chat. */
  isChatRestricted(chatId: ChatId): boolean | undefined {
    const [chat] = this.#db
      .select({ restricted: chats.restricted })
      .from(chats)
      .where(eq(chats.id, chatId))
      .all();
    return chat?.restricted;
  }

  /** Puts the chat in restricted mode, for good; `false`: no such chat. */
  restrictChat(chatId: ChatId): boolean {
    const changed = this.#db
      .update(chats)
      .set({ restricted: true })
      .where(eq(chats.id, chatId))
      .returning({ id: chats.id })
      .all();
    return changed.length > 0;
  }

  /**
   * Asks the chat's agent a question and waits for its answer: the agent
   * loop runs here, its code runs in isolates of its own, and every model
   * request goes through the model gateway with the chat's person as the
   * one who asked. One turn at a time per chat.
   */
  async ask(chatId: unknown, question: Question): Promise<TurnResult> {
    requireFeature(this.env, "agent");
    const chat = this.#chat(chatId);
    const parsed = questionSchema.safeParse(question);
    if (!parsed.success) {
      throw agentErrors.create("agent.invalid_question");
    }
    // The agent acts for the chat's own person, as this object stored it,
    // never for whoever asks, and only while they are still a member.
    const { personId } = chat;
    if (personId === null) {
      throw agentErrors.create("agent.no_person");
    }
    if (!(await memberRole(this.env.DB, personId))) {
      throw permissionErrors.create("permission.person_inactive");
    }
    if (this.#turns.has(chat.id)) {
      throw agentErrors.create("agent.busy");
    }
    // Refuses a model the deployment doesn't allow before anything is kept.
    const model = models(this.env).agent({
      model: parsed.data.model,
      purpose: "chat.turn",
      trigger: { type: "person", userId: personId },
    });
    const cancel = new AbortController();
    this.#turns.set(chat.id, cancel);
    try {
      return await runTurn({
        history: this.#transcript(chat.id),
        question: parsed.data.text,
        model,
        apis: agentApis(),
        scope: {
          // The object is named after its workspace (see `workspace`).
          workspaceId: workspaceIdSchema.parse(this.ctx.id.name),
          chatId: chat.id,
          personId,
        },
        runs: {
          open: () => {
            const runId = crypto.randomUUID();
            this.#codeRuns.add(`${chat.id}/${runId}`);
            return runId;
          },
          close: (runId) => {
            this.#codeRuns.delete(`${chat.id}/${runId}`);
          },
        },
        loader: this.env.LOADER,
        signal: cancel.signal,
        keep: (message) => {
          this.#db
            .insert(chatMessages)
            .values({
              chatId: chat.id,
              message: JSON.stringify(message),
              createdAt: new Date(),
            })
            .run();
        },
      });
    } finally {
      this.#turns.delete(chat.id);
    }
  }

  /**
   * Stops the chat's running turn, if there is one: the model request or
   * code run in flight ends, and the turn answers `cancelled`.
   */
  cancel(chatId: unknown): boolean {
    const turn = this.#turns.get(this.#chat(chatId).id);
    turn?.abort();
    return turn !== undefined;
  }

  /** Whether a code run of the chat is still going on (see agent-apis.ts). */
  isCodeRunOpen(chatId: ChatId, runId: string): boolean {
    return this.#codeRuns.has(`${chatId}/${runId}`);
  }

  /** The chat's transcript, oldest first. */
  messages(chatId: unknown): Message[] {
    return this.#transcript(this.#chat(chatId).id);
  }

  #chat(chatId: unknown): Chat {
    const id = chatIdSchema.safeParse(chatId);
    const chat = id.success
      ? this.#db.select().from(chats).where(eq(chats.id, id.data)).get()
      : undefined;
    if (chat === undefined) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return chat;
  }

  #transcript(chatId: ChatId): Message[] {
    return this.#db
      .select({ message: chatMessages.message })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(asc(chatMessages.id))
      .all()
      .map(({ message }) => storedMessageSchema.parse(JSON.parse(message)));
  }
}

/** A workspace's object. */
export const workspace = (
  env: Env,
  id: WorkspaceId
): DurableObjectStub<Workspace> =>
  inJurisdiction(env, env.WORKSPACES).getByName(id);
