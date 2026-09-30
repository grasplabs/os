import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewProblem } from "@grasp-os/shared/chat";
import type { ChatId } from "@grasp-os/shared/ids";
import type { ServerLog } from "@grasp-os/shared/screens";

// What a chat's preview of its draft ran into (preview.ts), for the
// agent's next check of the draft (agent-builds.ts): a plain list, read as
// it is when the check runs, and failing it while it has anything. The
// side panel adds what the preview's screen reported (uncaught errors,
// unhandled rejections, `console.error` calls); core adds what the draft's
// server code failed with on the screen's calls. The agent's own calls
// (`env.build.call`) answer it directly and add nothing here. Next to the
// problems, what the draft's server code wrote with `console`, on anyone's
// calls (server-logs.ts): for the agent to read, failing nothing.
//
// Only the draft's current revision's problems are kept, in memory: a
// write starts the list afresh, and a restart loses it. With them, whether
// the side panel reported on that revision at all (a problem, or a server
// call of its screen; never the agent's calls or logs): a check right
// after a write waits a moment for the preview to catch up
// (agent-builds.ts), and says when it didn't. It waits only while the
// person has the preview open in the side panel (loaded, called or
// reported on lately); the agent's own calls don't count.
//
// A problem is text the draft's code wrote, or what the person typed into
// the preview. It reaches the agent only as data in a check's result,
// never as instructions (agent-builds.ts). A preview reads no real data
// (preview-bindings.ts), so it carries none.

/** Most problems kept of one revision: the first ones. */
const maxProblems = 10;

/** Most lines of server `console` output kept of one revision: the newest. */
const maxLogs = 50;

/**
 * How long a preview counts as open in the side panel after it was last
 * loaded, called or reported on: a check waits for it only while open.
 */
const openForMs = 10 * 60 * 1000;

const keyOf = (chatId: ChatId, app: string): string => `${chatId}:${app}`;

/** The failures of a preview's server call that are the draft's to fix. */
const draftFailures = new Set([
  "app.failed",
  "app.timed_out",
  "app.answer_invalid",
  "app.method_invalid",
  "app.build_failed",
]);

/** Most characters of a server failure's message kept. */
const maxMessage = 2000;

/**
 * What a preview's call of `method` failed with, as a problem of the
 * draft's server code: the draft's own message for `app.failed`, and
 * nothing for a failure that isn't the draft's (a refusal of the
 * preview's, a session that ended, a preview out of date).
 */
export const serverProblem = (
  method: string,
  error: unknown
): PreviewProblem | undefined => {
  const code = appErrors.codeOf(error);
  if (code === undefined || !draftFailures.has(code)) {
    return undefined;
  }
  const details =
    error instanceof Error && "details" in error ? error.details : undefined;
  const own =
    typeof details === "object" &&
    details !== null &&
    "message" in details &&
    typeof details.message === "string"
      ? details.message
      : undefined;
  const message = own ?? (error instanceof Error ? error.message : code);
  return {
    source: "server",
    at: method,
    kind: "failed",
    message: message.slice(0, maxMessage),
  };
};

/**
 * What a preview of one revision ran into, what its server logged, and
 * whether the side panel reported on it at all (`seen`).
 */
export interface Reports {
  problems: PreviewProblem[];
  logs: ServerLog[];
  seen: boolean;
}

/** The preview reports of one Workspace object's chats (workspace.ts). */
export class PreviewReports {
  readonly #reports = new Map<string, Reports & { revision: number }>();

  /** When the side panel was last on each preview, by key (`opened`). */
  readonly #open = new Map<string, number>();

  /**
   * The reports of the preview of the draft of `app` at `revision`, to
   * add to: undefined for an earlier revision than the one kept, whose
   * reports are dropped; a later one starts afresh.
   */
  #at(chatId: ChatId, app: string, revision: number): Reports | undefined {
    const key = keyOf(chatId, app);
    const kept = this.#reports.get(key);
    if (kept !== undefined && kept.revision > revision) {
      return undefined;
    }
    if (kept?.revision === revision) {
      return kept;
    }
    const fresh = { revision, problems: [], logs: [], seen: false };
    this.#reports.set(key, fresh);
    return fresh;
  }

  /** Notes that the side panel reported on the draft of `app` at `revision`. */
  saw(chatId: ChatId, app: string, revision: number): void {
    this.opened(chatId, app);
    const reports = this.#at(chatId, app, revision);
    if (reports !== undefined) {
      reports.seen = true;
    }
  }

  /**
   * Keeps `problem`, one the preview of the draft of `app` at `revision`
   * ran into, while there's room: the first ones.
   */
  report(
    chatId: ChatId,
    app: string,
    revision: number,
    problem: PreviewProblem
  ): void {
    this.opened(chatId, app);
    const reports = this.#at(chatId, app, revision);
    if (reports === undefined) {
      return;
    }
    reports.seen = true;
    if (reports.problems.length < maxProblems) {
      reports.problems.push(problem);
    }
  }

  /**
   * Keeps `logs`, what the server code of the draft of `app` at `revision`
   * wrote with `console` in its preview (server-logs.ts): the newest ones.
   */
  log(chatId: ChatId, app: string, revision: number, logs: ServerLog[]): void {
    const reports = this.#at(chatId, app, revision);
    if (reports !== undefined) {
      reports.logs = [...reports.logs, ...logs].slice(-maxLogs);
    }
  }

  /** What the preview of the draft of `app` at `revision` reported. */
  read(chatId: ChatId, app: string, revision: number): Reports {
    const reports = this.#reports.get(keyOf(chatId, app));
    return reports?.revision === revision
      ? { problems: reports.problems, logs: reports.logs, seen: reports.seen }
      : { problems: [], logs: [], seen: false };
  }

  /**
   * Notes that the person has the chat's preview of `app` open in the side
   * panel: it loaded it, called its server, or reported.
   */
  opened(chatId: ChatId, app: string): void {
    this.#open.set(keyOf(chatId, app), Date.now());
  }

  /** Whether the side panel was on the chat's preview of `app` lately. */
  isOpen(chatId: ChatId, app: string): boolean {
    const at = this.#open.get(keyOf(chatId, app));
    return at !== undefined && Date.now() - at < openForMs;
  }

  /** Forgets what the chat's preview of `app` ran into, and that it was open. */
  drop(chatId: ChatId, app: string): void {
    this.#reports.delete(keyOf(chatId, app));
    this.#open.delete(keyOf(chatId, app));
  }
}
