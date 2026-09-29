import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewProblem } from "@grasp-os/shared/chat";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import type { ChatId } from "@grasp-os/shared/ids";

// What a chat's preview of its draft reported (preview.ts), for the
// agent's next check of the draft (agent-builds.ts): the repair loop reads
// runtime errors as it reads build errors, within the same limits.
//
// The side panel reports what the preview's screen reported (uncaught
// errors, unhandled rejections, `console.error` calls), and that it
// rendered; core adds what the draft's server code failed with. Only the
// draft's current revision's reports are kept, at most
// {@link maxProblems}, in memory: a restart loses them, and the next check
// finds the preview unseen until the panel reports again.
//
// A report is text the draft's code wrote, or what the person typed into
// the preview. It reaches the agent only as data in a check's result,
// never as instructions (agent-builds.ts). A preview reads no real data
// (preview-bindings.ts), so it carries none.

/** Most problems kept of one revision's preview: the first ones. */
const maxProblems = 10;

/** How long an open preview counts as open without reporting again. */
const openForMs = 10 * 60 * 1000;

/** A problem as a check answers it: whether a preview refused what caused it. */
export interface ReportedProblem extends PreviewProblem {
  /**
   * It came from what a preview refuses on purpose (a connection, another
   * App, a write to Knowledge): the draft may be right, so it doesn't fail
   * the check.
   */
  refused: boolean;
}

/** How the preview of a draft's revision ran, as a check reads it. */
export interface PreviewOutcome {
  /**
   * `failed`: it reported problems; `passed`: it rendered and reported
   * none; `unseen`: nobody had it open, or it didn't report in time.
   */
  status: "passed" | "failed" | "unseen";
  problems: ReportedProblem[];
}

/** What one preview reported of one revision. */
interface Reports {
  revision: number;
  rendered: boolean;
  problems: PreviewProblem[];
  /** Resolved at the next report, then replaced. */
  next: PromiseWithResolvers<void>;
}

/** Whether a problem came from what a preview refuses. */
const refusedText = appErrors.create("app.preview_side_effect").message;

const outcomeOf = ({ rendered, problems }: Reports): PreviewOutcome => {
  const reported = problems.map((problem) => ({
    ...problem,
    refused:
      problem.message.includes(refusedText) ||
      (problem.stack?.includes(refusedText) ?? false),
  }));
  if (reported.some(({ refused }) => !refused)) {
    return { status: "failed", problems: reported };
  }
  return { status: rendered ? "passed" : "unseen", problems: reported };
};

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
 * nothing for a failure that isn't the draft's (a session that ended, a
 * preview out of date).
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

/** The preview reports of one Workspace object's chats (workspace.ts). */
export class PreviewReports {
  readonly #reports = new Map<string, Reports>();

  /** When each preview was last open (loaded, or reporting), by key. */
  readonly #open = new Map<string, number>();

  /** Notes that the person has the chat's preview of `app` open. */
  opened(chatId: ChatId, app: string): void {
    this.#open.set(keyOf(chatId, app), Date.now());
  }

  /**
   * Keeps `problem`, one the preview of the draft of `app` at `revision`
   * ran into, or, without one, that it rendered. What an earlier revision
   * reported goes once a later one reports.
   */
  report(
    chatId: ChatId,
    app: string,
    revision: number,
    problem?: PreviewProblem
  ): void {
    const key = keyOf(chatId, app);
    this.#open.set(key, Date.now());
    let reports = this.#reports.get(key);
    if (reports !== undefined && reports.revision > revision) {
      return;
    }
    if (reports?.revision !== revision) {
      reports?.next.resolve();
      reports = {
        revision,
        rendered: false,
        problems: [],
        next: Promise.withResolvers(),
      };
      this.#reports.set(key, reports);
    }
    if (problem === undefined) {
      reports.rendered = true;
    } else if (reports.problems.length < maxProblems) {
      reports.problems.push(problem);
    }
    const { next } = reports;
    reports.next = Promise.withResolvers();
    next.resolve();
  }

  /**
   * How the preview of the draft of `app` at `revision` ran: waiting up
   * to `waitMs` for it to report, while the person has it open and it
   * hasn't yet.
   */
  async outcome(
    chatId: ChatId,
    app: string,
    revision: number,
    waitMs: number
  ): Promise<PreviewOutcome> {
    const key = keyOf(chatId, app);
    const limit = deadline(waitMs);
    try {
      for (;;) {
        const reports = this.#reports.get(key);
        const now =
          reports?.revision === revision
            ? outcomeOf(reports)
            : { status: "unseen" as const, problems: [] };
        const open = Date.now() - (this.#open.get(key) ?? 0) < openForMs;
        if (now.status !== "unseen" || !open || limit.signal.aborted) {
          return now;
        }
        // oxlint-disable-next-line no-await-in-loop -- until it reports, or the wait ends
        await Promise.race([
          (reports ?? this.#waitFor(key)).next.promise,
          whenAborted(limit.signal),
        ]).catch(() => {
          // The wait ended: answered as it is now, above.
        });
      }
    } finally {
      limit.clear();
    }
  }

  /** An empty entry to wait on, for a preview that hasn't reported yet. */
  #waitFor(key: string): Reports {
    const reports: Reports = {
      revision: -1,
      rendered: false,
      problems: [],
      next: Promise.withResolvers(),
    };
    this.#reports.set(key, reports);
    return reports;
  }

  /** Forgets the chat's preview of `app`, and what it reported. */
  drop(chatId: ChatId, app: string): void {
    const key = keyOf(chatId, app);
    this.#reports.get(key)?.next.resolve();
    this.#reports.delete(key);
    this.#open.delete(key);
  }
}
