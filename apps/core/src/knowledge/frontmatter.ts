import { issuesOf } from "@grasp-os/shared/errors";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import {
  builtinDocumentTypeSchema,
  documentPathSchema,
  documentTypeSchema,
  isBuiltinDocumentType,
  splitFrontmatterBlock,
} from "@grasp-os/shared/knowledge";
import type {
  BuiltinDocumentType,
  DocumentType,
} from "@grasp-os/shared/knowledge";
import { isMap, isScalar, isSeq, parse, parseDocument } from "yaml";
import { z } from "zod";

import type { DeclaredTypes } from "./record-types.ts";

// A document's frontmatter: the YAML block between `---` lines at its top.
// Its `type` picks the schema the rest must match. The text keeps any other
// keys as they are; only these are read.

/** Fields every type has. */
const baseSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  /** When to use it: what agents see before they read it. */
  description: z.string().trim().max(1024).default(""),
  owner: z.string().trim().min(1).max(256).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  /** When it should be reviewed next. */
  review: z.iso.date().optional(),
});

/**
 * An Agent Skill (`SKILL.md`): its name and description are required, as
 * the Agent Skills format has them.
 */
const skillSchema = baseSchema.extend({
  name: z
    .string()
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
      "Lowercase letters, digits and single hyphens"
    ),
  description: z.string().trim().min(1).max(1024),
});

/** A decision, and where it stands. */
const decisionSchema = baseSchema.extend({
  status: z.enum(["proposed", "accepted", "superseded"]).optional(),
});

/** Text extracted from an uploaded file: the original's name and type. */
const fileSchema = baseSchema.extend({
  original: z.string().trim().min(1).max(256).optional(),
  mediaType: z.string().trim().min(1).max(128).optional(),
});

// The Playbook's records. The structure is here; what a person reads is
// the Markdown after it: the title names the record, the body says the
// rest. A record names others by their path in the Playbook, as `[[links]]`
// do. Wherever a name can be, a value is plain text, so a purge that
// replaces a name with its marker leaves a record that still fits its
// type. A path that holds a name is purged like any text, and the path
// then names no document, but for a snapshot's frozen workflow paths,
// which a purge leaves (`frozenPathRanges`): the snapshot must name
// versions the Playbook has.

/** Longest short value a person writes. */
export const shortTextMax = 200;

/** A short value a person writes: a name, a role, a tool. */
const shortText = z.string().trim().min(1).max(shortTextMax);

/** Another record, by its path in the Playbook: `people/anna.md`. */
const recordPath = documentPathSchema;

/** A person, with their role and team. Their name is the title. */
const personSchema = baseSchema.extend({
  role: shortText.optional(),
  team: recordPath.optional(),
});

/** A tool the company uses, and who makes it. */
const toolSchema = baseSchema.extend({
  vendor: shortText.optional(),
});

/** Where statements come from: an interview, a chat, a document. */
const sourceSchema = baseSchema.extend({
  medium: z.enum(["interview", "chat", "document", "other"]).optional(),
  date: z.iso.date().optional(),
  /** Who it is from. */
  person: recordPath.optional(),
});

/** A claim from a source, and what it is about. */
const statementSchema = baseSchema.extend({
  source: recordPath,
  topic: z.enum(["goal", "blocker", "time_sink", "handover", "tool", "rule"]),
});

/** Largest number a workflow step has: frequency, minutes or people. */
const stepNumberMax = 10_000;

/** A number, and whether it was estimated or observed (in runs). */
const stepNumber = z.strictObject({
  value: z.number().min(0).max(stepNumberMax),
  basis: z.enum(["estimated", "observed"]),
});

/** One step of a workflow: who does it, with what, and how often. */
const stepSchema = z.strictObject({
  name: shortText,
  who: shortText.optional(),
  tool: shortText.optional(),
  /** Whether the work passes to someone else after this step. */
  handover: z.boolean().default(false),
  /** How a designed step is done. */
  kind: z.enum(["automated", "ai_checked", "tool", "instruction"]).optional(),
  numbers: z
    .strictObject({
      /** Times a week. */
      frequency: stepNumber.optional(),
      /** Minutes each time. */
      minutes: stepNumber.optional(),
      /** People each time. */
      people: stepNumber.optional(),
    })
    .optional(),
});

/** Most steps one workflow has. */
const workflowMaxSteps = 100;

/** Most parameters one workflow has. */
const workflowMaxParameters = 50;

/** Most hours a week a workflow is expected to save. */
const gainMaxHoursPerWeek = 100_000;

