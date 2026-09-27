import { issuesOf } from "@grasp-os/shared/errors";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import {
  documentPathSchema,
  documentTypeSchema,
} from "@grasp-os/shared/knowledge";
import type { DocumentType } from "@grasp-os/shared/knowledge";
import { isMap, isScalar, isSeq, parse, parseDocument } from "yaml";
import { z } from "zod";

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

/** A short value a person writes: a name, a role, a tool. */
const shortText = z.string().trim().min(1).max(200);

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
 * A dated freeze of the Playbook: the workflow records at the versions it
 * was taken from, which later saves don't change, and the maturity then.
 */
const snapshotSchema = baseSchema.extend({
  date: z.iso.date(),
  maturity: z.int().min(0).max(5).optional(),
  workflows: z
    .array(z.strictObject({ path: recordPath, version: z.int().min(1) }))
    .max(snapshotMaxWorkflows)
    .default([]),
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
} as const satisfies Record<DocumentType, z.ZodType>;

type Frontmatter = z.infer<(typeof frontmatterSchemas)[DocumentType]>;

/** Files that are a type by their name alone, as other tools write them. */
const typeByFileName: Readonly<Record<string, DocumentType>> = {
  "SKILL.md": "skill",
  "AGENTS.md": "memory",
  "MEMORY.md": "memory",
  "USER.md": "memory",
};

/** A document's frontmatter, read and checked, and the Markdown after it. */
interface ParsedFrontmatter {
  type: DocumentType;
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

const fence = /^---[ \t]*$/u;
const lineBreak = /\r?\n/u;
const byteOrderMark = "﻿";

/** The YAML between the fences, and the Markdown after them. */
const splitFrontmatter = (
  text: string
): { yaml: string | undefined; body: string } => {
  const source = text.startsWith(byteOrderMark) ? text.slice(1) : text;
  const lines = source.split(lineBreak);
  if (!fence.test(lines[0] ?? "")) {
    return { yaml: undefined, body: source };
  }
  const end = lines.findIndex((line, index) => index > 0 && fence.test(line));
  if (end === -1) {
    throw new FrontmatterError([
      "frontmatter: it starts with --- but has no closing --- line",
    ]);
  }
  return {
    yaml: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
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
  const { yaml, body } = splitFrontmatter(text);
  const fields = yaml === undefined ? {} : readYaml(yaml);
  const fileName = path.split("/").at(-1) ?? "";
  const type = documentTypeSchema.safeParse(
    fields.type ?? typeByFileName[fileName] ?? "doc"
  );
  if (!type.success) {
    throw new FrontmatterError([
      `frontmatter.type: one of ${documentTypeSchema.options.join(", ")}`,
    ]);
  }
  const parsed = frontmatterSchemas[type.data].safeParse(fields);
  if (!parsed.success) {
    throw new FrontmatterError(issuesOf(parsed.error, "frontmatter"));
  }
  return { type: type.data, frontmatter: parsed.data, body };
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
