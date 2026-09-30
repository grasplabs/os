import { agentErrors } from "@grasp-os/shared/agent";
import { actorOf } from "@grasp-os/shared/audit";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import type {
  ChatDraft,
  ChatQuestion,
  ChatsApi,
  ChatSummary,
  ChatUpdate,
  FixRunResult,
  PreviewBundle,
} from "@grasp-os/shared/chat";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import type { ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  screenErrors,
  screenNameSchema,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type { ScreenProblem } from "@grasp-os/shared/screens";
import { RpcTarget } from "capnweb";

import { appFor, draftFiles, screensIn } from "./apps.ts";
import { organizationId } from "./auth/auth.ts";
import { personOf } from "./connections.ts";
import { workspace } from "./durable-objects.ts";
import { gatewaySettings } from "./models.ts";
import { callbackFor, isStub, recheckedEvery } from "./page-callbacks.ts";
import type { StillOpen } from "./page-callbacks.ts";
import { fixQuestion, runToFix } from "./run-fixes.ts";
import { RunSubscription } from "./run-subscription.ts";
import { argumentsFor, screenCode, stillHasRole } from "./screens-rpc.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { questionSchema } from "./workspace.ts";

// A signed-in person's chats (workspace.ts), over `/rpc`. Each person's
// chats are in a Workspace object of their own, reached only with the
// signed-in person as the session check hands them over here, and that
// object checks every call against the chat's stored person too: nobody
// else lists, renames, deletes, asks in, stops or follows a chat, and a
// chat of someone else's is refused as if there were none. Making,
// renaming and deleting one is audited, and so is starting one to fix a
// failed run (`fixRun`).

/**
 * The agent every chat's agent is: the organization workspace's, so
 * admins grant to it once, whoever's chat it answers in. Named as agents
 * must be (`workspaceAgentIdSchema` in agent-scope.ts).
 */
export const chatAgentId = organizationId;

/**
 * The Workspace object that holds `userId`'s chats: each person's own, so
 * one person's chats, watches and turns never load, cap or restart
 * another's. A chat's context names it (`workspaceId`), and its agent is
 * still {@link chatAgentId}.
 */
export const personalWorkspaceId = (userId: string): WorkspaceId =>
  workspaceIdSchema.parse(`person:${userId}`);

/** How long one answer to whether the person may still follow chats holds. */
const recheckMs = 5000;

/**
 * Most chats one connection follows at once: a page shows one, and a page
 * that watches over and over holds no more than this in the object.
 */
const maxWatches = 10;

/** A chat's ID from the page: a string, or no chat at all. */
const chatIdOf = (chatId: unknown): ChatId => {
  const parsed = chatIdSchema.safeParse(chatId);
  if (!parsed.success) {
    throw agentErrors.create("agent.chat_not_found");
  }
  return parsed.data;
};

/**
 * Why a question wasn't taken, as its person reads it: an unplanned error
 * is logged, and shown as one.
 */
const refusedBecause = (chatId: ChatId, error: unknown): string => {
  if (isExpectedError(error)) {
    return error.message;
  }
  log.error("chat.fix_not_asked", { chatId, ...errorFields(error) });
  return internalErrors.create("internal.unexpected").message;
};

/** How a push to a chat page is refused. */
const refusals = {
  invalid: () => agentErrors.create("agent.invalid_request"),
  closed: () => agentErrors.create("agent.chat_not_found"),
};

/** The signed-in person's chats with the organization's agent. */
export class ChatsRpc extends RpcTarget implements ChatsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  /** This connection's watches, each until it's released. */
  readonly #watches = new Set<Disposable>();
  /**
   * Whether this connection may still follow chats: its session holds, as
   * every call checks, read again at most every {@link recheckMs} as
   * updates are pushed.
   */
  readonly #stillOpen: StillOpen;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#stillOpen = recheckedEvery(recheckMs, async () => {
      try {
        await check();
        return true;
      } catch {
        return false;
      }
    });
  }

  /** The object that holds `userId`'s chats. */
  #chatsOf(userId: string) {
    return workspace(this.#env, personalWorkspaceId(userId));
  }

  async models(): Promise<string[]> {
    return await withPerson(
      this.#check,
      () => gatewaySettings(this.#env).models
    );
  }

  async list(): Promise<ChatSummary[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) => await this.#chatsOf(userId).chats(userId)
    );
  }

  async create(title: string): Promise<ChatSummary> {
    return await withPerson(this.#check, async (person) => {
      const { userId } = person;
      const parsed = chatTitleSchema.safeParse(title);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_title");
      }
      const chat = await this.#chatsOf(userId).createChat(
        parsed.data,
        userId,
        chatAgentId,
        actorOf(person)
      );
      return {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt.toISOString(),
        running: false,
      };
    });
  }

  async rename(chatId: string, title: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      const id = chatIdOf(chatId);
      const parsed = chatTitleSchema.safeParse(title);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_title");
      }
      await this.#chatsOf(person.userId).renameChat(
        id,
        person.userId,
        parsed.data,
        actorOf(person)
      );
    });
  }

  /**
   * Deletes the chat once its agent isn't working on it, rejecting first
   * every write it holds, so none is left that nobody can decide: a
   * failure there leaves the chat as it was, to delete again. The object
   * does it all (`deleteChat`), taking no question meanwhile.
   */
  async remove(chatId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await this.#chatsOf(person.userId).deleteChat(
        chatIdOf(chatId),
        person.userId,
        await personOf(this.#env, person),
        actorOf(person)
      );
    });
  }

  async send(chatId: string, question: ChatQuestion): Promise<void> {
    await withPerson(this.#check, async ({ userId }) => {
      const id = chatIdOf(chatId);
      // Two strings only: whatever else the page passed goes no further.
      const parsed = questionSchema.safeParse(question);
      if (!parsed.success) {
        throw agentErrors.create("agent.invalid_question");
      }
      await this.#chatsOf(userId).send(id, userId, parsed.data);
    });
  }

  /**
   * Starts a chat to fix a failed run (run-fixes.ts), and asks its agent
   * with `model`. A model the deployment doesn't allow is refused before any chat is
   * made. A question refused past that (the client's model rules, say)
   * leaves the chat, with its report, in the person's list, to ask again:
   * it resolves with the chat and why, so the page opens that chat rather
   * than make another.
   */
  async fixRun(run: string, model: string): Promise<FixRunResult> {
    return await withPerson(this.#check, async (person) => {
      const { userId } = person;
      const fix = await runToFix(this.#env, person, run);
      const chats = this.#chatsOf(userId);
      const chat = await chats.createFixChat(
        `Fix ${fix.report.workflow}`,
        userId,
        chatAgentId,
        actorOf(person),
        fix,
        model
      );
      const summary = {
        id: chat.id,
        title: chat.title,
        createdAt: chat.createdAt.toISOString(),
      };
      try {
        await chats.send(chat.id, userId, {
          text: fixQuestion(fix.report),
          model,
        });
      } catch (error) {
        return {
          chat: { ...summary, running: false },
          sent: false,
          reason: refusedBecause(chat.id, error),
        };
      }
      return { chat: { ...summary, running: true }, sent: true };
    });
  }

  async drafts(chatId: string): Promise<ChatDraft[]> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).drafts(chatIdOf(chatId), userId)
    );
  }

  /**
   * A screen of the chat's draft of `app`, to preview (preview.ts): only
   * while the person builds the App, as the agent must to write it.
   */
  async preview(
    chatId: string,
    app: string,
    screen?: string
  ): Promise<PreviewBundle> {
    return await withPerson(this.#check, async (by) => {
      const { id, name } = await appFor(this.#env, by, app, "builder");
      const draft = await this.#chatsOf(by.userId).previewDraft(
        chatIdOf(chatId),
        by.userId,
        id
      );
      const files = await draftFiles(this.#env, id, draft);
      const screens = screensIn(files);
      if (screens.length === 0) {
        throw screenErrors.create("screen.not_found");
      }
      return {
        app: id,
        name,
        revision: draft.revision,
        screens,
        ...(await screenCode(
          this.#env,
          Object.fromEntries(files),
          screen ?? screens[0],
          null
        )),
      };
    });
  }

  /**
   * Calls a method of the draft's server code in its preview, with plain
   * data and the screen's callbacks, as a screen's call does
   * (screens-rpc.ts); each push through a callback checks again, at most
   * every {@link recheckMs}, what the call itself needs: the session and
   * a builder's role in the App. Once either is gone, the callback is
   * released and forwards nothing more.
   */
  async previewCall(
    chatId: string,
    app: string,
    revision: number,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    return await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      if (typeof method !== "string" || !Array.isArray(args)) {
        throw screenErrors.create("screen.invalid");
      }
      const stillOpen = recheckedEvery(
        recheckMs,
        async () => await stillHasRole(this.#env, this.#check, id, "builder")
      );
      const { passed, callbacks } = argumentsFor(args, stillOpen);
      try {
        return await this.#chatsOf(by.userId).previewCall(
          chatIdOf(chatId),
          by.userId,
          id,
          revision,
          method,
          passed
        );
      } catch (error) {
        // A failed call keeps no callback.
        for (const callback of callbacks) {
          callback[Symbol.dispose]();
        }
        throw error;
      }
    });
  }

  /**
   * Keeps what the preview's screen reported, for the agent's next check
   * of the draft: text its code wrote, held to size (`screenProblemSchema`).
   */
  async previewReport(
    chatId: string,
    app: string,
    revision: number,
    screen: string,
    problem: ScreenProblem
  ): Promise<void> {
    await withPerson(this.#check, async (by) => {
      const { id } = await appFor(this.#env, by, app, "builder");
      const at = screenErrors.parse("screen.invalid", screenNameSchema, screen);
      const reported = screenErrors.parse(
        "screen.invalid",
        screenProblemSchema,
        problem
      );
      await this.#chatsOf(by.userId).previewReport(
        chatIdOf(chatId),
        by.userId,
        id,
        revision,
        at,
        reported
      );
    });
  }

  async cancel(chatId: string): Promise<boolean> {
    return await withPerson(
      this.#check,
      async ({ userId }) =>
        await this.#chatsOf(userId).cancel(chatIdOf(chatId), userId)
    );
  }

  async watch(
    chatId: string,
    after: number | null,
    onUpdate: (update: ChatUpdate) => void
  ): Promise<RunSubscription> {
    return await withPerson(this.#check, async ({ userId }) => {
      const id = chatIdOf(chatId);
      if (!isStub(onUpdate)) {
        throw agentErrors.create("agent.invalid_request");
      }
      if (this.#watches.size >= maxWatches) {
        throw agentErrors.create("agent.too_many_watches");
      }
      const listener = callbackFor(onUpdate, this.#stillOpen, refusals, () => {
        this.#watches.delete(listener);
      });
      this.#watches.add(listener);
      const chats = this.#chatsOf(userId);
      let watchId: string;
      try {
        watchId = await chats.watch(id, userId, after, listener);
      } catch (error) {
        listener[Symbol.dispose]();
        throw error;
      }
      return new RunSubscription(async () => {
        // The slot is free at once, and the listener forwards nothing
        // more; the object drops it now, or at its next update if it
        // can't be reached.
        listener[Symbol.dispose]();
        try {
          await chats.unwatch(id, watchId);
        } catch (error) {
          log.warn("chat.unwatch_failed", {
            chatId: id,
            ...errorFields(error),
          });
        }
      });
    });
  }
}
