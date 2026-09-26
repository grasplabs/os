/**
 * What a build reads of an App's files, and how much of it a build takes.
 * Core uses these before it hashes and sends the files; the compiler again
 * on what it is sent.
 */
import { appLimits } from "@grasp-os/shared/app-limits";

import type { Diagnostic } from "./diagnostic.ts";

export const screenFile = /^screens\/[\w-]+\.tsx$/u;
// Folders are plain names, so a path can't step out of `components/`.
export const componentFile = /^components\/(?:[\w-]+\/)*[\w.-]+\.tsx?$/u;
/** Types the App's code can use but that aren't code, e.g. its server's. */
export const declarationFile = /^[\w-]+\.d\.ts$/u;

/** The files a build reads: screens, components and declarations. */
export const buildFiles = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        screenFile.test(path) ||
        componentFile.test(path) ||
        declarationFile.test(path)
    )
  );

/** The App's server code: TypeScript under `app/`, declarations aside. */
const serverFile = /^app\/(?:[\w-]+\/)*[\w.-]+\.ts$/u;

/** The module that exports the server's `App` class. */
export const serverEntry = "app/server.ts";

/** The files a server build reads: the App's `app/**.ts`. */
export const serverFiles = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) => serverFile.test(path) && !path.endsWith(".d.ts")
    )
  );

/** The App's workflows and their tests: TypeScript under `workflows/`. */
const workflowFile = /^workflows\/(?:[\w-]+\/)*[\w.-]+\.ts$/u;

/** The files a workflow build reads: the App's `workflows/**.ts`. */
export const workflowFiles = (
  files: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) => workflowFile.test(path) && !path.endsWith(".d.ts")
    )
  );

/**
 * Where a workflow's code is, and its tests: `workflows/<id>.ts`, whose
 * default export is the workflow, and `workflows/<id>.workflow-tests.ts`
 * beside it, whose default export is its tests (`workflowTests`). Every .ts
 * file directly in workflows/, other than its tests, is a workflow: put
 * shared code in a folder under it, such as workflows/lib/.
 */
export const workflowPaths = (
  id: string
): { workflow: string; tests: string } => ({
  workflow: `workflows/${id}.ts`,
  tests: `workflows/${id}.workflow-tests.ts`,
});

/** A workflow's ID, from its file's path; undefined for any other file. */
const workflowPath = /^workflows\/(?<id>[A-Za-z][\w-]{0,63})\.ts$/u;
export const workflowIdOf = (path: string): string | undefined =>
  workflowPath.exec(path)?.groups?.id;

/**
 * The most a build takes: as much as an App holds, so any App fits, and a
 * mistake (or an attack) fails fast and says why.
 */
const limits = appLimits;

const tooMuch = (message: string, file?: string): Diagnostic => ({
  ...(file === undefined ? {} : { file }),
  rule: "limits",
  severity: "error",
  message,
});

/** Why a build's files (`buildFiles`) are more than it takes, if they are. */
export const limitErrors = (files: Record<string, string>): Diagnostic[] => {
  const entries = Object.entries(files);
  if (entries.length > limits.files) {
    return [
      tooMuch(
        `The App has ${entries.length} files; a build takes at most ${limits.files}.`
      ),
    ];
  }
  const errors = entries
    .filter(([, source]) => source.length > limits.fileLength)
    .map(([path, source]) =>
      tooMuch(
        `This file has ${source.length} characters; a file can have at most ${limits.fileLength}. Split it up.`,
        path
      )
    );
  const total = entries.reduce((sum, [, source]) => sum + source.length, 0);
  if (total > limits.totalLength) {
    errors.push(
      tooMuch(
        `The App's files have ${total} characters together; a build takes at most ${limits.totalLength}.`
      )
    );
  }
  return errors;
};
