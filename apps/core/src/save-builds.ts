import { buildFiles, serverFiles, workflowFiles } from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import type {
  BuildDiagnostic,
  CommittedVersion,
  SavedBuild,
} from "@grasp-os/shared/apps";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";

import { buildScreens, buildServer, buildWorkflows } from "./screens.ts";

/**
 * The longest a save waits for one build. A warm build takes milliseconds
 * to a few hundred; a first one after a deploy starts the compiler, about
 * a second. The compiler bounds a build's CPU, not how long it takes, so
 * this is what keeps a build that never answers from holding a save: past
 * it, the build is reported as `error`. A chat's check builds this way too
 * (agent-builds.ts), in a code run that has 30 seconds and runs the tests
 * after the builds, so the wait leaves it room.
 */
const buildWaitMs = 15_000;

/**
 * How long a save waits for one build: {@link buildWaitMs}, or less where
 * tests set `BUILD_WAIT_MS`.
 */
const waitMsOf = (env: Env): number => {
  const set = Number(env.BUILD_WAIT_MS);
  return Number.isInteger(set) && set > 0 && set < buildWaitMs
    ? set
    : buildWaitMs;
};

type SavedBuilds = CommittedVersion["builds"];

/** What a save says of a build that couldn't run; nothing of App code. */
const couldNotRun =
  "The build couldn't run now. It runs again when this is first used.";

/** What a save says of a build that didn't answer within its wait. */
const tookTooLong =
  "The build didn't finish in time. It runs again when this is first used.";

/** A saved version: its App and number, for the log, and its files. */
interface SavedSource {
  app: AppId;
  version: number;
  files: Record<string, string>;
}

const toDiagnostic = ({
  file,
  line,
  column,
  rule,
  severity,
  message,
  fix,
}: Diagnostic): BuildDiagnostic => ({
  file: file ?? null,
  line: line ?? null,
  ...(column === undefined ? {} : { column }),
  rule,
  severity,
  message,
  ...(fix === undefined ? {} : { fix }),
});

/**
 * One build of saved files, as the save reports it: `none` when there is
 * nothing of its kind to build, and `error` when the build threw (the
 * compiler couldn't be reached, or ran out of CPU) or didn't answer within
 * `waitMs`: it runs again at its first use.
 */
const savedBuild = async (
  kind: keyof SavedBuilds,
  { app, version, files }: SavedSource,
  select: (files: Record<string, string>) => Record<string, string>,
  build: () => Promise<{ ok: boolean; diagnostics?: Diagnostic[] }>,
  waitMs: number
): Promise<SavedBuild> => {
  try {
    if (Object.keys(select(files)).length === 0) {
      return { status: "none", diagnostics: [] };
    }
    const built = await Promise.race([
      build(),
      scheduler.wait(waitMs).then(() => "late" as const),
    ]);
    if (built === "late") {
      log.warn("app.save_build_timed_out", { appId: app, version, kind });
      return { status: "error", diagnostics: [], error: tookTooLong };
    }
    return {
      status: built.ok ? "ok" : "failed",
      diagnostics: (built.diagnostics ?? []).map((item) => toDiagnostic(item)),
    };
  } catch (error) {
    log.warn("app.save_build_failed", {
      appId: app,
      version,
      kind,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { status: "error", diagnostics: [], error: couldNotRun };
  }
};

/**
 * Builds a saved version's screens, server code and workflows, all at
 * once, into the build cache (screens.ts), so the version opens, answers
 * and runs without building. Answers once all three are done with how each
 * went, for whoever saved (an agent repairs what failed); none takes
 * longer than {@link buildWaitMs}. Never throws: a build is never a reason
 * for a save to fail.
 */
export const buildOnSave = async (
  env: Env,
  source: SavedSource
): Promise<SavedBuilds> => {
  const { files } = source;
  const waitMs = waitMsOf(env);
  const [screens, server, workflows] = await Promise.all([
    savedBuild(
      "screens",
      source,
      buildFiles,
      async () => await buildScreens(env, files),
      waitMs
    ),
    savedBuild(
      "server",
      source,
      serverFiles,
      async () => await buildServer(env, files),
      waitMs
    ),
    savedBuild(
      "workflows",
      source,
      workflowFiles,
      async () => await buildWorkflows(env, files),
      waitMs
    ),
  ]);
  return { screens, server, workflows };
};
