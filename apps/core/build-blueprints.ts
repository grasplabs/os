/**
 * Embeds the built-in blueprints into dist/blueprints.js, which core
 * imports as `#blueprints` (src/blueprints.d.ts) and installs once per
 * release (src/builtins.ts), with no network access. Core's build runs it.
 * Core's tests embed their fixtures too, into a module of their own
 * (`testBlueprintsModule`, which vite.config.ts makes `#blueprints` for
 * them), so a deploy after a test run can't ship a test's built-in.
 *
 * Each built-in is a folder under apps/core/blueprints/, named by its id,
 * which never changes: renaming the folder makes another blueprint. In it:
 *
 * - `blueprint.json`: `{ "name": …, "description": … }`, as for any App,
 *   and optionally `"collections"`: the collections it keeps records in,
 *   as `[{ "id": …, "name": …, "description": … }]`, which the install
 *   creates if they aren't there yet (`declaredCollectionSchema`); and
 *   `"permissions"`: what each App created from it asks for, as
 *   `[{ "object": { "type": "collection", "collectionId": … }, "actions":
 *   […], "binding": … }]`, each a request an admin grants on the copy,
 *   and each for one of its collections;
 * - `files/`: the App's files, by path, written against `@grasp-os/sdk`
 *   like any App's.
 *
 * Each is checked here as the install would check it, so a bad one fails
 * the build rather than the install: its ID, its manifest (its
 * collections, and its permissions as any request's are checked, each
 * for a collection it declares), and its
 * files as any App's write checks them (paths, no hidden files, each
 * file's size and their number), their total size as any version's, and
 * its record types (`app/records.json`) as any version's commit reads
 * them, each in a collection its copies ask to write.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { appLimits } from "@grasp-os/shared/app-limits";
import {
  appErrors,
  appRecordTypesPath,
  fileChangesSchema,
  fromBlueprintSchema,
} from "@grasp-os/shared/apps";
import type { AppRecordTypes } from "@grasp-os/shared/apps";
import { declaredCollectionSchema } from "@grasp-os/shared/knowledge";
import { declaredPermissionSchema } from "@grasp-os/shared/permissions";
import type { DeclaredPermission } from "@grasp-os/shared/permissions";
import { z } from "zod";

import type { BuiltinBlueprint } from "#blueprints";

import { recordTypesIn } from "./src/app-records.ts";

/** Where the built-ins that ship with each release are. */
export const blueprintsDir = path.join(import.meta.dirname, "blueprints");

/** The module core imports as `#blueprints`. */
export const blueprintsModule = path.join(
  import.meta.dirname,
  "dist/blueprints.js"
);

/** The module core's tests import as `#blueprints`, fixtures included. */
export const testBlueprintsModule = path.join(
  import.meta.dirname,
  "dist/test-blueprints.js"
);

/** Most permissions one built-in declares: each is one install statement. */
export const declaredMaxPermissions = 16;

/** Most collections one built-in declares. */
export const declaredMaxCollections = 4;

/**
 * A `blueprint.json`: the App's name and description, as for any App,
 * the collections it declares, and what each copy asks for, each binding
 * name once, as an App's permissions have them, and each for a
 * collection it declares.
 */
const manifestSchema = fromBlueprintSchema
  .extend({
    collections: z
      .array(declaredCollectionSchema)
      .max(declaredMaxCollections)
      .refine(
        (collections) =>
          new Set(collections.map(({ id }) => id)).size === collections.length,
        { message: "Each collection once" }
      )
      .default([]),
    permissions: z
      .array(declaredPermissionSchema)
      .max(declaredMaxPermissions)
      .refine(
        (permissions) =>
          new Set(permissions.map(({ binding }) => binding)).size ===
          permissions.length,
        { message: "Each binding name once" }
      )
      .default([]),
  })
  .refine(
    ({ collections, permissions }) =>
      permissions.every(
        ({ object }) =>
          object.type !== "collection" ||
          collections.some(({ id }) => id === object.collectionId)
      ),
    {
      path: ["permissions"],
      message: "Each for a collection the blueprint declares",
    }
  );