/**
 * A workflow as it runs now (`drawn`) or as it should (`designed`). Once
 * built, a designed one names the App workflow that runs it, by IDs only
 * (playbook.ts links it).
 */
const workflowSchema = baseSchema
  .extend({
    state: z.enum(["drawn", "designed"]),
    team: recordPath.optional(),
    steps: z.array(stepSchema).max(workflowMaxSteps).default([]),
    /** What can be set for it, such as a threshold. */
    parameters: z
      .array(
        z.strictObject({
          name: shortText,
          value: z.string().trim().max(1000).optional(),
        })
      )
      .max(workflowMaxParameters)
      .default([]),
    /** What it is expected to save. */
    gain: z
      .strictObject({
        hoursPerWeek: z.number().min(0).max(gainMaxHoursPerWeek),
      })
      .optional(),
    app: z
      .strictObject({ appId: appIdSchema, workflowId: workflowIdSchema })
      .optional(),
  })
  .refine(({ state, app }) => app === undefined || state === "designed", {
    path: ["app"],
    message: "Only a designed workflow links to an App workflow",
  });

/** Most workflows one snapshot holds. */
const snapshotMaxWorkflows = 500;

/**
 * Most workflows one snapshot's figures hold: each freezes up to two
 * versions of its record (drawn and designed), within `workflows`.
 */
export const snapshotMaxFigures = snapshotMaxWorkflows / 2;

/** Most improvement signals one snapshot's figures hold. */
export const snapshotMaxSignals = 50;

/** Most hours a week a snapshot holds for one workflow. */
export const snapshotMaxHoursPerWeek = gainMaxHoursPerWeek;

/** Hours a week, as a snapshot freezes them. */
const hoursPerWeek = z.number().min(0).max(snapshotMaxHoursPerWeek);

/** A version of a workflow record, and the hours a week its steps take. */
const versionHours = z.strictObject({
  version: z.int().min(1),
  hoursPerWeek,
  /** Observed only when every number of its steps was. */
  basis: z.enum(["estimated", "observed"]),
});

/**
 * What a snapshot froze of one workflow record (knowledge/snapshots.ts):
 * its hours as drawn (its latest drawn version), as designed (a designed
 * one's current version), and as it runs: its designed steps at the runs
 * a week its App workflow was observed to start.
 */
const workflowFiguresSchema = z.strictObject({
  path: recordPath,
  title: shortText,
  /** Its team's title, then. */
  team: shortText.optional(),
  state: z.enum(["drawn", "designed"]),
  drawn: versionHours.optional(),
  designed: versionHours.optional(),
  running: z
    .strictObject({
      appId: appIdSchema,
      workflowId: workflowIdSchema,
      /** Runs started in the `windowDays` before the snapshot. */
      runs: z.int().min(1),
      hoursPerWeek,
    })
    .optional(),
});

/**
 * The numbers a snapshot froze when it was taken (`takeSnapshot`), which
 * nothing later changes: each workflow's hours, and the improvement
 * signals of the App workflows the Playbook links to, by the record
 * linked (its kind and value only). Only the platform writes them.
 */
const figuresSchema = z.strictObject({
  /** Days of runs the observed numbers are from. */
  windowDays: z.int().min(1).max(366),
  workflows: z.array(workflowFiguresSchema).max(snapshotMaxFigures),
  signals: z
    .array(
      z.strictObject({
        path: recordPath,
        // Any kind's name, so a kind a later release adds still reads
        // after a rollback.
        kind: z.string().regex(/^[a-z_]{1,64}$/u),
        value: z.number().min(0),
      })
    )
    .max(snapshotMaxSignals),
});

/**
 * A dated freeze of the Playbook: the workflow records at the versions it
 * was taken from, which later saves don't change, and the maturity then.
 * One taken by the platform also holds its `figures`, and the decision it
 * puts to the board.
 */
const snapshotSchema = baseSchema.extend({
  date: z.iso.date(),
  maturity: z.int().min(0).max(5).optional(),
  workflows: z
    .array(z.strictObject({ path: recordPath, version: z.int().min(1) }))
    .max(snapshotMaxWorkflows)
    .default([]),
  figures: figuresSchema.optional(),
  /** The one decision it asks for, in plain words. */
  decisionNeeded: z.string().trim().max(1000).optional(),
});

/** A step of the plan, and where it stands. */
const planItemSchema = baseSchema.extend({
  status: z.enum(["planned", "doing", "done", "dropped"]).default("planned"),
  due: z.iso.date().optional(),
  workflow: recordPath.optional(),
});

