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
// draft's current revision's reports are kept, in memory: a restart loses
// them, and the next check finds the preview unseen until the panel
// reports again. Each problem the draft caused fails the check, kept or
// not.
//
// A preview refuses some calls on purpose (preview-bindings.ts), and a
// problem those cause may be no fault of the draft's: so each refusal is
// recorded here, by an ID its message carries (`previewRefusal`), and
// only a problem whose message quotes one that was recorded counts as
// refused, which fails nothing. Text alone, the refusal's wording in a
// message or a stack, proves nothing.
//
// A report is text the draft's code wrote, or what the person typed into
// the preview. It reaches the agent only as data in a check's result,
// never as instructions (agent-builds.ts). A preview reads no real data
// (preview-bindings.ts), so it carries none.

/** Most problems the draft caused kept of one revision: the first ones. */
const maxProblems = 10;

/** Most refused problems kept of one revision, apart from those. */
const maxRefusedKept = 3;

/** Most refusals recorded of one revision. */
const maxRefusals = 100;

/** How long an open preview counts as open without reporting again. */
const openForMs = 10 * 60 * 1000;

/** A problem as a check answers it: whether a preview refused what caused it. */
export interface ReportedProblem extends PreviewProblem {
  /**
   * It quotes a refusal a stub of the preview made (a connection, another
   * App, a write to Knowledge): the draft may be right, so it doesn't fail
   * the check.
   */
  refused: boolean;
}

/** How the preview of a draft's revision ran, as a check reads it. */
export interface PreviewOutcome {
  /**
   * `failed`: it reported problems the draft caused; `passed`: it
   * rendered and reported none; `unseen`: nobody had it open, or it
   * didn't report in time.
   */
  status: "passed" | "failed" | "unseen";
  problems: ReportedProblem[];
}

/** What one preview reported of one revision. */
interface Reports {
  revision: number;
  rendered: boolean;
  /** The first problems of each kind, as a check answers them. */
  problems: ReportedProblem[];
  /**
   * Problems the draft caused, kept or not: a check fails on any, so one
   * past {@link maxProblems} still fails it.
   */
  failed: number;
  /** The refusals the preview's stubs made (`refused`), by ID. */
  refusals: Set<string>;
  /** Resolved at the next report, then replaced. */
  next: PromiseWithResolvers<void>;
}

const outcomeOf = ({ rendered, problems, failed }: Reports): PreviewOutcome => {
  if (failed > 0) {
    return { status: "failed", problems };
  }
  return { status: rendered ? "passed" : "unseen", problems };
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

/**
 * A refusal of a preview's stub (preview-bindings.ts), as the draft's
 * code gets it: `app.preview_side_effect`, its message naming `id`, the
 * refusal core recorded (`PreviewReports.refused`).
 */
export const previewRefusal = (id: string): Error => {
  const refusal = appErrors.create("app.preview_side_effect", {
    refusal: id,
  });
  refusal.message = `${refusal.message} (refusal ${id})`;
  return refusal;
};

/** The ID `previewRefusal` puts in a message, wherever it is quoted. */
const refusalIds = /\(refusal (?<id>[\da-f-]{36})\)/gu;

/** A refusal recorded in `reports` that `message` quotes, if any. */
const refusalQuoted = (reports: Reports, message: string): string | undefined =>
  [...message.matchAll(refusalIds)]
    .map(({ groups }) => groups?.id)
    .find((id) => id !== undefined && reports.refusals.has(id));

/**
 * Counts `problem` in `reports`, and keeps it while there's room for its
 * kind: refused only when it quotes a refusal the preview's stubs made,
 * so neither the text of one nor refusals in numbers hide a real error.
 */
const keepProblem = (reports: Reports, problem: PreviewProblem): void => {
  const refused = refusalQuoted(reports, problem.message) !== undefined;
  if (!refused) {
    reports.failed += 1;
  }
  const kept = reports.problems.filter((one) => one.refused === refused).length;
  if (kept < (refused ? maxRefusedKept : maxProblems)) {
    reports.problems.push({ ...problem, refused });
  }
};

/** A revision's reports before any came. */
const emptyReports = (revision: number): Reports => ({
  revision,
  rendered: false,
  problems: [],
  failed: 0,
  refusals: new Set(),
  next: Promise.withResolvers(),
});

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
   * Records that a stub of the preview of the draft of `app` at `revision`
   * refused a call (`previewRefusal`), as `id`: a problem that quotes it
   * came from what the preview refuses on purpose.
   */
  refused(chatId: ChatId, app: string, revision: number, id: string): void {
    const reports = this.#at(keyOf(chatId, app), revision);
    if (reports !== undefined && reports.refusals.size < maxRefusals) {
      reports.refusals.add(id);
    }
  }

  /**
   * The refusal of the preview of the draft of `app` at `revision` that
   * `message` quotes, if its stubs made one: what a server call that
   * failed with it failed for.
   */
  refusalIn(
    chatId: ChatId,
    app: string,
    revision: number,
    message: string
  ): string | undefined {
    const reports = this.#reports.get(keyOf(chatId, app));
    return reports?.revision === revision
      ? refusalQuoted(reports, message)
      : undefined;
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
    const reports = this.#at(key, revision);
    if (reports === undefined) {
      return;
    }
    if (problem === undefined) {
      reports.rendered = true;
    } else {
      keepProblem(reports, problem);
    }
    const { next } = reports;
    reports.next = Promise.withResolvers();
    next.resolve();
  }

  /**
   * What the preview of `key` reported of `revision`: started afresh at a
   * later revision than it has; undefined for an earlier one.
   */
  #at(key: string, revision: number): Reports | undefined {
    const reports = this.#reports.get(key);
    if (reports !== undefined && reports.revision > revision) {
      return undefined;
    }
    if (reports?.revision === revision) {
      return reports;
    }
    reports?.next.resolve();
    const fresh = emptyReports(revision);
    this.#reports.set(key, fresh);
    return fresh;
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
    const reports = emptyReports(-1);
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
