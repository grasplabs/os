import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { appLimits } from "@grasp-os/shared/app-limits";
import { appRecordTypesMaxLength } from "@grasp-os/shared/apps";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { writeBlueprints } from "./build-blueprints.ts";

// The build step's checks, in Node (the root config's "scripts" project):
// each built-in that the install would refuse fails the build instead.
// Each test writes its fixture, a folder of built-ins, into a directory of
// its own, and the module into it too, never core's dist/.

const made: string[] = [];

/**
 * A folder of one built-in, `id`, with `files` by path and `manifest`
 * added to its `blueprint.json`; returns it.
 */
const fixture = (
  id: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {}
): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-blueprints-"));
  made.push(dir);
  const folder = path.join(dir, id);
  mkdirSync(path.join(folder, "files"), { recursive: true });
  writeFileSync(
    path.join(folder, "blueprint.json"),
    JSON.stringify({
      name: "Fixture",
      description: "A test's built-in.",
      ...manifest,
    })
  );
  for (const [file, text] of Object.entries(files)) {
    const where = path.join(folder, "files", file);
    mkdirSync(path.dirname(where), { recursive: true });
    writeFileSync(where, text);
  }
  return dir;
};

/** Embeds the built-ins in `dir` into a module in `dir`; returns its path. */
const build = (dir: string): string => {
  const out = path.join(dir, "blueprints.js");
  writeBlueprints([dir], out);
  return out;
};

const server = { "app/server.ts": "export class App {}\n" };

/** A collection a built-in declares. */
const tasks = { id: "tasks", name: "Tasks", description: "Things to do." };

/** A permission to read and write `tasks`, under `binding`. */
const onTasks = (binding = "TASKS", actions = ["read", "write"]) => ({
  object: { type: "collection", collectionId: "tasks" },
  actions,
  binding,
});

/**
 * Record types of `task` records in `tasks`, whose frontmatter is of JSON
 * Schema type `type`, as `app/records.json`.
 */
const records = (type = "object") => ({
  "app/records.json": JSON.stringify({
    task: {
      collection: "tasks",
      description: "A thing to do.",
      schema: { type },
    },
  }),
});

/** The built-ins a module embeds. */
const embedded = (out: string): unknown =>
  JSON.parse(
    readFileSync(out, "utf-8")
      .replace(/^export default /u, "")
      .replace(/;\n$/u, "")
  );

/** `count` files of `length` characters each. */
const many = (count: number, length: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `app/file-${index}.ts`,
      "x".repeat(length),
    ])
  );

describe("the built-in blueprints' build", () => {
  afterEach(() => {
    for (const dir of made.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embeds a built-in that passes every check", () => {
    const out = build(fixture("fine", server));
    expect(embedded(out)).toStrictEqual([
      {
        id: "fine",
        name: "Fixture",
        description: "A test's built-in.",
        collections: [],
        permissions: [],
        files: server,
      },
    ]);
  });

  it("embeds the collections and permissions a built-in declares", () => {
    const out = build(
      fixture("asks", server, {
        collections: [tasks],
        permissions: [onTasks()],
      })
    );
    expect(embedded(out)).toMatchObject([
      { collections: [tasks], permissions: [onTasks()] },
    ]);
  });

  it.each([
    ["an action a collection doesn't have", [onTasks("TASKS", ["delete"])]],
    ["a binding name twice", [onTasks(), onTasks("TASKS", ["read"])]],
    ["a platform binding name", [onTasks("KNOWLEDGE")]],
    [
      "a connection, whose ID differs in each deployment",
      [
        {
          object: { type: "connection", connectionId: "connection-outlook" },
          actions: ["mail.list"],
          binding: "OUTLOOK",
        },
      ],
    ],
  ])("fails for a declared permission with %s", (_case, permissions) => {
    const dir = fixture("asks", server, { collections: [tasks], permissions });
    expect(() => build(dir)).toThrow("blueprint.json");
    expect(existsSync(path.join(dir, "blueprints.js"))).toBeFalsy();
  });

  it.each([
    ["a permission on a collection it doesn't declare", [], [onTasks()]],
    [
      "a collection named as a person's would be",
      [{ ...tasks, id: "3f0c2a44-8f39-4c55-9d6e-2b1a0c6e4d11" }],
      [],
    ],
    ["a collection twice", [tasks, tasks], []],
  ])("fails for %s", (_case, collections, permissions) => {
    const dir = fixture("asks", server, { collections, permissions });
    expect(() => build(dir)).toThrow("blueprint.json");
    expect(existsSync(path.join(dir, "blueprints.js"))).toBeFalsy();
  });

  it("embeds a built-in whose record types the commit would take", () => {
    const files = { ...server, ...records() };
    const out = build(
      fixture("typed", files, {
        collections: [tasks],
        permissions: [onTasks()],
      })
    );
    expect(embedded(out)).toMatchObject([{ id: "typed", files }]);
  });

  it.each([
    ["record types that aren't JSON", '{ "task": ', "Not JSON"],
    [
      "a record type whose frontmatter isn't an object",
      records("string")["app/records.json"],
      "task.schema: A record's frontmatter is an object",
    ],
    [
      "a record type with a field the schema doesn't know",
      JSON.stringify({
        task: { collection: "tasks", schema: { type: "object" }, colour: "" },
      }),
      'task: Unrecognized key: "colour"',
    ],
    [
      "record types over the commit's length",
      JSON.stringify({ padding: "x".repeat(appRecordTypesMaxLength) }),
      `At most ${appRecordTypesMaxLength} characters`,
    ],
  ])("fails, naming the built-in, for %s", (_case, text, issue) => {
    const dir = fixture(
      "typed",
      { ...server, "app/records.json": text },
      { collections: [tasks], permissions: [onTasks()] }
    );
    expect(() => build(dir)).toThrow(
      `${path.join(dir, "typed")}: files/app/records.json: ${issue}`
    );
    expect(existsSync(path.join(dir, "blueprints.js"))).toBeFalsy();
  });

  it.each([
    ["a collection it doesn't declare", [], []],
    [
      "a collection it only asks to read",
      [tasks],
      [onTasks("TASKS", ["read"])],
    ],
  ])(
    "fails for a record type kept in %s",
    (_case, collections, permissions) => {
      const dir = fixture(
        "typed",
        { ...server, ...records() },
        {
          collections,
          permissions,
        }
      );
      expect(() => build(dir)).toThrow(
        `${path.join(dir, "typed")}: files/app/records.json: task: its collection tasks`
      );
      expect(existsSync(path.join(dir, "blueprints.js"))).toBeFalsy();
    }
  );

  it.each([
    ["a hidden file", "hidden", { ...server, ".env": "SECRET=1\n" }, "files/"],
    ["a path an App can't have", "spaced", { "app/my file.ts": "" }, "files/"],
    [
      "a file over an App's limit",
      "large",
      { "app/server.ts": "x".repeat(appLimits.fileLength + 1) },
      "files/",
    ],
    [
      "more files than an App may have",
      "crowded",
      many(appLimits.files + 1, 1),
      "files/",
    ],
    [
      "files over an App's total",
      "heavy",
      many(6, appLimits.fileLength),
      "characters",
    ],
    ["no files", "empty", {}, "files/"],
  ])("fails for %s", (_case, id, files, message) => {
    const dir = fixture(id, files);
    expect(() => build(dir)).toThrow(message);
    expect(existsSync(path.join(dir, "blueprints.js"))).toBeFalsy();
  });
});
