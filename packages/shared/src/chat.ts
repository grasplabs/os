import { z } from "zod";

import type { ScreenBundle, ScreenProblem } from "./screens.ts";

// A person's chats with the organization's agent, as the frontend sees them
// (core's chats-rpc.ts). Each chat belongs to the person who made it: only
// they list, rename, delete, ask in or follow it.

/** A chat's title: what the person, or their first question, named it. */
export const chatTitleSchema = z.string().trim().min(1).max(200);

/** A chat in the person's list. */
export interface ChatSummary {
  id: string;
  title: string;
  /** When it was made (ISO 8601). */
  createdAt: string;
  /** Whether its agent is working on a question now. */
  running: boolean;
}

/**
 * An App the chat's agent is changing in the chat's own draft, not yet
 * proposed (`ChatsApi.drafts`).
 */
export interface ChatDraft {
  app: string;
  /** The version the draft is over; null for an App with none yet. */
  base: number | null;
  /** The paths it changes, sorted. */
  changed: string[];
  /** Those of `changed` it deletes, sorted: nothing to open or preview. */
  deleted: string[];
  /** Which write of the draft this is: a preview of an earlier one is out of date. */
  revision: number;
  /** When it was last written (ISO 8601). */
  updatedAt: string;
}

/**
 * A screen of the chat's draft of an App, ready for a frame, as
 * `ScreenBundle` is for a running App (`ChatsApi.preview`): at the draft's
 * revision instead of a version, with the names of the draft's screens.
 */
export interface PreviewBundle extends Omit<ScreenBundle, "version"> {
  /** Which write of the draft it was built from: its calls name it. */
  revision: number;
  /** The draft's screens, sorted. */
  screens: string[];
}

/**
 * A problem a preview of a draft reported (`ChatsApi.previewReport`), or
 * one its server code failed with: text the draft's code wrote, held to
 * size, and only ever read as data.
 */
export interface PreviewProblem {
  /** On one of the draft's screens, or in its server code. */
  source: "screen" | "server";
  /** The screen it happened on, or the server method that failed. */
  at: string;
  kind: "error" | "rejection" | "console" | "failed";
  message: string;
  stack?: string;
}

/** Code the agent ran, or is writing, in a code step. */
export interface ChatCode {
  /** Pairs the code with its result. */
  callId: string;
  code: string;
}

/** How one of the agent's responses ended. */
export type ChatReplyEnd =
  /** It answered, or asked for code to run. */
  | "done"
  /** It hit the model's output limit. */
  | "cut_off"
  | "cancelled"
  | "failed";

/**
 * One stored message of a chat, oldest first by `id`. The agent's
 * instructions and the APIs it was shown aren't among them.
 */
export type ChatMessage =
  | { id: number; role: "user"; text: string; at: string }
  | {
      id: number;
      role: "assistant";
      /** Its answer, in Markdown. */
      text: string;
      /** The code it asked to run, each run in a code step. */
      code: ChatCode[];
      end: ChatReplyEnd;
      /** Why it failed, in the model gateway's words. */
      error?: string;
      at: string;
    }
  | {
      id: number;
      role: "result";
      /** The code step this is the result of (`ChatCode.callId`). */
      callId: string;
      /** What the code returned, logged or threw, as the agent read it. */
      text: string;
      failed: boolean;
      at: string;
    };

/** What the agent is writing now, before it is stored. */
export interface ChatPartial {
  text: string;
  code: ChatCode[];
}

/**
 * What a chat's answers may hold: every source the chat has read from
 * (collections and connections, by ID, and the failed run it was started
 * to fix, with its App's sources), and whether it read restricted data,
 * which puts it in restricted mode for good.
 */
export interface ChatProvenance {
  sources: string[];
  restricted: boolean;
}

/**
 * What the response being written gained since the watcher's last update:
 * each text as the length of what the watcher has that stays (`from`; 0
 * starts it afresh) and what follows it. `applyPartial` puts it together.
 */
export interface ChatPartialUpdate {
  from: number;
  text: string;
  /** Every code step of the response, each as its own text is. */
  code: { callId: string; from: number; code: string }[];
}

/** A text the watcher has, with what an update adds from `from` on. */
const extended = (shown: string, from: number, added: string): string =>
  `${shown.slice(0, from)}${added}`;

/**
 * The response being written, as the watcher had it (`shown`), with an
 * update's change applied; `null` between responses.
 */
export const applyPartial = (
  shown: ChatPartial | null,
  update: ChatPartialUpdate | null
): ChatPartial | null => {
  if (update === null) {
    return null;
  }
  return {
    text: extended(shown?.text ?? "", update.from, update.text),
    code: update.code.map(({ callId, from, code }) => ({
      callId,
      code: extended(
        shown?.code.find((step) => step.callId === callId)?.code ?? "",
        from,
        code
      ),
    })),
  };
};

/**
 * What changed in a chat since the last update: the messages stored since,
 * and the chat as it is now. The first update of a `watch` catches up: the
 * messages after the one it named, what the agent is writing then, and
 * the chat's provenance.
 */
export interface ChatUpdate {
  messages: ChatMessage[];
  /**
   * What the response being written gained (`applyPartial`); `null`
   * between responses.
   */
  partial: ChatPartialUpdate | null;
  /** Whether the agent is working on a question. */
  running: boolean;
  /** The chat's provenance: in the first update, and whenever it changes. */
  provenance?: ChatProvenance;
  /**
   * Why the last question stopped before the agent answered, when it
   * wasn't the model (the person left). Kept
   * until the next question starts (then `null`), and not over a restart.
   */
  stopped: string | null;
  /**
   * Changes whenever something of the chat waits for the person, or no
   * longer does: a write its agent had held for them to confirm, or a
   * connection it asked for (`connectionRequests`). Read both again then.
   * Only a count, from when the object last started; never what waits.
   */
  held: number;
  /**
   * Changes whenever the chat's agent writes or drops a draft: read the
   * drafts again then, and preview the latest. Only a count, from when
   * the object last started.
   */
  drafts: number;
}

