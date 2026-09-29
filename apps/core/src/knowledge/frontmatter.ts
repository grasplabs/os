import { issuesOf } from "@grasp-os/shared/errors";
import {
  builtinDocumentTypeSchema,
  documentTypeSchema,
  isBuiltinDocumentType,
  splitFrontmatterBlock,
} from "@grasp-os/shared/knowledge";
import type {
  BuiltinDocumentType,
  DocumentType,
} from "@grasp-os/shared/knowledge";
import { parse } from "yaml";
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

/** The frontmatter schema of each type. */
const frontmatterSchemas = {
  doc: baseSchema,
  skill: skillSchema,
  memory: baseSchema,
  decision: decisionSchema,
  file: fileSchema,
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