/** The frontmatter schema of each type. */
const frontmatterSchemas = {
  doc: baseSchema,
  skill: skillSchema,
  memory: baseSchema,
  decision: decisionSchema,
  file: fileSchema,
  vision: baseSchema,
  team: baseSchema,
  person: personSchema,
  tool: toolSchema,
  source: sourceSchema,
  statement: statementSchema,
  workflow: workflowSchema,
  snapshot: snapshotSchema,
  "plan-item": planItemSchema,
  "rulebook-entry": baseSchema,
} as const satisfies Record<BuiltinDocumentType, z.ZodType>;

type Frontmatter = z.infer<(typeof frontmatterSchemas)[BuiltinDocumentType]>;

/** Files that are a type by their name alone, as other tools write them. */
const typeByFileName: Readonly<Record<string, BuiltinDocumentType>> = {
  "SKILL.md": "skill",
  "AGENTS.md": "memory",
  "MEMORY.md": "memory",
  "USER.md": "memory",
};

/** A document's frontmatter, read and checked, and the Markdown after it. */
interface ParsedFrontmatter {
  type: BuiltinDocumentType;
  frontmatter: Frontmatter;
  body: string;
}

/** Why a document's frontmatter was refused, one line per problem. */
export class FrontmatterError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "FrontmatterError";
    this.issues = issues;
  }
}

/** The YAML between the fences, and the Markdown after them. */
const splitFrontmatter = (
  text: string
): { yaml: string | undefined; body: string } => {
  const split = splitFrontmatterBlock(text);
  if (split === undefined) {
    throw new FrontmatterError([
      "frontmatter: it starts with --- but has no closing --- line",
    ]);
  }
  return split;
};

const readYaml = (yaml: string): Record<string, unknown> => {
  let value: unknown;
  try {
    // Aliases are capped, so a small block can't expand into a huge one;
    // errors throw, and warnings aren't logged (they would quote content).
    value = parse(yaml, { maxAliasCount: 20, logLevel: "error" });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "";
    throw new FrontmatterError([`frontmatter: not valid YAML (${reason})`]);
  }
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FrontmatterError(["frontmatter: must be a list of key: value"]);
  }
  return Object.fromEntries(Object.entries(value));
};

/** The frontmatter's fields, as YAML reads them, and the Markdown after. */
const readFields = (
  text: string
): { fields: Record<string, unknown>; body: string } => {
  const { yaml, body } = splitFrontmatter(text);
  return { fields: yaml === undefined ? {} : readYaml(yaml), body };
};

/** The type `fields` say, or else the file name, or else `doc`. */
const typeIn = (path: string, fields: Record<string, unknown>): unknown => {
  const fileName = path.split("/").at(-1) ?? "";
  return fields.type ?? typeByFileName[fileName] ?? "doc";
};

/**
 * Reads and checks the frontmatter of the document at `path`. Without a
 * `type`, a document is a `doc`, unless its file name says otherwise
 * (`SKILL.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`). A document without
 * frontmatter is a `doc` with none of the optional fields.
 */
export const parseFrontmatter = (
  path: string,
  text: string
): ParsedFrontmatter => {
  const { fields, body } = readFields(text);
  const type = builtinDocumentTypeSchema.safeParse(typeIn(path, fields));
  if (!type.success) {
    throw new FrontmatterError([
      `frontmatter.type: one of ${builtinDocumentTypeSchema.options.join(", ")}`,
    ]);
  }
  const parsed = frontmatterSchemas[type.data].safeParse(fields);
  if (!parsed.success) {
    throw new FrontmatterError(issuesOf(parsed.error, "frontmatter"));
  }
  return { type: type.data, frontmatter: parsed.data, body };
};

/**
 * The type the frontmatter of the document at `path` says it is, before
 * anything checks it: `undefined` when it doesn't read at all, which
 * `parseRecord` then says why.
 */
export const frontmatterType = (
  path: string,
  text: string
): string | undefined => {
  try {
    const type = typeIn(path, readFields(text).fields);
    return typeof type === "string" ? type : undefined;
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return undefined;
    }
    throw error;
  }
};

/**
 * The frontmatter of the document at `path`, as YAML reads it, with its
 * type, checked against nothing: what a saved version holds, whether or
 * not it fits its type now (after a change of its schema, say).
 * `undefined` when it doesn't read at all.
 */
export const savedFields = (
  path: string,
  text: string
): { type: string; fields: Record<string, unknown> } | undefined => {
  try {
    const { fields } = readFields(text);
    const type = typeIn(path, fields);
    return typeof type === "string" ? { type, fields } : undefined;
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return undefined;
    }
    throw error;
  }
};

/** The fields every type has, as `baseSchema` reads them. */
type BaseFields = z.infer<typeof baseSchema>;