/**
 * A connection the chat's agent asked to use in this chat alone, waiting
 * for a decision: the person's own personal connection, which they grant
 * or deny themselves (`decidedBy: "you"`), or a shared one, which only an
 * admin grants (`"admin"`) and they may still withdraw. Everything but
 * the connection's name is the request as stored: granting it grants
 * exactly this.
 */
export interface ChatConnectionRequest {
  /** The permission it would be. */
  id: string;
  connectionId: string;
  /** The connection's provider and account, while connect lists it. */
  provider: string | null;
  accountName: string | null;
  resource: string | null;
  actions: string[];
  /** The name the agent's code would call it by. */
  binding: string;
  /** Why the agent asked, in its words. */
  reason: string | null;
  /** ISO 8601. */
  requestedAt: string;
  decidedBy: "you" | "admin";
}

/** The chat `fixRun` started, and whether its question was taken. */
export type FixRunResult =
  | { chat: ChatSummary; sent: true }
  | { chat: ChatSummary; sent: false; reason: string };

/** A question for the chat's agent, and the model to answer it with. */
export interface ChatQuestion {
  text: string;
  /** One of `ChatsApi.models()`. */
  model: string;
}

/**
 * A hold on a chat's updates (`watch`), until it's released: then core
 * sends no more, and the slot it took is free again.
 */
export interface ChatSubscriptionApi {
  release: () => Promise<void>;
}

/** The signed-in person's chats with the organization's agent. */
export interface ChatsApi {
  /** The models a question may name, the default first. */
  models: () => Promise<string[]>;
  /** The person's chats, newest first. */
  list: () => Promise<ChatSummary[]>;
  create: (title: string) => Promise<ChatSummary>;
  rename: (chatId: string, title: string) => Promise<void>;
  /**
   * Deletes the chat and its messages, rejecting every write its agent
   * holds; refused while its agent works.
   */
  remove: (chatId: string) => Promise<void>;
  /**
   * Asks the chat's agent a question. Resolves once the agent has taken
   * it; the answer streams to `watch`, and goes on without anyone
   * watching.
   */
  send: (chatId: string, question: ChatQuestion) => Promise<void>;
  /**
   * Asks the agent, in a new chat, to fix the workflow of failed run
   * `run`, with `model`: the run's failure report is attached to the chat
   * as data (the agent reads it with `env.chat.attachments()`), never put
   * into its instructions, and the question names only the run, its App
   * and its workflow. For the person the run acted for, and admins: anyone
   * else is refused as if there were no such run, and a model the
   * deployment doesn't allow before any chat is made. Resolves with the
   * chat once the agent has taken the question, or, when the question is
   * refused once the chat is made (the client's model rules, say), with
   * the chat and why (`sent: false`): the chat holds the report, to ask
   * in again, rather than a retry making another.
   */
  fixRun: (run: string, model: string) => Promise<FixRunResult>;
  /**
   * The Apps the chat's agent is changing in the chat's drafts, not yet
   * proposed, most recently written first.
   */
  drafts: (chatId: string) => Promise<ChatDraft[]>;
  /**
   * Screen `screen` of the chat's draft of `app` (its first screen when
   * none is named), built, to preview: for the person while they build
   * the App.
   */
  preview: (
    chatId: string,
    app: string,
    screen?: string
  ) => Promise<PreviewBundle>;
  /**
   * Calls `method` of the draft's server code with `args`, as a screen's
   * `call` does, in the draft's preview: nothing it does leaves the
   * preview, and it reads no real data. `revision` is the preview's:
   * `app.preview_outdated` once the draft changed.
   */
  previewCall: (
    chatId: string,
    app: string,
    revision: number,
    method: string,
    args: unknown[]
  ) => Promise<unknown>;
  /**
   * Tells the chat's agent how the preview of the draft at `revision`
   * runs on `screen`: `problem`, one its screen reported (an uncaught
   * error, an unhandled rejection or a `console.error`), or, without one,
   * that it rendered. Its next check of the draft reads them. A report of
   * a revision the draft moved past is dropped.
   */
  previewReport: (
    chatId: string,
    app: string,
    revision: number,
    screen: string,
    problem?: ScreenProblem
  ) => Promise<void>;
  /** Stops the agent's work on the chat; `false` when there was none. */
  cancel: (chatId: string) => Promise<boolean>;
  /** The connections the chat's agent asked for that wait, oldest first. */
  connectionRequests: (chatId: string) => Promise<ChatConnectionRequest[]>;
  /**
   * Grants the chat's request `id` as it was asked for, in this chat
   * alone: only for the person's own personal connection, while it is
   * connected and offered. Audited; the agent is told.
   */
  grantConnection: (chatId: string, id: string) => Promise<void>;
  /**
   * Denies (or, for a shared connection, withdraws) the chat's request
   * `id`. Audited; the agent is told.
   */
  denyConnection: (chatId: string, id: string) => Promise<void>;
  /**
   * Follows the chat: `onUpdate` gets the messages after the one with ID
   * `after` (all of them for `null`) and what the agent is writing, then
   * every change. Watching again with the last message seen resumes after
   * a lost connection; with `null`, after a reload.
   */
  watch: (
    chatId: string,
    after: number | null,
    onUpdate: (update: ChatUpdate) => void
  ) => Promise<ChatSubscriptionApi>;
}
