// A draft: a source and the statements taken from it, as someone reviews
// them before they are saved to the Playbook. Read here from whatever the
// screen (or a workflow) sends, trimmed and bounded, so the server keeps
// only drafts that fit the Playbook's types (app/records.json) once saved.

/** What a statement can be about: its tags. */
export const statementTags = [
  "goal",
  "blocker",
  "time_sink",
  "handover",
  "tool",
  "rule",
] as const;
export type StatementTag = (typeof statementTags)[number];

/** How a source was given. */
export const sourceMedia = ["interview", "chat", "document", "other"] as const;
export type SourceMedium = (typeof sourceMedia)[number];

/** The source statements come from. */
export interface DraftSource {
  title: string;
  medium: SourceMedium;
  /** YYYY-MM-DD. */
  date: string;
  /** Who it came from: a name or a role; empty when unknown. */
  from: string;
  /** The notes it was taken from, kept as the source's body. */
  notes: string;
}

/** One claim from the source. */
export interface DraftStatement {
  /** The claim itself, the statement's title. */
  text: string;
  tags: StatementTag[];
  /** What the source said, briefly; empty for none. */
  quote: string;
}

export interface Draft {
  source: DraftSource;
  statements: DraftStatement[];
}

/** Longest title, name or claim: the Playbook's title limit. */
export const shortTextMax = 200;

/** Longest quote. */
export const quoteMax = 1000;

/**
 * Longest notes: well inside a Knowledge document and a run's input
 * (128 KiB of JSON), however many bytes a character takes.
 */
export const notesMax = 30_000;

/** Most statements one draft holds. */
export const statementsMax = 100;

/** Refuses a call with `code`, which the screen explains. */
export const refuse = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const invalid = (message: string): never => refuse("intake.invalid", message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` trimmed, when it is text of at most `max` characters. */
const textOf = (value: unknown, what: string, max: number): string => {
  if (typeof value !== "string") {
    return invalid(`${what} isn't text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return invalid(`${what} is longer than ${max} characters.`);
  }
  return trimmed;
};

const requiredTextOf = (value: unknown, what: string, max: number): string => {
  const text = textOf(value, what, max);
  return text === "" ? invalid(`${what} is empty.`) : text;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

/** A calendar date as YYYY-MM-DD, one that exists. */
export const isDate = (value: string): boolean =>
  datePattern.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

const isMedium = (value: unknown): value is SourceMedium =>
  sourceMedia.some((medium) => medium === value);

const isTag = (value: unknown): value is StatementTag =>
  statementTags.some((tag) => tag === value);

const sourceOf = (value: unknown): DraftSource => {
  if (!isRecord(value)) {
    return invalid("The source is missing.");
  }
  const date = textOf(value.date, "The date", 10);
  if (!isDate(date)) {
    invalid("The date isn't a date (YYYY-MM-DD).");
  }
  if (!isMedium(value.medium)) {
    return invalid("The source is an interview, a chat, a document or other.");
  }
  return {
    title: requiredTextOf(value.title, "The source's title", shortTextMax),
    medium: value.medium,
    date,
    from: textOf(value.from ?? "", "Who it came from", shortTextMax),
    notes: textOf(value.notes ?? "", "The notes", notesMax),
  };
};

const statementOf = (value: unknown, position: number): DraftStatement => {
  if (!isRecord(value)) {
    return invalid(`Statement ${position} is missing.`);
  }
  const { tags } = value;
  if (!Array.isArray(tags) || tags.length === 0 || !tags.every(isTag)) {
    return invalid(`Statement ${position} needs at least one tag.`);
  }
  return {
    text: requiredTextOf(value.text, `Statement ${position}`, shortTextMax),
    // Each once, in the order they are listed in.
    tags: statementTags.filter((tag) => tags.includes(tag)),
    quote: textOf(value.quote ?? "", `Statement ${position}'s quote`, quoteMax),
  };
};

/**
 * A draft read from `value`, trimmed, or refused with `intake.invalid`
 * saying what doesn't fit.
 */
export const draftOf = (value: unknown): Draft => {
  if (!isRecord(value) || !Array.isArray(value.statements)) {
    return invalid("A draft has a source and a list of statements.");
  }
  if (value.statements.length > statementsMax) {
    invalid(`A draft holds at most ${statementsMax} statements.`);
  }
  return {
    source: sourceOf(value.source),
    statements: value.statements.map((statement: unknown, index) =>
      statementOf(statement, index + 1)
    ),
  };
};