/**
 * A document's frontmatter, read and checked, of any type: one the
 * platform knows, or one an App declares for its collection.
 */
export interface ParsedRecord {
  type: DocumentType;
  frontmatter: BaseFields & Record<string, unknown>;
  body: string;
}

/**
 * Reads and checks the frontmatter of the document at `path` in a
 * collection whose declared record types are `declared`
 * (record-types.ts): a type the platform knows as `parseFrontmatter`
 * reads it; any other only when an App declares it for the collection,
 * against the fields every type has (`baseSchema`) and each App's schema
 * of it, their defaults filled in. Throws `FrontmatterError` otherwise.
 */
export const parseRecord = (
  path: string,
  text: string,
  declared: DeclaredTypes
): ParsedRecord => {
  const { fields, body } = readFields(text);
  const named = typeIn(path, fields);
  if (typeof named === "string" && isBuiltinDocumentType(named)) {
    const { type, frontmatter } = parseFrontmatter(path, text);
    return { type, frontmatter, body };
  }
  const type = documentTypeSchema.safeParse(named);
  const rule = type.success ? declared.get(type.data) : undefined;
  if (!type.success || rule === undefined) {
    throw new FrontmatterError([
      `frontmatter.type: one of ${builtinDocumentTypeSchema.options.join(", ")}, or a record type an App declares for this collection`,
    ]);
  }
  const { type: _type, ...rest } = fields;
  const base = baseSchema.safeParse(rest);
  const issues = base.success ? [] : issuesOf(base.error, "frontmatter");
  const parsed = rule.schema.safeParse(rest);
  if (!parsed.success) {
    issues.push(...issuesOf(parsed.error, "frontmatter"));
  }
  if (!base.success || !parsed.success) {
    throw new FrontmatterError(issues);
  }
  return {
    type: type.data,
    frontmatter: { ...parsed.data, ...base.data },
    body,
  };
};

/**
 * Reads the frontmatter of the document at `path` checking only the
 * fields every type has (`baseSchema`, what a document's row keeps), and
 * not its type's schema: for a purge, which removes personal data from
 * whatever a document holds, a record no App declares any more (its
 * permission revoked, its App gone, `record_types` off) or that no longer
 * fits its type (a narrower schema since) too. A skill's name is still
 * read for its title.
 */
export const parseBaseFields = (path: string, text: string): ParsedRecord => {
  const { fields, body } = readFields(text);
  const named = typeIn(path, fields);
  const type =
    typeof named === "string"
      ? documentTypeSchema.safeParse(named).data
      : undefined;
  const { type: _type, ...rest } = fields;
  const base = baseSchema.safeParse(rest);
  if (!base.success) {
    throw new FrontmatterError(issuesOf(base.error, "frontmatter"));
  }
  return {
    type: type ?? "doc",
    frontmatter: { ...rest, ...base.data },
    body,
  };
};

/**
 * `text` with `fields` set in its frontmatter, and everything else as it
 * was: its other keys and comments, and the Markdown after it. Only for
 * text `parseFrontmatter` read.
 */
export const withFrontmatter = (
  text: string,
  fields: Record<string, unknown>
): string => {
  const { yaml, body } = splitFrontmatter(text);
  const document = parseDocument(yaml ?? "", { logLevel: "error" });
  for (const [key, value] of Object.entries(fields)) {
    document.set(key, value);
  }
  return `---\n${document.toString()}---\n${body}`;
};

const openingFence = /^\uFEFF?---[ \t]*\r?\n/u;
const closingFence = /^---[ \t]*\r?$/mu;

/**
 * Where a snapshot in `text` names the workflow versions it froze by
 * their path (`workflows[].path`), as [start, end) offsets in `text`, a
 * value's quotes included. None when `text` has no frontmatter or isn't
 * a snapshot; frontmatter that doesn't read gives what it can.
 */
export const frozenPathRanges = (text: string): [number, number][] => {
  const opening = openingFence.exec(text);
  if (!opening) {
    return [];
  }
  const start = opening[0].length;
  const rest = text.slice(start);
  const closing = closingFence.exec(rest);
  if (!closing) {
    return [];
  }
  const document = parseDocument(rest.slice(0, closing.index), {
    logLevel: "error",
  });
  const workflows = document.get("workflows", true);
  if (document.get("type") !== "snapshot" || !isSeq(workflows)) {
    return [];
  }
  return workflows.items.flatMap((entry): [number, number][] => {
    const path = isMap(entry) ? entry.get("path", true) : undefined;
    const range = isScalar(path) ? path.range : undefined;
    return range ? [[start + range[0], start + range[1]]] : [];
  });
};
