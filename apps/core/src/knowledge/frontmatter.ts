import { documentTypeSchema } from "@grasp-os/shared/knowledge";
import type { DocumentType } from "@grasp-os/shared/knowledge";
import { parse } from "yaml";
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

/** The frontmatter schema of each type. */
export const frontmatterSchemas = {
  doc: baseSchema,
  skill: skillSchema,
  memory: baseSchema,
  decision: decisionSchema,
  file: fileSchema,
} as const satisfies Record<DocumentType, z.ZodType>;

export type Frontmatter = z.infer<(typeof frontmatterSchemas)[DocumentType]>;

/** Files that are a type by their name alone, as other tools write them. */
const typeByFileName: Readonly<Record<string, DocumentType>> = {
  "SKILL.md": "skill",
  "AGENTS.md": "memory",
  "MEMORY.md": "memory",
  "USER.md": "memory",
};

/** A document's frontmatter, read and checked, and the Markdown after it. */
export interface ParsedFrontmatter {
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

/** A Zod error as lines people read, such as `frontmatter.tags.0: …`. */
export const issueLines = (error: z.ZodError, prefix: string): string[] =>
  error.issues.map(({ path, message }) => {
    const where = [prefix, ...path.map(String)].filter(Boolean).join(".");
    return where === "" ? message : `${where}: ${message}`;
  });

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
    throw new FrontmatterError(issueLines(parsed.error, "frontmatter"));
  }
  return { type: type.data, frontmatter: parsed.data, body };
};
