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
// not, and a preview passes only once it has run a moment past rendering
// with none, so an error that comes a little later still counts.
//
// A preview refuses some calls on purpose (preview-bindings.ts, and the
// page for a screen's calls on workflow runs, screen-host.ts). Whether a
// problem came of one is never read from what the draft's code wrote,
// which it could forge: only core marks a problem `refused`, for a server
// call during which a preview stub refused a call (`Previews.call`
// tracks them, by the call's own caller token), and such a problem fails
// nothing. What a screen reports is always the draft's: a refused call
// rejects with `app.preview_side_effect`, as a failed call does live, and
// a screen must handle it as it would handle that.
//
// A report is text the draft's code wrote, or what the person typed into
// the preview. It reaches the agent only as data in a check's result,
// never as instructions (agent-builds.ts). A preview reads no real data
// (preview-bindings.ts), so it carries none.

/** Most problems the draft caused kept of one revision: the first ones. */
const maxProblems = 10;

/** Most refused problems kept of one revision, apart from those. */
const maxRefusedKept = 3;

/** How long an open preview counts as open without reporting again. */
const openForMs = 10 * 60 * 1000;

/**
 * How long a preview runs past rendering, with no problem, before it
 * passes: an error a moment later (a load after the first render) still
 * fails it.
 */
export const settleMs = 1000;

/** A problem as a check answers it: whether a preview refused what caused it. */
export interface ReportedProblem extends PreviewProblem {
  /**
   * A server call that failed after a stub of the preview refused one of
   * its calls (a connection, another App, a write to Knowledge), as core
   * saw it: the draft may be right, so it doesn't fail the check.
   */
  refused: boolean;
}

/** How the preview of a draft's revision ran, as a check reads it. */
export interface PreviewOutcome {
  /**
   * `failed`: it reported problems the draft caused; `passed`: it ran
   * past rendering with none; `unseen`: nobody had it open, or it didn't
   * report in time.
   */
  status: "passed" | "failed" | "unseen";
  problems: ReportedProblem[];
}

/** What one preview reported of one revision. */
interface Reports {
  revision: number;
  /** When it said it rendered, in milliseconds since the epoch. */
  renderedAt: number | undefined;
  /** The first problems of each kind, as a check answers them. */
  problems: ReportedProblem[];
  /**
   * Problems the draft caused, kept or not: a check fails on any, so one
   * past {@link maxProblems} still fails it.
   */
  failed: number;
  /** Resolved at the next report, then replaced. */
  next: PromiseWithResolvers<void>;
}

/** How `reports` stand `now`, and until when a pass must wait to settle. */
const outcomeOf = (
  { renderedAt, problems, failed }: Reports,
  now: number
): PreviewOutcome & { settlesAt?: number } => {
  if (failed > 0) {
    return { status: "failed", problems };
  }
  if (renderedAt === undefined) {
    return { status: "unseen", problems };
  }
  const settlesAt = renderedAt + settleMs;
  return settlesAt <= now
    ? { status: "passed", problems }
    : { status: "unseen", problems, settlesAt };
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
 * Counts `problem` in `reports`, and keeps it while there's room for its
 * kind, so refused problems in numbers crowd out no real one.
 */
const keepProblem = (
  reports: Reports,
  problem: PreviewProblem,
  refused: boolean
): void => {
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
  renderedAt: undefined,
  problems: [],
  failed: 0,
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
   * Keeps `problem`, one the preview of the draft of `app` at `revision`
   * ran into, or, without one, that it rendered. `refused`, which only
   * core sets (never from a report's text), for a server call a preview
   * stub refused a call of. What an earlier revision reported goes once a
   * later one reports.
   */
  report(
    chatId: ChatId,
    app: string,
    revision: number,
    problem?: PreviewProblem,
    refused = false
  ): void {
    const key = keyOf(chatId, app);
    this.#open.set(key, Date.now());
    const reports = this.#at(key, revision);
    if (reports === undefined) {
      return;
    }
    if (problem === undefined) {
      reports.renderedAt ??= Date.now();
    } else {
      keepProblem(reports, problem, refused);
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
   * to `waitMs`, while the person has it open, for it to report, and past
   * rendering until it settles. Out of time, a preview that rendered with
   * no problem yet passes.
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
        const { settlesAt, ...now } =
          reports?.revision === revision
            ? outcomeOf(reports, Date.now())
            : { status: "unseen" as const, problems: [] };
        const open = Date.now() - (this.#open.get(key) ?? 0) < openForMs;
        if (now.status !== "unseen") {
          return now;
        }
        if (limit.signal.aborted || (!open && settlesAt === undefined)) {
          return settlesAt === undefined ? now : { ...now, status: "passed" };
        }
        const settled =
          settlesAt === undefined
            ? []
            : [scheduler.wait(Math.max(0, settlesAt - Date.now()))];
        // oxlint-disable-next-line no-await-in-loop -- until it reports or settles, or the wait ends
        await Promise.race([
          (reports ?? this.#waitFor(key)).next.promise,
          ...settled,
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
