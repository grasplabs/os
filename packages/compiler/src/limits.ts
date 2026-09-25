import type { Diagnostic } from "./diagnostic.ts";

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

/**
 * Why these files are more than a build takes, if they are. Core checks
 * what it is given before it hashes it; the compiler checks what it reads.
 */
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
