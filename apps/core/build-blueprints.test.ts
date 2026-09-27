import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { appLimits } from "@grasp-os/shared/app-limits";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { writeBlueprints } from "./build-blueprints.ts";

// The build step's checks, in Node (the root config's "scripts" project):
// each built-in that the install would refuse fails the build instead.
// Each test writes its fixture, a folder of built-ins, into a directory of
// its own, and the module into it too, never core's dist/.

const made: string[] = [];

/** A folder of one built-in, `id`, with `files` by path; returns it. */
const fixture = (id: string, files: Record<string, string>): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-blueprints-"));
  made.push(dir);
  const folder = path.join(dir, id);
  mkdirSync(path.join(folder, "files"), { recursive: true });
  writeFileSync(
    path.join(folder, "blueprint.json"),
    JSON.stringify({ name: "Fixture", description: "A test's built-in." })
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
    expect(existsSync(out)).toBeTruthy();
  });

  it.each([
    ["a folder name too long for an App ID", "a".repeat(249), server, "App ID"],
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