/** A folder name that is safe in an ID, a URL and an audit event. */
const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** Every file under `dir`, by its path from `dir`, with `/` between names. */
const filesIn = (dir: string): Record<string, string> => {
  const paths = readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => statSync(path.join(dir, file)).isFile())
    .map((file) => file.split(path.sep).join("/"))
    .toSorted();
  return Object.fromEntries(
    paths.map((file) => [file, readFileSync(path.join(dir, file), "utf-8")])
  );
};

/** The issues a refusal names (`details.issues`), if it names any. */
const issuesOf = (error: unknown): string[] => {
  const details =
    error instanceof Error && "details" in error ? error.details : undefined;
  if (typeof details !== "object" || details === null) {
    return [];
  }
  const issues = "issues" in details ? details.issues : undefined;
  return Array.isArray(issues)
    ? issues.filter((issue): issue is string => typeof issue === "string")
    : [];
};

/**
 * The record types `files` declare, read as the commit reads them, or
 * throws naming each issue for ones it would refuse.
 */
const recordTypesOf = (
  where: string,
  files: Record<string, string>
): AppRecordTypes => {
  try {
    return recordTypesIn(new Map(Object.entries(files)));
  } catch (error) {
    if (appErrors.codeOf(error) !== "app.records_invalid") {
      throw error;
    }
    throw new Error(
      `${where}: files/${appRecordTypesPath}: ${issuesOf(error).join("; ")}`,
      { cause: error }
    );
  }
};

/**
 * Throws for a record type kept in a collection the built-in's copies
 * can't write, such as a misspelt one: the install would take it, and
 * knowledge would ignore it there (knowledge/record-types.ts).
 */
const requireWritable = (
  where: string,
  records: AppRecordTypes,
  permissions: readonly DeclaredPermission[]
) => {
  for (const [type, { collection }] of Object.entries(records)) {
    const writable = permissions.some(
      ({ object, actions }) =>
        object.type === "collection" &&
        object.collectionId === collection &&
        actions.includes("write")
    );
    if (!writable) {
      throw new Error(
        `${where}: files/${appRecordTypesPath}: ${type}: its collection ${collection} is none the blueprint declares and asks to write`
      );
    }
  }
};

/** The built-ins in `dir`, one per folder, checked. */
const blueprintsIn = (dir: string): BuiltinBlueprint[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => {
      const folder = path.join(dir, name);
      const where = `Built-in blueprint ${folder}`;
      if (!idSchema.safeParse(name).success) {
        throw new Error(`${where}: name the folder in lowercase-kebab-case`);
      }
      const manifest = manifestSchema.safeParse(
        JSON.parse(readFileSync(path.join(folder, "blueprint.json"), "utf-8"))
      );
      if (!manifest.success) {
        throw new Error(`${where}: blueprint.json ${manifest.error.message}`);
      }
      const filesDir = path.join(folder, "files");
      if (!existsSync(filesDir)) {
        throw new Error(`${where}: has no files/`);
      }
      const files = filesIn(filesDir);
      const checked = fileChangesSchema.safeParse(files);
      if (!checked.success) {
        throw new Error(`${where}: files/ ${checked.error.message}`);
      }
      const length = Object.values(files).reduce(
        (total, text) => total + text.length,
        0
      );
      if (length > appLimits.totalLength) {
        throw new Error(
          `${where}: files/ holds ${length} characters, over an App's ${appLimits.totalLength}`
        );
      }
      requireWritable(
        where,
        recordTypesOf(where, files),
        manifest.data.permissions
      );
      return { id: name, ...manifest.data, files };
    });

/**
 * Writes the built-ins in `dirs` into `out`, in id order, or refuses when
 * two share an id. Leaves an unchanged module as it is, so its time stays
 * the same.
 */
export const writeBlueprints = (
  dirs: readonly string[],
  out: string = blueprintsModule
): number => {
  const blueprints = dirs
    .flatMap(blueprintsIn)
    .toSorted((a, b) => (a.id < b.id ? -1 : 1));
  const ids = blueprints.map(({ id }) => id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) {
    throw new Error(`Two built-in blueprints are named ${repeated}`);
  }
  const text = `export default ${JSON.stringify(blueprints)};\n`;
  const unchanged = existsSync(out) && readFileSync(out, "utf-8") === text;
  if (!unchanged) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
  return blueprints.length;
};

if (import.meta.main) {
  const count = writeBlueprints([blueprintsDir]);
  console.info(`Embedded ${count} built-in blueprint(s)`);
}
