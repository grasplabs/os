// What the intake's server answers (app/server.ts), as its screen reads
// it, and the checks the screen makes before it sends a draft: the same
// bounds as the server's (app/draft.ts), which checks them again.

import { callServer } from "@grasp-os/sdk/screen";

/** What a statement can be about, and how the screen names each. */
export const tagLabels = {
  goal: "Goal",
  blocker: "Blocker",
  time_sink: "Time sink",
  handover: "Handover",
  tool: "Tool",
  rule: "Rule",
} as const;
export type StatementTag = keyof typeof tagLabels;
export const statementTags = [
  "goal",
  "blocker",
  "time_sink",
  "handover",
  "tool",
  "rule",
] as const satisfies readonly StatementTag[];

/** How a source was given, and how the screen names each. */
export const mediumLabels = {
  interview: "Interview",
  chat: "Chat",
  document: "Document",
  other: "Other",
} as const;
export type SourceMedium = keyof typeof mediumLabels;
export const sourceMedia = [
  "interview",
  "chat",
  "document",
  "other",
] as const satisfies readonly SourceMedium[];

export interface DraftSource {
  title: string;
  medium: SourceMedium;
  /** YYYY-MM-DD. */
  date: string;
  from: string;
  notes: string;
}

export interface DraftStatement {
  text: string;
  tags: StatementTag[];
  quote: string;
}

export interface Draft {
  source: DraftSource;
  statements: DraftStatement[];
}

/** Where a draft came from, and how the screen names each. */
export const originLabels = {
  manual: "Typed in",
  notes: "Notes",
} as const;
export type Origin = keyof typeof originLabels;

export interface DraftSummary {
  id: string;
  version: number;
  origin: Origin;
  /** `saving` once a save started: it can only be finished. */
  status: "open" | "saving";
  title: string;
  date: string;
  statements: number;
  createdBy: string;
  createdAt: string;
}

export interface OpenedDraft extends DraftSummary {
  draft: Draft;
}

export interface Overview {
  access: "none" | "ok";
  /** Whether the person may change the Playbook: intake is only theirs. */
  writable: boolean;
  drafts: DraftSummary[];
}

/** What a save answers: the source's path and how many statements. */
export interface Saved {
  source: string;
  statements: number;
}

/** A server call's answer, or the code of why it was refused. */
export type Outcome<T> = { ok: T } | { error: string };

export const shortTextMax = 200;
export const quoteMax = 1000;
export const notesMax = 30_000;
export const statementsMax = 100;

/** Today, as YYYY-MM-DD, where the person is. */
export const today = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

/** A new draft, with nothing in it yet. */
export const emptyDraft = (): Draft => ({
  source: {
    title: "",
    medium: "interview",
    date: today(),
    from: "",
    notes: "",
  },
  statements: [],
});

/** A new statement, with nothing in it yet. */
export const emptyStatement = (): DraftStatement => ({
  text: "",
  tags: [],
  quote: "",
});

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Why `draft` can't be kept as it is, if it can't: what the server would
 * refuse, said before it is sent. Saving it also needs a statement.
 */
export const draftProblem = (draft: Draft): string | undefined => {
  const { source, statements } = draft;
  if (source.title.trim() === "") {
    return "Give the source a title.";
  }
  if (!datePattern.test(source.date)) {
    return "Give the source its date.";
  }
  if (source.notes.length > notesMax) {
    return `Notes are at most ${notesMax.toLocaleString()} characters.`;
  }
  if (statements.length > statementsMax) {
    return `A source has at most ${statementsMax} statements.`;
  }
  for (const [index, statement] of statements.entries()) {
    if (statement.text.trim() === "") {
      return `Write statement ${index + 1}, or remove it.`;
    }
    if (statement.tags.length === 0) {
      return `Tag statement ${index + 1}.`;
    }
  }
  return undefined;
};

const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "app.unreachable";

/**
 * What `run` resolves with, or the code of why it rejected: for the
 * platform's calls (a run started, read), which reject when refused.
 */
export const settle = async <T>(run: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: codeOf(error) };
  }
};

/**
 * Calls the server's `method`: its answer, or, when the call itself fails
 * (the connection, the platform), why, as a refusal the screen shows. So
 * no call ends in an unhandled rejection.
 */
export const ask = async <T>(
  method: string,
  ...args: unknown[]
): Promise<Outcome<T>> => {
  try {
    return await callServer<Outcome<T>>(method, ...args);
  } catch (error) {
    return { error: codeOf(error) };
  }
};

/** What a refusal means to the person taking intake. */
export const refusal = (code: string): string => {
  switch (code) {
    case "intake.conflict": {
      return "Someone changed this draft since you opened it. Open it again to see their changes.";
    }
    case "intake.not_found": {
      return "This draft is gone: someone saved or discarded it.";
    }
    case "intake.invalid":
    case "knowledge.invalid": {
      return "That doesn't fit: check every statement has text and a tag, and the source a title and a date.";
    }
    case "intake.discarded": {
      return "This draft was discarded while it was being saved. Records already written stay in the Playbook.";
    }
    case "intake.not_owner": {
      return "Another copy of the intake keeps the Playbook's sources and statements: an admin grants the Playbook to the one copy to use.";
    }
    case "intake.path_taken": {
      return "Something else is already where this draft would be saved, so it wasn't saved over it. Discard the draft and take it again.";
    }
    case "intake.no_statements": {
      return "Add a statement to save.";
    }
    case "knowledge.forbidden": {
      return "Only admins take intake.";
    }
    case "permission.denied": {
      return "Intake can't use the Playbook: an admin approves its permission first.";
    }
    case "permission.restricted": {
      return "Intake read restricted data, so it can't write to the Playbook, which everyone reads.";
    }
    case "app.unreachable": {
      return "Grasp can't be reached right now. Try again in a moment.";
    }
    case "app.failed": {
      return "Intake failed. Try again in a moment.";
    }
    default: {
      return `That didn't work (${code}).`;
    }
  }
};
