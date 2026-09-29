import type { Message } from "@earendil-works/pi-ai";
import { agentErrors } from "@grasp-os/shared/agent";
import {
  auditProvenanceMaxItems,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import { featureErrors } from "@grasp-os/shared/errors";
import {
  chatIdSchema,
  identifierSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { DurableObject } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { agentApis } from "./agent-apis.ts";
import { auditAgentCall, chatAuthority, chatContext } from "./agent-scope.ts";
import type { CodeRunCall } from "./agent-scope.ts";
import { isMessage, runTurn } from "./agent.ts";
import type { TurnContext, TurnResult } from "./agent.ts";
import { memberRole } from "./auth/identity.ts";
import { codeLimits } from "./code-mode.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/workspace/migrations/migrations.js";
import { chatMessages, chatSources, chats } from "./db/workspace/schema.ts";
import { featureEnabled, requireFeature } from "./features.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { forContext } from "./knowledge/memory.ts";
import { catalog, noteListedSkills } from "./knowledge/tools.ts";
import { models } from "./models.ts";
import type { WorkContext } from "./restricted.ts";

export type Chat = typeof chats.$inferSelect;

/** A question for a chat's agent, and the model to answer it with. */
const questionSchema = z.strictObject({
  text: z.string().trim().min(1).max(100_000),
  /** `<provider>/<model>`, one the deployment allows. */
  model: z.string().min(1),
});
export type Question = z.input<typeof questionSchema>;

/**
 * What an answer may hold, as the person sees it labelled: everything the
 * chat has read from (collections and connections), and whether it read
 * restricted data, so the answer may carry sensitive content.
 */
export interface AnswerProvenance {
  sources: string[];
  restricted: boolean;
}

/** A turn's result, labelled with what it may hold. */
export type Answer = TurnResult & { provenance: AnswerProvenance };

/**
 * A stored message, as pi shapes it. Stored by this object only, so the
 * shape is checked as far as telling the roles apart.
 */
const storedMessageSchema = z.custom<Message>(
  (value) => typeof value === "object" && value !== null && isMessage(value)
);

/**
 * Most characters a chat's transcript may hold: a chat past it takes no
 * more questions, so loading one never parses more than this and one turn.
 * The model reads only its most recent part (`recentHistory` in agent.ts).
 */
export const maxChatChars = 4_000_000;

/**
 * Most ended code runs an object remembers, to refuse and log a call from
 * one: a few turns' worth (at most 30 runs each).
 */
const endedRunsKept = 1000;

/**
 * The sources one API call of a code run read from, as it records them:
 * a few collections or a connection, each an identifier.
 */
const sourcesSchema = z.array(identifierSchema).max(auditProvenanceMaxItems);

/** A person's or team's workspace: chats and the Code Mode agent on Pi. */
export class Workspace extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  /**
   * The turns running now, by chat, to cancel them. Only in memory: a turn
   * ends with the object, and the chat goes on from what it stored.
   */
  readonly #turns = new Map<ChatId, AbortController>();

  /**
   * Code runs, as `<chat>/<run>`: the API calls an open run has made, or
   * that it ended (`reported` once a call after its end was logged). Their
   * stubs answer only while a run is open and has calls left. In memory, so
   * a restart ends every run. Ended runs are kept, oldest first, only up to
   * {@link endedRunsKept}: a run forgotten answers as ended, unlogged.
   */
  readonly #codeRuns = new Map<string, number | "ended" | "reported">();

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
   * request goes through the model gateway, and its rules, as the chat's
   * agent acting for the chat's person. One turn at a time per chat.
   */
  async ask(chatId: unknown, question: Question): Promise<Answer> {
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
    // Taken before the next await, so a second question waits its turn.
    const cancel = new AbortController();
    this.#turns.set(chat.id, cancel);
    try {
      if (this.#storedChars(chat.id) > maxChatChars) {
        throw agentErrors.create("agent.chat_full");
      }
      // The object is named after its workspace (`workspace` in
      // durable-objects.ts).
      const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
      const scope = { workspaceId, chatId: chat.id, personId };
      // The workspace's agent, acting for the chat's person, in this chat:
      // the audit log's actor, and the rules' context (its restricted mode).
      const authority = chatAuthority(scope);
      const work = chatContext(scope);
      // Before the model is admitted: what memory reads is a source too.
      const context = await this.#turnContext(scope, authority, work);
      // Refuses a model the deployment or its rules don't allow before
      // anything is kept. Every request carries everything the chat has
      // read from, in this turn and every one before it, read again for
      // each request: the rules judge it by all of it, so a later turn
      // can't send what an earlier one read to a model they forbid.
      const model = await models(this.env).agent(
        {
          model: parsed.data.model,
          purpose: "chat.turn",
          trigger: delegateActorOf(authority),
          provenance: this.#sources(chat.id),
          work: { authority, context: work },
        },
        () => this.#sources(chat.id)
      );
      const result = await runTurn({
        history: this.#transcript(chat.id),
        question: parsed.data.text,
        model,
        apis: agentApis(),
        context,
        scope,
        whyStop: async () => {
          if (!featureEnabled(this.env, "agent")) {
            return featureErrors.create("feature.disabled", {
              feature: "agent",
            });
          }
          return (await memberRole(this.env.DB, personId)) === undefined
            ? permissionErrors.create("permission.person_inactive")
            : undefined;
        },
        runs: {
          open: () => {
            const runId = crypto.randomUUID();
            this.#codeRuns.set(`${chat.id}/${runId}`, 0);
            return runId;
          },
          close: (runId) => {
            this.#endCodeRun(`${chat.id}/${runId}`);
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
      return {
        ...result,
        provenance: {
          sources: this.#sources(chat.id),
          restricted: this.isChatRestricted(chat.id) === true,
        },
      };
    } finally {
      this.#turns.delete(chat.id);
    }
  }

  /**
   * What the model reads this turn besides the question: the memory of the
   * person's own chat (the company's files and their USER.md, read now and
   * recorded as sources), and the skills in the chat's Knowledge catalog.
   */
  async #turnContext(
    scope: Parameters<typeof auditAgentCall>[1],
    authority: Parameters<typeof forContext>[1],
    work: Extract<WorkContext, { type: "chat" }>
  ): Promise<TurnContext> {
    const memory = await forContext(this.env, authority, work, {
      type: "own",
    });
    this.#keepSources(work.chatId, memory.provenance.collectionIds);
    if (!featureEnabled(this.env, "knowledge")) {
      return { memory, skills: [] };
    }
    // The skills listed go into the prompt: a read of their collections,
    // noted as any Knowledge read is (restricting the chat first were any
    // sensitive), and carried as the chat's sources like memory.
    const { collections, skills, listed } = await readAsDelegate(
      this.env,
      authority,
      work,
      undefined,
      async (reader) => {
        const found = await catalog(this.env, reader);
        return {
          ...found,
          listed: await noteListedSkills(this.env, reader, found.skills),
        };
      }
    );
    this.#keepSources(work.chatId, listed.collectionIds);
    // Recorded as the code's catalog call is: what the agent saw listed.
    await auditAgentCall(this.env, scope, {
      method: "knowledge.catalog",
      detail: {
        collections: collections.length,
        skills: skills.length,
        turn: true,
      },
    });
    return { memory, skills };
  }

  /** Marks a code run ended, and forgets the oldest ended runs past the cap. */
  #endCodeRun(key: string): void {
    // Moved to the end, so the map keeps ended runs oldest first.
    this.#codeRuns.delete(key);
    this.#codeRuns.set(key, "ended");
    const ended = [...this.#codeRuns.keys()].filter(
      (run) => typeof this.#codeRuns.get(run) !== "number"
    );
    const [oldest] = ended;
    if (ended.length > endedRunsKept && oldest !== undefined) {
      this.#codeRuns.delete(oldest);
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

  /**
   * Counts one API call of a code run of the chat, and says whether it may
   * go on (see agent-apis.ts): `open` while the run is open and has made
   * fewer than {@link codeLimits}' `subRequests` calls, `spent` past that,
   * and `ended` once the run has ended, or for a run this object doesn't
   * know (one from before a restart). A call after a run's end is logged
   * once per run.
   */
  callFromCodeRun(chatId: ChatId, runId: string): CodeRunCall {
    const key = `${chatId}/${runId}`;
    const state = this.#codeRuns.get(key);
    if (typeof state === "number") {
      if (state >= codeLimits.subRequests) {
        // Counted once past the most, so only the first refusal says so.
        this.#codeRuns.set(key, codeLimits.subRequests + 1);
        return { call: "spent", first: state === codeLimits.subRequests };
      }
      this.#codeRuns.set(key, state + 1);
      return { call: "open", first: false };
    }
    if (state === "ended") {
      // Code still acting after its run ended: worth seeing in the logs.
      log.warn("agent.run_ended", { chatId, runId });
      this.#codeRuns.set(key, "reported");
      return { call: "ended", first: true };
    }
    return { call: "ended", first: false };
  }

  /**
   * Records what an API call of a code run of the chat read from (see
   * agent-apis.ts), before the call hands over what it read: `false`, and
   * nothing recorded, once the run has ended, so the call must not hand it
   * over. Each source is kept once, for good; every later model request of
   * the chat carries them all.
   */
  recordSources(
    chatId: ChatId,
    runId: string,
    ids: readonly string[]
  ): boolean {
    if (typeof this.#codeRuns.get(`${chatId}/${runId}`) !== "number") {
      return false;
    }
    this.#keepSources(chatId, sourcesSchema.parse(ids));
    return true;
  }

  /** Keeps `sources` with the chat, each once, for good. */
  #keepSources(chatId: ChatId, sources: readonly string[]): void {
    if (sources.length === 0) {
      return;
    }
    const createdAt = new Date();
    this.#db
      .insert(chatSources)
      .values(sources.map((sourceId) => ({ chatId, sourceId, createdAt })))
      .onConflictDoNothing()
      .run();
  }

  /** Everything the chat has read from, as `recordSources` kept it. */
  #sources(chatId: ChatId): string[] {
    return this.#db
      .select({ sourceId: chatSources.sourceId })
      .from(chatSources)
      .where(eq(chatSources.chatId, chatId))
      .all()
      .map(({ sourceId }) => sourceId);
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

  #storedChars(chatId: ChatId): number {
    const [row] = this.ctx.storage.sql
      .exec<{ chars: number }>(
        "SELECT coalesce(sum(length(message)), 0) AS chars FROM chat_messages WHERE chat_id = ?",
        chatId
      )
      .toArray();
    return row?.chars ?? 0;
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
