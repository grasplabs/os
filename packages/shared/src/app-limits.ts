/**
 * The most an App's files take, checked on every write and commit. The
 * screen compiler takes as much in one build (its files are some of the
 * App's), so an App within these limits always fits a build, and the build
 * stays well inside its isolate's CPU and memory. No dependencies: the
 * compiler's isolate imports it.
 */
export const appLimits = {
  files: 200,
  /** Characters in one file. */
  fileLength: 200_000,
  /** Characters in all of an App's files together. */
  totalLength: 1_000_000,
  pathLength: 200,
  pathDepth: 8,
  nameLength: 100,
  descriptionLength: 1000,
  messageLength: 1000,
} as const;
