/**
 * What a build reads of an App's files, and how much of it a build takes.
 * Core uses these before it hashes and sends the files; the compiler again
 * on what it is sent.
 */
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

/**
 * The most a build takes, so that it stays well inside its isolate's CPU
 * and memory, and a mistake (or an attack) fails fast and says why.
 */
const limits = { files: 200, fileLength: 200_000, totalLength: 1_000_000 };

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
