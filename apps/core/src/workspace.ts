import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import {
  auditProvenanceMaxItems,
  createAuditEvent,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
} from "@grasp-os/shared/audit";
import type {
  ChatDraft,
  ChatMessage,
  ChatProvenance,
  ChatSummary,
} from "@grasp-os/shared/chat";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import {
  featureErrors,
  internalErrors,
  isExpectedError,
  withReference,
} from "@grasp-os/shared/errors";
import {
  appIdSchema,
  chatIdSchema,
  identifierSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import {
  permissionActionSchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { ScreenProblem } from "@grasp-os/shared/screens";
import type { RunFailure } from "@grasp-os/shared/workflows";
import { DurableObject } from "cloudflare:workers";
import { and, asc, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { agentApis } from "./agent-apis.ts";
import {
  auditAgentCall,
  chatAuthority,
  chatContext,
  workspaceAgentIdSchema,
} from "./agent-scope.ts";
import type { CodeRunCall } from "./agent-scope.ts";
import { isMessage, runTurn } from "./agent.ts";
import type { TurnContext, TurnResult } from "./agent.ts";
import type { AppAnswer } from "./app.ts";
import { drainObjectOutbox } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import { chatMessageOf, partialOf } from "./chat-messages.ts";
import { ChatWatch } from "./chat-watch.ts";
import type { ChatListener, ChatState } from "./chat-watch.ts";
import { codeLimits } from "./code-mode.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/workspace/migrations/migrations.js";
import {
  auditOutbox,
  chatAttachments,
  chatDraftFiles,
  chatDrafts,
  chatMessages,
  chatSources,
  chats,
} from "./db/workspace/schema.ts";
import { featureEnabled, requireFeature } from "./features.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { forContext } from "./knowledge/memory.ts";
import { catalog, noteListedSkills } from "./knowledge/tools.ts";
import { gatewaySettings, models } from "./models.ts";
import { PreviewReports, serverProblem } from "./preview-reports.ts";
import type { PreviewOutcome } from "./preview-reports.ts";
import { Previews } from "./preview.ts";
import type { WorkContext } from "./restricted.ts";

export type Chat = typeof chats.$inferSelect;

/**
 * A chat's draft of an App (agent-builds.ts): the version it started
 * from, and the changes its agent wrote over it, by path (null deletes a
 * file). `revision` is 0 while there is none.
 */
export interface Draft {
  base: number | null;
  changes: Record<string, string | null>;
  revision: number;
}

/**
 * What a chat's agent spent building Apps this turn (agent-builds.ts):
 * the Apps it created, and for each App's draft the checks that failed in
 * a row and those running now.
 */
interface TurnBuilds {
  created: number;
  drafts: Map<string, { failed: number; running: number }>;
}

/**
 * A failed run a new chat's agent is asked to fix (`fixRun` in
 * chats-rpc.ts): its report, attached to the chat as data, and what the
 * report may hold data from, which the chat carries from the start.
 */
export interface RunToFix {
  report: RunFailure;
  /** The run, and every source its App may have read (app-provenance.ts). */
  sources: string[];
  /** Whether the run's App is restricted: then the chat is, from the start. */
  restricted: boolean;
}

/** A question for a chat's agent, and the model to answer it with. */
export const questionSchema = z.strictObject({
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
 * A failure report attached to a chat (`attachments`), as this object
 * stored it: checked as far as being an object.
 */
const storedReportSchema = z.custom<RunFailure>(
  (value) => typeof value === "object" && value !== null
);

/** The message a watcher saw last: none (`null`), or a stored one's ID. */
const afterSchema = z.int().nonnegative().nullable();

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

/**
 * Most chats a person's list shows: their newest. Older ones are still
 * there, and open from a link.
 */
export const listedChats = 200;

/**
 * Most watchers one Workspace object keeps at once: a person's own object
 * holds their chats alone, so this bounds what their pages make it hold,
 * and nobody else's.
 */
const maxWatchers = 50;

/**
 * How long the object waits to deliver its audit events again while the
 * log is out of reach: at first, and at most, doubling in between.
 */
const auditRetryMs = { first: 5000, most: 15 * 60 * 1000 };

/** Most chats a person keeps: delete one to make another. */
export const maxChatsPerPerson = 500;

/**
 * Why a turn under way stopped short of an answer, as its person reads
 * it: an unplanned error is logged, and shown as one, with the log line's
 * request ID for them to quote.
 */
const stopReason = (chatId: ChatId, error: unknown): string => {
  if (isExpectedError(error)) {
    return error.message;
  }
  const requestId = crypto.randomUUID();
  log.error("agent.turn_failed", { requestId, chatId, ...errorFields(error) });
  return withReference(
    internalErrors.create("internal.unexpected").message,
    requestId
  );
};

/**
 * Marks a chat's turn as under way in the object's storage, as
 * `turn:<chat>`: what memory forgets when the object restarts (a deploy,
 * say), so the next wake can say the turn was cut short. The mark holds
 * the ID of the chat's last message when the turn was taken (0: none), so
 * the wake knows what the turn itself stored.
 */
const turnKeyPrefix = "turn:";

/**
 * What a chat says in place of the answer a restart cut short: the person
 * reads it, and so does the agent on the next turn. The agent's message,
 * in core's words: no model wrote it, so it names none and cost nothing.
 */
const interruptedMessage = (): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "text",
      text: "I was interrupted before I finished, so what I was doing may be incomplete. Ask again and I'll go on from here.",
    },
  ],
  api: "grasp",
  provider: "grasp",
  model: "grasp",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

/** How a write a chat's agent had held for its person ended. */
export type HeldOutcome = "confirmed" | "declined" | "failed";

/** A held write, as its chat's agent knows it: the ID its call answered with. */
const heldSchema = z.strictObject({
  id: z.uuid(),
  action: permissionActionSchema,
});

/**
 * What the agent is told of each outcome. Nothing of the action's answer:
 * that is an outside system's data, which the agent reads as a call's
 * result (`env.connections.outcome`, which the note names), never as one
 * of its instructions. Each says not to ask for the write again: a repeat
 * would be another write.
 */
const heldOutcomes: Record<HeldOutcome, string> = {
  confirmed:
    "The person confirmed it and it was carried out. Don't ask for it again.",
  declined:
    "The person declined it: it was not carried out and won't be. Don't ask for it again unless they say so.",
  failed:
    "The person confirmed it, but carrying it out failed, so it may not have been done. It no longer waits for them; don't ask for it again unless they say so.",
};

/** A person's or team's workspace: chats and the Code Mode agent on Pi. */
export class Workspace extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  /**
   * The turns running now, by chat, to cancel them. Only in memory: a turn
   * ends with the object, and the chat goes on from what it stored. Each
   * is also marked in storage while it runs (`turnKeyPrefix`), so the wake
   * after a restart tells the chat its turn was cut short.
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

  /**
   * The response each chat's agent is writing now, as it streams in: what
   * a watcher sees of it before it is stored. In memory only, like turns.
   */
  readonly #partials = new Map<ChatId, AssistantMessage>();

  /**
   * Why each chat's last question stopped before the agent answered, when
   * it wasn't the model (see `ChatUpdate.stopped`). In memory only.
   */
  readonly #stopped = new Map<ChatId, string>();

  /**
   * Turns `send` started, each settled once its turn ends: the alarm waits
   * for them, so the object stays up while its agent works with nobody
   * waiting on a call.
   */
  readonly #sent = new Set<Promise<void>>();

  /**
   * Bumped whenever a chat's sources or restricted mode change, so a
   * watcher reads them again only then. In memory: a watcher starts with
   * none, so it reads them first.
   */
  readonly #provenanceVersions = new Map<ChatId, number>();

  /**
   * Chats being deleted (`deleteChat`): they take no question meanwhile.
   * In memory, for the one call that deletes: a restart ends that call.
   */
  readonly #deleting = new Set<ChatId>();

  /** How long the alarm waits before delivering audit events again. */
  #auditRetryMs = auditRetryMs.first;

  /**
   * Bumped whenever a chat's agent has a write held (`heldChanged`), so its
   * watchers read the held writes again. In memory only.
   */
  readonly #heldVersions = new Map<ChatId, number>();

  /**
   * What each chat's agent spent building Apps this turn: the repair
   * loop's count and the Apps it created (agent-builds.ts). In memory: a
   * restart ends the turn, and the next question starts them again anyway.
   */
  readonly #builds = new Map<ChatId, TurnBuilds>();

  /** Who follows each chat (`watch`), by chat and watch ID. */
  readonly #watchers = new Map<ChatId, Map<string, ChatWatch>>();

  /** The chats' previews of their drafts (preview.ts). */
  readonly #previews = new Previews(this.ctx, this.env);

  /** What those previews reported (preview-reports.ts). */
  readonly #previewReports = new PreviewReports();

  /**
   * Bumped whenever a chat's agent writes or drops a draft, so its
   * watchers read the drafts again, and preview the latest. In memory only.
   */
  readonly #draftVersions = new Map<ChatId, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    this.#closeInterruptedTurns();
  }

  /**
   * Tells each chat whose turn the last restart cut short that it was
   * (`interruptedMessage`), and clears its mark: no turn runs yet when the
   * object wakes, so every mark left is of one that never ended. Only a
   * turn that left work half done is told of: one that stored nothing yet
   * (its question never reached the chat, and the ask failed for its
   * person) or whose last message is the agent's finished response (the
   * restart came before the mark was cleared) has nothing to go on from.
   * Nothing is resumed. In one transaction, so a wake that dies here says
   * it once.
   */
  #closeInterruptedTurns(): void {
    const { kv } = this.ctx.storage;
    this.ctx.storage.transactionSync(() => {
      // Read whole first: the marks are deleted while going through them.
      const marks = [...kv.list<number>({ prefix: turnKeyPrefix })];
      for (const [key, before] of marks) {
        const chatId = chatIdSchema.parse(key.slice(turnKeyPrefix.length));
        const last = this.#db
          .select({ message: chatMessages.message })
          .from(chatMessages)
          .where(
            and(eq(chatMessages.chatId, chatId), gt(chatMessages.id, before))
          )
          .orderBy(desc(chatMessages.id))
          .limit(1)
          .get();
        const stored =
          last === undefined
            ? undefined
            : storedMessageSchema.parse(JSON.parse(last.message));
        // A response that asks for code to run isn't the turn's last.
        const finished =
          stored?.role === "assistant" && stored.stopReason !== "toolUse";
        if (stored !== undefined && !finished) {
          this.#keep(chatId, interruptedMessage());
        }
        kv.delete(key);
      }
    });
  }

  /** Stores `message` as the chat's next, and shows it to its watchers. */
  #keep(chatId: ChatId, message: Message): void {
    const { id, createdAt } = this.#db
      .insert(chatMessages)
      .values({
        chatId,
        message: JSON.stringify(message),
        createdAt: new Date(),
      })
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt })
      .get();
    const shown = chatMessageOf(id, message, createdAt);
    this.#changed(chatId, shown === undefined ? [] : [shown]);
  }

  /**
   * A new chat, which belongs to `personId`: agent `agentId` answers in it,
   * acting for them. Refused past {@link maxChatsPerPerson}. Made `by`
   * someone (the person, through the chat API), it is audited with it, in
   * the same transaction; core's own chats (tests) pass nobody.
   *
   * Made to fix a failed run (`fix`), it starts with the run's report
   * attached (`attachments`), audited as `workflow.run.fix_asked`, and
   * with what the report may hold data from as its sources; restricted
   * from the start, audited so, when the run's App is. All in the same
   * transaction: no turn can read the report before the chat carries it.
   */
  createChat(
    title: string,
    personId: string,
    agentId: string,
    by?: AuditActor,
    fix?: RunToFix
  ): Chat {
    const agent = workspaceAgentIdSchema.safeParse(agentId);
    if (!agent.success) {
      // No agent core names: nowhere an agent can work.
      throw permissionErrors.create("permission.context_invalid");
    }
    const [kept] = this.#db
      .select({ count: count() })
      .from(chats)
      .where(eq(chats.personId, personId))
      .all();
    if ((kept?.count ?? 0) >= maxChatsPerPerson) {
      throw agentErrors.create("agent.too_many_chats");
    }
    const id = chatIdSchema.parse(crypto.randomUUID());
    const chat = this.ctx.storage.transactionSync(() => {
      if (by !== undefined) {
        this.#outboxed(by, "chat.created", id);
      }
      const made = this.#db
        .insert(chats)
        .values({
          id,
          title,
          createdAt: new Date(),
          personId,
          agentId: agent.data,
          restricted: fix?.restricted === true,
        })
        .returning()
        .get();
      if (fix !== undefined) {
        this.#attachRun(made, fix, by);
      }
      return made;
    });
    this.#deliverAudit();
    return chat;
  }

  /**
   * A new chat of `personId`'s to fix a failed run (`createChat` with
   * `fix`), made only if the deployment allows `model`, which its question
   * will name: a refused model leaves no chat without a question.
   */
  createFixChat(
    title: string,
    personId: string,
    agentId: string,
    by: AuditActor,
    fix: RunToFix,
    model: string
  ): Chat {
    if (!gatewaySettings(this.env).models.includes(model)) {
      throw modelErrors.create("model.not_allowed");
    }
    return this.createChat(title, personId, agentId, by, fix);
  }

  /**
   * Attaches the report of the run `fix` names to the new chat, with its
   * sources, and audits it: in `createChat`'s transaction.
   */
  #attachRun(chat: Chat, fix: RunToFix, by: AuditActor | undefined): void {
    const { report, sources, restricted } = fix;
    const { id, createdAt, personId, agentId } = chat;
    this.#db
      .insert(chatAttachments)
      .values({
        chatId: id,
        runId: report.run,
        report: JSON.stringify(report),
        createdAt,
      })
      .run();
    const carried = [...new Set([report.run, ...sources])];
    this.#keepSources(id, carried);
    const workspace = this.ctx.id.name ?? null;
    if (by !== undefined) {
      this.#outboxEntry({
        actor: by,
        action: "workflow.run.fix_asked",
        target: { type: "workflow_run", id: report.run },
        detail: {
          app: report.app,
          workflow: report.workflow,
          version: report.version,
          chat: id,
          workspace,
        },
      });
    }
    if (restricted && personId !== null && agentId !== null) {
      // As restricted.ts records a chat entering restricted mode.
      this.#outboxEntry({
        actor: delegateActorOf(chatAuthority({ agentId, personId })),
        action: "context.restricted",
        target: { type: "chat", id },
        provenance: carried.slice(0, auditProvenanceMaxItems),
        detail: { workspace },
      });
    }
  }

  /**
   * The reports of the failed runs the chat was started to fix, oldest
   * first, as data for its agent (`env.chat.attachments()` in
   * agent-apis.ts). Core's own read: the agent's code reaches only its
   * own chat's.
   */
  attachments(chatId: ChatId): RunFailure[] {
    return this.#db
      .select({ report: chatAttachments.report })
      .from(chatAttachments)
      .where(eq(chatAttachments.chatId, chatId))
      .orderBy(asc(chatAttachments.createdAt), asc(chatAttachments.runId))
      .all()
      .map(({ report }) => storedReportSchema.parse(JSON.parse(report)));
  }

  /**
   * Stores the audit event of a change to chat `chatId` in this object's
   * outbox: call it in the change's transaction, so both are kept or
   * neither, then `#deliverAudit`. Names the chat and this object, never
   * the chat's title, which may quote a question.
   */
  #outboxed(
    by: AuditActor,
    action: "chat.created" | "chat.renamed" | "chat.deleted",
    chatId: ChatId,
    detail: Record<string, AuditDetailValue> = {}
  ): void {
    this.#outboxEntry({
      actor: by,
      action,
      target: { type: "chat", id: chatId },
      detail: { workspace: this.ctx.id.name ?? null, ...detail },
    });
  }

  /** Stores `entry`'s event in the outbox, as `#outboxed` does. */
  #outboxEntry(entry: AuditEntry): void {
    const event = createAuditEvent(entry, "core");
    this.#db
      .insert(auditOutbox)
      .values({
        id: event.id,
        event: JSON.stringify(event),
        createdAt: new Date(),
      })
      .run();
  }

  /**
   * Delivers the outbox's events to the audit log now, in the background;
   * while any are left (the log out of reach), the alarm tries again,
   * waiting longer each time.
   */
  #deliverAudit(): void {
    this.ctx.waitUntil(this.#drainAudit());
  }

  async #drainAudit(): Promise<void> {
    const left = await drainObjectOutbox(this.env, this.ctx.storage.sql);
    if (left === 0) {
      this.#auditRetryMs = auditRetryMs.first;
      return;
    }
    const retryMs = this.#auditRetryMs;
    this.#auditRetryMs = Math.min(retryMs * 2, auditRetryMs.most);
    await this.#alarmBy(Date.now() + retryMs);
  }

  /** Sets the alarm to go at `time` at the latest, never later than it was. */
  async #alarmBy(time: number): Promise<void> {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > time) {
      await this.ctx.storage.setAlarm(time);
    }
  }

  // Restricted mode of a chat (see restricted.ts). A chat that isn't here
  // has nowhere to keep it: both say so, and whatever asked is refused.

  /**
   * The agent that works in the chat and whether the chat has read
   * restricted data; `undefined`: no such chat.
   */
  chatState(
    chatId: ChatId
  ): { agentId: string | null; restricted: boolean } | undefined {
    return this.#db
      .select({ agentId: chats.agentId, restricted: chats.restricted })
      .from(chats)
      .where(eq(chats.id, chatId))
      .get();
  }

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
    if (changed.length === 0) {
      return false;
    }
    this.#provenanceChanged(chatId);
    return true;
  }

  /**
   * Asks the chat's agent a question and waits for its answer: the agent
   * loop runs here, its code runs in isolates of its own, and every model
   * request goes through the model gateway, and its rules, as the chat's
   * agent acting for the chat's person. One turn at a time per chat.
   * It takes its caller's word for who asks: a person's questions come
   * through `send`, which checks the chat is theirs.
   */
  async ask(chatId: unknown, question: Question): Promise<Answer> {
    return await this.#turn(this.#chat(chatId), question);
  }

  /**
   * One turn of `chat`'s agent (`ask`). `started` is called once the turn
   * is under way: the model admitted, and nothing kept yet.
   */
  async #turn(
    chat: Chat,
    question: Question,
    started?: () => void
  ): Promise<Answer> {
    requireFeature(this.env, "agent");
    const parsed = questionSchema.safeParse(question);
    if (!parsed.success) {
      throw agentErrors.create("agent.invalid_question");
    }
    // The agent acts for the chat's own person, as this object stored it,
    // never for whoever asks, and only while they are still a member.
    const { personId, agentId } = chat;
    if (personId === null || agentId === null) {
      throw agentErrors.create("agent.no_person");
    }
    // Being deleted: its writes are being rejected, and it takes no more.
    if (this.#deleting.has(chat.id)) {
      throw agentErrors.create("agent.chat_not_found");
    }
    if (this.#turns.has(chat.id)) {
      throw agentErrors.create("agent.busy");
    }
    // Taken before the first await, so a second question waits its turn
    // and the chat isn't deleted under it (`deleteChat`).
    const cancel = new AbortController();
    this.#turns.set(chat.id, cancel);
    // Marked in storage as long as it is in `#turns`, however it ends.
    this.ctx.storage.kv.put(
      `${turnKeyPrefix}${chat.id}`,
      this.#lastMessageId(chat.id)
    );
    try {
      if (!(await memberRole(this.env.DB, personId))) {
        throw permissionErrors.create("permission.person_inactive");
      }
      if (this.#storedChars(chat.id) > maxChatChars) {
        throw agentErrors.create("agent.chat_full");
      }
      // Where the chat is (this object, by the name core gave it:
      // `workspace` in durable-objects.ts), and whose agent acts in it, as
      // the chat stored it.
      const workspaceId = workspaceIdSchema.parse(this.ctx.id.name);
      const scope = { workspaceId, agentId, chatId: chat.id, personId };
      // The organization's agent, acting for the chat's person, in this chat:
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
      this.#stopped.delete(chat.id);
      // Each question gives the repair loop its full count again.
      this.#builds.delete(chat.id);
      started?.();
      this.#changed(chat.id);
      const result = await runTurn({
        history: this.#transcript(chat.id),
        question: parsed.data.text,
        model,
        apis: agentApis(this.env),
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
          if (message.role === "assistant") {
            this.#partials.delete(chat.id);
          }
          this.#keep(chat.id, message);
        },
        write: (partial) => {
          this.#partials.set(chat.id, partial);
          this.#changed(chat.id);
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
      this.ctx.storage.kv.delete(`${turnKeyPrefix}${chat.id}`);
      this.#turns.delete(chat.id);
      this.#partials.delete(chat.id);
      this.#changed(chat.id);
    }
  }

  /**
   * Asks `personId`'s own chat's agent a question (`ask`), and resolves
   * once the turn is under way; refused as `ask` refuses one that can't
   * start. The turn goes on with nobody waiting: its messages go to the
   * chat's watchers as they come, and why it stopped, if it stopped short
   * of an answer, with the chat's state (`ChatUpdate.stopped`).
   */
  async send(
    chatId: unknown,
    personId: string,
    question: Question
  ): Promise<void> {
    const chat = this.#ownChat(chatId, personId);
    const started = Promise.withResolvers<boolean>();
    const ended = this.#sentTurn(chat, question, started);
    this.#sent.add(ended);
    void this.#forget(ended);
    await started.promise;
    // The alarm keeps the object up until the turn ends (`alarm`).
    await this.#alarmBy(Date.now());
  }

  /**
   * The turn `send` started: `started` resolves once it is under way, or
   * rejects with why it couldn't start. Why one under way stopped short
   * goes to the chat's watchers.
   */
  async #sentTurn(
    chat: Chat,
    question: Question,
    started: PromiseWithResolvers<boolean>
  ): Promise<void> {
    let underWay = false;
    try {
      await this.#turn(chat, question, () => {
        underWay = true;
        started.resolve(true);
      });
    } catch (error) {
      if (!underWay) {
        started.reject(error);
        return;
      }
      this.#stopped.set(chat.id, stopReason(chat.id, error));
      this.#changed(chat.id);
    }
  }

  /** Forgets a turn `send` started once it has ended. */
  async #forget(ended: Promise<void>): Promise<void> {
    try {
      await ended;
    } finally {
      this.#sent.delete(ended);
    }
  }

  /**
   * Waits for every turn `send` started, however long they take: an
   * object runs while an event of its own does, so it isn't evicted under
   * a turn nobody waits on. An alarm may run 15 minutes; a turn that takes
   * longer goes on while the object stays up. After a restart there are
   * none: the chat goes on from what it stored, told that its turn was cut
   * short (`#closeInterruptedTurns`).
   */
  override async alarm(): Promise<void> {
    // Audit events the log didn't take yet go first: a turn may run long.
    await this.#drainAudit();
    while (this.#sent.size > 0) {
      // oxlint-disable-next-line no-await-in-loop -- until none is left, as more may start
      await Promise.all(this.#sent);
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
   * Stops `personId`'s own chat's running turn, if there is one: the model
   * request or code run in flight ends, and the turn answers `cancelled`.
   */
  cancel(chatId: unknown, personId: string): boolean {
    const turn = this.#turns.get(this.#ownChat(chatId, personId).id);
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

  /**
   * Keeps `sources` with the chat, each once, for good: one statement
   * whatever their number, the list bound as one JSON value, as the
   * object's SQLite takes at most 100 bound values a statement.
   */
  #keepSources(chatId: ChatId, sources: readonly string[]): void {
    if (sources.length === 0) {
      return;
    }
    // The WHERE keeps SQLite from reading ON CONFLICT as a join.
    this.#db
      .insert(chatSources)
      .select(
        sql`SELECT ${chatId}, value, ${Date.now()} FROM json_each(${JSON.stringify(sources)}) WHERE true`
      )
      .onConflictDoNothing()
      .run();
    this.#provenanceChanged(chatId);
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

  /**
   * The chat's transcript, oldest first, as pi keeps it; for core's own
   * reads. A person follows their chat through `watch`, which checks it is
   * theirs.
   */
  messages(chatId: unknown): Message[] {
    return this.#transcript(this.#chat(chatId).id);
  }

  /** `personId`'s chats, newest first: at most {@link listedChats}. */
  chats(personId: string): ChatSummary[] {
    return this.#db
      .select({ id: chats.id, title: chats.title, createdAt: chats.createdAt })
      .from(chats)
      .where(eq(chats.personId, personId))
      .orderBy(desc(chats.createdAt))
      .limit(listedChats)
      .all()
      .map(({ id, title, createdAt }) => ({
        id,
        title,
        createdAt: createdAt.toISOString(),
        running: this.#turns.has(id),
      }));
  }

  /** Renames `personId`'s own chat, audited as `by`'s. */
  renameChat(
    chatId: unknown,
    personId: string,
    title: string,
    by: AuditActor
  ): void {
    const { id } = this.#ownChat(chatId, personId);
    this.ctx.storage.transactionSync(() => {
      this.#db.update(chats).set({ title }).where(eq(chats.id, id)).run();
      this.#outboxed(by, "chat.renamed", id);
    });
    this.#deliverAudit();
  }

  /**
   * Deletes `personId`'s own chat once its agent isn't working on it:
   * rejects every write its agent holds for `person` (connect's
   * `declineChatActions`, each recorded there), then deletes it with its
   * messages and sources, audited as `by`'s. While it does, the chat is
   * marked deleting and takes no question, so no write can be held after
   * the rejecting; if rejecting fails, the mark goes and the chat stays.
   * Its watchers get nothing more. How many writes it rejected.
   */
  async deleteChat(
    chatId: unknown,
    personId: string,
    person: ConnectionPerson,
    by: AuditActor
  ): Promise<number> {
    const { id } = this.#ownChat(chatId, personId);
    if (person.userId !== personId) {
      throw agentErrors.create("agent.chat_not_found");
    }
    if (this.#turns.has(id) || this.#deleting.has(id)) {
      throw agentErrors.create("agent.busy");
    }
    this.#deleting.add(id);
    try {
      const declined = await this.env.CONNECT.declineChatActions({
        person,
        workspaceId: workspaceIdSchema.parse(this.ctx.id.name),
        chatId: id,
      });
      // Every App it has a draft of, even one with no changes left: its
      // preview may still run.
      const drafted = this.#db
        .select({ appId: chatDrafts.appId })
        .from(chatDrafts)
        .where(eq(chatDrafts.chatId, id))
        .all();
      this.ctx.storage.transactionSync(() => {
        this.#db.delete(chatMessages).where(eq(chatMessages.chatId, id)).run();
        this.#db.delete(chatSources).where(eq(chatSources.chatId, id)).run();
        this.#db
          .delete(chatAttachments)
          .where(eq(chatAttachments.chatId, id))
          .run();
        this.#dropDrafts(
          eq(chatDraftFiles.chatId, id),
          eq(chatDrafts.chatId, id)
        );
        this.#db.delete(chats).where(eq(chats.id, id)).run();
        this.#outboxed(by, "chat.deleted", id, { declined });
      });
      this.#deliverAudit();
      for (const { appId } of drafted) {
        this.#dropPreview(id, appId);
      }
      this.#stopped.delete(id);
      this.#provenanceVersions.delete(id);
      this.#heldVersions.delete(id);
      this.#draftVersions.delete(id);
      this.#builds.delete(id);
      for (const watch of this.#watchers.get(id)?.values() ?? []) {
        watch[Symbol.dispose]();
      }
      this.#watchers.delete(id);
      return declined;
    } finally {
      this.#deleting.delete(id);
    }
  }

  /**
   * Follows `personId`'s own chat: `listener` gets the messages stored
   * after the one with ID `after` (all of them for `null`) and the chat as
   * it is now, then an update on every change (chat-watch.ts). Returns the
   * ID `unwatch` drops it by; one that can't be reached drops itself.
   */
  watch(
    chatId: unknown,
    personId: string,
    after: unknown,
    listener: ChatListener
  ): string {
    const { id } = this.#ownChat(chatId, personId);
    const since = afterSchema.safeParse(after);
    if (!since.success) {
      throw agentErrors.create("agent.invalid_request");
    }
    let watching = 0;
    for (const watchers of this.#watchers.values()) {
      watching += watchers.size;
    }
    if (watching >= maxWatchers) {
      throw agentErrors.create("agent.too_many_watches");
    }
    const watchId = crypto.randomUUID();
    const watch = new ChatWatch(
      listener.dup(),
      () => this.#state(id),
      () => this.#provenance(id),
      () => {
        this.unwatch(id, watchId);
      }
    );
    const watchers = this.#watchers.get(id) ?? new Map<string, ChatWatch>();
    watchers.set(watchId, watch);
    this.#watchers.set(id, watchers);
    watch.push(this.#shownAfter(id, since.data ?? 0));
    return watchId;
  }

  /** Drops the watcher `watch` kept as `watchId`, if it still does. */
  unwatch(chatId: ChatId, watchId: string): void {
    const watchers = this.#watchers.get(chatId);
    const watch = watchers?.get(watchId);
    watchers?.delete(watchId);
    if (watchers?.size === 0) {
      this.#watchers.delete(chatId);
    }
    watch?.[Symbol.dispose]();
  }

  /**
   * Tells the chat's watchers its agent had a write held for the person
   * (agent-connections.ts), so the page shows it to confirm at once, in
   * the middle of a turn too. Nothing of the write itself.
   */
  heldChanged(chatId: ChatId): void {
    this.#heldVersions.set(chatId, (this.#heldVersions.get(chatId) ?? 0) + 1);
    this.#changed(chatId);
  }

  /**
   * Tells the agent of `personId`'s own chat how a write it had held for
   * them ended (pending-actions.ts), which it otherwise never learns: kept
   * as a system message, so every later request of the chat carries it,
   * and one landing in the middle of a turn never parts a code step from
   * its result. The person isn't shown it: they decided it. No turn starts.
   */
  heldDecided(
    chatId: unknown,
    personId: string,
    held: { id: string; action: string },
    outcome: HeldOutcome
  ): void {
    const chat = this.#ownChat(chatId, personId);
    const { id, action } = heldSchema.parse(held);
    const message: Message = {
      role: "system",
      content: `The change you asked for, "${action}" (pending ID ${id}), was decided. ${heldOutcomes[outcome]} Read how it ended, with what it returned, with \`env.connections.outcome("${id}")\`.`,
      timestamp: Date.now(),
    };
    this.#db
      .insert(chatMessages)
      .values({
        chatId: chat.id,
        message: JSON.stringify(message),
        createdAt: new Date(),
      })
      .run();
  }

  // A chat's drafts of Apps (agent-builds.ts). Only core calls these, for
  // the chat's agent, having checked the person's role in the App and the
  // agent's permission first.

  /** The chat's draft of App `appId`; revision 0 while it has none. */
  draft(chatId: ChatId, appId: string): Draft {
    const row = this.#db
      .select()
      .from(chatDrafts)
      .where(and(eq(chatDrafts.chatId, chatId), eq(chatDrafts.appId, appId)))
      .get();
    if (row === undefined) {
      return { base: null, changes: {}, revision: 0 };
    }
    const files = this.#db
      .select({ path: chatDraftFiles.path, content: chatDraftFiles.content })
      .from(chatDraftFiles)
      .where(
        and(eq(chatDraftFiles.chatId, chatId), eq(chatDraftFiles.appId, appId))
      )
      .all();
    return {
      base: row.base,
      changes: Object.fromEntries(
        files.map(({ path, content }) => [path, content])
      ),
      revision: row.revision,
    };
  }

  /**
   * The title of `personId`'s own chat `chatId`; `null` when it is gone,
   * or not theirs. For a review of what the chat's agent proposed, read by
   * the person it acted for alone: a title may quote their question.
   */
  chatTitle(chatId: unknown, personId: string): string | null {
    const id = chatIdSchema.safeParse(chatId);
    if (!id.success) {
      return null;
    }
    const row = this.#db
      .select({ title: chats.title, personId: chats.personId })
      .from(chats)
      .where(eq(chats.id, id.data))
      .get();
    return row?.personId === personId ? row.title : null;
  }

  /**
   * `personId`'s own chat's drafts with changes, the most recently
   * written first: which Apps, over which version, and the paths each
   * changes, and which of those it deletes.
   */
  drafts(chatId: unknown, personId: string): ChatDraft[] {
    const { id } = this.#ownChat(chatId, personId);
    // A chat's few drafts, read by their key and sorted here.
    const rows = this.#db
      .select()
      .from(chatDrafts)
      .where(eq(chatDrafts.chatId, id))
      .all()
      .toSorted(
        (one, other) => other.updatedAt.getTime() - one.updatedAt.getTime()
      );
    // In key order: by App, then path. Whether each is deleted (it has no
    // content), without reading any file's content.
    const paths = this.#db
      .select({
        appId: chatDraftFiles.appId,
        path: chatDraftFiles.path,
        deleted: isNull(chatDraftFiles.content).mapWith(Boolean),
      })
      .from(chatDraftFiles)
      .where(eq(chatDraftFiles.chatId, id))
      .orderBy(asc(chatDraftFiles.appId), asc(chatDraftFiles.path))
      .all();
    // A draft whose changes are all gone keeps its row (its revision
    // goes on), and isn't one to show.
    return rows.flatMap(({ appId, base, revision, updatedAt }) => {
      const files = paths.filter((row) => row.appId === appId);
      return files.length === 0
        ? []
        : [
            {
              app: appId,
              base,
              changed: files.map(({ path }) => path),
              deleted: files
                .filter(({ deleted }) => deleted)
                .map(({ path }) => path),
              revision,
              updatedAt: updatedAt.toISOString(),
            },
          ];
    });
  }

  /**
   * Writes `changes` into the chat's draft of App `appId`, over version
   * `base`, and drops its changes to the paths in `unchanged` (back as the
   * base has them), only over the revision `revision` the write read (0:
   * there was none): `false`, and nothing written, when another write
   * landed since, or the chat is gone.
   */
  saveDraft(
    chatId: ChatId,
    appId: string,
    base: number | null,
    changes: Record<string, string | null>,
    unchanged: readonly string[],
    revision: number
  ): boolean {
    const saved = this.ctx.storage.transactionSync(() => {
      const [row] = this.#db
        .select({ revision: chatDrafts.revision })
        .from(chatDrafts)
        .where(and(eq(chatDrafts.chatId, chatId), eq(chatDrafts.appId, appId)))
        .all();
      if (
        (row?.revision ?? 0) !== revision ||
        this.chatState(chatId) === undefined
      ) {
        return false;
      }
      const updatedAt = new Date();
      this.#db
        .insert(chatDrafts)
        .values({ chatId, appId, base, revision: revision + 1, updatedAt })
        .onConflictDoUpdate({
          target: [chatDrafts.chatId, chatDrafts.appId],
          set: { base, revision: revision + 1, updatedAt },
        })
        .run();
      for (const [path, content] of Object.entries(changes)) {
        this.#db
          .insert(chatDraftFiles)
          .values({ chatId, appId, path, content })
          .onConflictDoUpdate({
            target: [
              chatDraftFiles.chatId,
              chatDraftFiles.appId,
              chatDraftFiles.path,
            ],
            set: { content },
          })
          .run();
      }
      for (const path of unchanged) {
        this.#db
          .delete(chatDraftFiles)
          .where(
            and(
              eq(chatDraftFiles.chatId, chatId),
              eq(chatDraftFiles.appId, appId),
              eq(chatDraftFiles.path, path)
            )
          )
          .run();
      }
      return true;
    });
    if (saved) {
      // The preview of the revision before is over: its database goes now;
      // what it reported goes once the new revision reports.
      this.#previews.drop(chatId, appId);
      this.#draftsChanged(chatId);
    }
    return saved;
  }

  /** Tells the chat's watchers its drafts changed. */
  #draftsChanged(chatId: ChatId): void {
    this.#draftVersions.set(chatId, (this.#draftVersions.get(chatId) ?? 0) + 1);
    this.#changed(chatId);
  }

  /**
   * Drops the chat's draft of App `appId`; with `revision`, only while it
   * is still at that revision (what a proposal committed): `false` when it
   * changed since, or the chat is gone.
   */
  dropDraft(chatId: ChatId, appId: string, revision?: number): boolean {
    const dropped = this.ctx.storage.transactionSync(() => {
      const now = this.draft(chatId, appId);
      if (revision !== undefined && now.revision !== revision) {
        return false;
      }
      if (this.chatState(chatId) === undefined) {
        return false;
      }
      // Its changes go; its revision goes on, a row made for it if there
      // was none, so a write that read an earlier one (0, before the
      // draft's first write landed, too) lands on nothing (`saveDraft`).
      this.#db
        .delete(chatDraftFiles)
        .where(
          and(
            eq(chatDraftFiles.chatId, chatId),
            eq(chatDraftFiles.appId, appId)
          )
        )
        .run();
      const updatedAt = new Date();
      this.#db
        .insert(chatDrafts)
        .values({
          chatId,
          appId,
          base: null,
          revision: now.revision + 1,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [chatDrafts.chatId, chatDrafts.appId],
          set: { revision: now.revision + 1, updatedAt },
        })
        .run();
      return true;
    });
    if (dropped) {
      this.#dropPreview(chatId, appId);
      this.#draftsChanged(chatId);
    }
    return dropped;
  }

  /** Stops the chat's preview of App `appId`, and forgets its reports. */
  #dropPreview(chatId: ChatId, appId: string): void {
    this.#previews.drop(chatId, appId);
    this.#previewReports.drop(chatId, appId);
  }

  // A chat's preview of its draft of an App (preview.ts), for the chat's
  // own person: core checks their role in the App first (chats-rpc.ts).

  /**
   * `personId`'s own chat's draft of App `appId`, to preview, which they
   * have open now: `app.no_draft` while it changes nothing.
   */
  previewDraft(chatId: unknown, personId: string, appId: string): Draft {
    const { id } = this.#ownChat(chatId, personId);
    const draft = this.draft(id, appId);
    if (Object.keys(draft.changes).length === 0) {
      throw appErrors.create("app.no_draft");
    }
    this.#previewReports.opened(id, appId);
    return draft;
  }

  /**
   * Keeps what the preview of `personId`'s own chat's draft of App
   * `appId` at `revision` reported on `screen`: `problem`, or, without
   * one, that it rendered (preview-reports.ts). Dropped once the draft
   * is at another revision.
   */
  previewReport(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown,
    screen: string,
    problem?: ScreenProblem
  ): void {
    const { id } = this.#ownChat(chatId, personId);
    const { revision: now } = this.draft(id, appId);
    if (revision !== now) {
      return;
    }
    this.#previewReports.report(
      id,
      appId,
      now,
      problem === undefined
        ? undefined
        : { source: "screen", at: screen, ...problem }
    );
  }

  /**
   * Records that a stub of the chat's preview of App `appId` refused a
   * call of the server call `token` names (`Previews.refused`): for
   * core's preview stubs alone (preview-bindings.ts), before the draft's
   * code hears of it.
   */
  previewRefused(chatId: ChatId, appId: string, token: unknown): void {
    this.#previews.refused(chatId, appId, token);
  }

  /**
   * How the preview of the chat's draft of App `appId` at `revision` ran,
   * waiting up to `waitMs` for it to report while the person has it open:
   * for the agent's checks of the draft (agent-builds.ts).
   */
  async previewOutcome(
    chatId: ChatId,
    appId: string,
    revision: number,
    waitMs: number
  ): Promise<PreviewOutcome> {
    return await this.#previewReports.outcome(chatId, appId, revision, waitMs);
  }

  /**
   * Calls `method` of the server code of `personId`'s own chat's draft of
   * App `appId` with `args`, in its preview, as the draft is at
   * `revision`: `app.preview_outdated` once it is at another.
   */
  async previewCall(
    chatId: unknown,
    personId: string,
    appId: string,
    revision: unknown,
    method: string,
    args: unknown[]
  ): Promise<AppAnswer> {
    const draft = this.previewDraft(chatId, personId, appId);
    if (draft.revision !== revision) {
      throw appErrors.create("app.preview_outdated");
    }
    const id = chatIdSchema.parse(chatId);
    const ran = { refused: false };
    try {
      return await this.#previews.call(
        id,
        personId,
        appIdSchema.parse(appId),
        draft,
        method,
        args,
        ran
      );
    } catch (error) {
      // What the draft's code failed with is the agent's to fix too, but
      // for a call a preview stub refused a call of, as core saw it.
      const problem = serverProblem(method, error);
      if (problem === undefined) {
        throw error;
      }
      this.#previewReports.report(
        id,
        appId,
        draft.revision,
        problem,
        ran.refused
      );
      // The screen hears it was refused, as it would of a failed call.
      throw ran.refused ? appErrors.create("app.preview_side_effect") : error;
    }
  }

  /** Deletes the draft files and drafts the conditions name, in that order. */
  #dropDrafts(files: SQL | undefined, drafts: SQL | undefined): void {
    this.#db.delete(chatDraftFiles).where(files).run();
    this.#db.delete(chatDrafts).where(drafts).run();
  }

  /** What the chat's agent spent building Apps this turn. */
  #turnBuilds(chatId: ChatId): TurnBuilds {
    const found = this.#builds.get(chatId);
    if (found !== undefined) {
      return found;
    }
    const made: TurnBuilds = { created: 0, drafts: new Map() };
    this.#builds.set(chatId, made);
    return made;
  }

  /**
   * Takes one of the checks of the chat's draft of App `appId` this turn,
   * before it runs: `false` once those that failed in a row and those
   * running now together reach `limit`, so checks started at once can't
   * run past it. Each check taken is settled (`settleCheck`) once it ends.
   */
  takeCheck(chatId: ChatId, appId: string, limit: number): boolean {
    const draft = this.#draftBuilds(chatId, appId);
    if (draft.failed + draft.running >= limit) {
      return false;
    }
    draft.running += 1;
    return true;
  }

  /** What the chat's agent spent on its draft of App `appId` this turn. */
  #draftBuilds(chatId: ChatId, appId: string) {
    const { drafts } = this.#turnBuilds(chatId);
    const found = drafts.get(appId);
    if (found !== undefined) {
      return found;
    }
    const made = { failed: 0, running: 0 };
    drafts.set(appId, made);
    return made;
  }

  /**
   * Settles a check taken with `takeCheck`: one that didn't pass adds to
   * the checks that failed in a row, and a passing one starts them again.
   * How many failed in a row now.
   */
  settleCheck(chatId: ChatId, appId: string, passed: boolean): number {
    const draft = this.#draftBuilds(chatId, appId);
    draft.failed = passed ? 0 : draft.failed + 1;
    draft.running = Math.max(0, draft.running - 1);
    return draft.failed;
  }

  /**
   * Takes one of the Apps the chat's agent may create this turn: `false`
   * once it created `limit`.
   */
  takeCreate(chatId: ChatId, limit: number): boolean {
    const turn = this.#turnBuilds(chatId);
    if (turn.created >= limit) {
      return false;
    }
    turn.created += 1;
    return true;
  }

  /** Gives back an App taken with `takeCreate` that wasn't created. */
  releaseCreate(chatId: ChatId): void {
    const turn = this.#turnBuilds(chatId);
    turn.created = Math.max(0, turn.created - 1);
  }

  /** Tells the chat's watchers it changed, with the messages just stored. */
  #changed(chatId: ChatId, messages: readonly ChatMessage[] = []): void {
    for (const watch of this.#watchers.get(chatId)?.values() ?? []) {
      watch.push(messages);
    }
  }

  /** The chat as its watchers see it now, besides its messages. */
  #state(chatId: ChatId): ChatState {
    const partial = this.#partials.get(chatId);
    const stopped = this.#stopped.get(chatId);
    return {
      partial: partial === undefined ? null : partialOf(partial),
      running: this.#turns.has(chatId),
      provenanceVersion: this.#provenanceVersions.get(chatId) ?? 0,
      stopped: stopped ?? null,
      held: this.#heldVersions.get(chatId) ?? 0,
      drafts: this.#draftVersions.get(chatId) ?? 0,
    };
  }

  /** What the chat's answers may hold: read only when it changed. */
  #provenance(chatId: ChatId): ChatProvenance {
    return {
      sources: this.#sources(chatId),
      restricted: this.isChatRestricted(chatId) === true,
    };
  }

  /** Marks the chat's provenance changed, and tells its watchers. */
  #provenanceChanged(chatId: ChatId): void {
    this.#provenanceVersions.set(
      chatId,
      (this.#provenanceVersions.get(chatId) ?? 0) + 1
    );
    this.#changed(chatId);
  }

  /** The chat's messages stored after the one with ID `after`, as shown. */
  #shownAfter(chatId: ChatId, after: number): ChatMessage[] {
    return this.#db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.chatId, chatId), gt(chatMessages.id, after)))
      .orderBy(asc(chatMessages.id))
      .all()
      .flatMap(({ id, message, createdAt }) => {
        const shown = chatMessageOf(
          id,
          storedMessageSchema.parse(JSON.parse(message)),
          createdAt
        );
        return shown === undefined ? [] : [shown];
      });
  }

  /**
   * The chat, if it is `personId`'s: the one person its agent acts for,
   * and the only one who reaches it. Anyone else's is refused as if there
   * were none.
   */
  #ownChat(chatId: unknown, personId: string): Chat {
    const chat = this.#chat(chatId);
    if (chat.personId === null || chat.personId !== personId) {
      throw agentErrors.create("agent.chat_not_found");
    }
    return chat;
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

  /** The ID of the chat's last stored message; 0 while it has none. */
  #lastMessageId(chatId: ChatId): number {
    const [row] = this.ctx.storage.sql
      .exec<{ last: number }>(
        "SELECT coalesce(max(id), 0) AS last FROM chat_messages WHERE chat_id = ?",
        chatId
      )
      .toArray();
    return row?.last ?? 0;
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
