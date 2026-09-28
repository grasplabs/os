import { buildFiles, serverFiles, workflowFiles } from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import type {
  BuildDiagnostic,
  CommittedVersion,
  SavedBuild,
} from "@grasp-os/shared/apps";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { waitUntil } from "cloudflare:workers";

import { buildScreens, buildServer, buildWorkflows } from "./screens.ts";

/**
 * How long a save waits for its builds before it answers. A warm build
 * takes milliseconds to a few hundred; a first one after a deploy starts
 * the compiler, about a second. Past this, the save answers with what is
 * still building as `pending`.
 */
export const saveBuildWaitMs = 5000;

type SavedBuilds = CommittedVersion["builds"];

const pending: SavedBuild = { status: "pending", diagnostics: [] };

/** What a save answers while `build_on_save` is off: nothing built yet. */
export const notBuiltOnSave: SavedBuilds = {
  screens: pending,
  server: pending,
  workflows: pending,
};

/** What a save says of a build that couldn't run; nothing of App code. */
const couldNotRun =
  "The build couldn't run now. It runs again when this is first used.";

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
 * compiler couldn't be reached, or ran out of CPU): it runs again at its
 * first use.
 */
const savedBuild = async (
  kind: keyof SavedBuilds,
  { app, version, files }: SavedSource,
  select: (files: Record<string, string>) => Record<string, string>,
  build: () => Promise<{ ok: boolean; diagnostics?: Diagnostic[] }>
): Promise<SavedBuild> => {
  try {
    if (Object.keys(select(files)).length === 0) {
      return { status: "none", diagnostics: [] };
    }
    const built = await build();
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
 * and runs without building. Answers with how each went, for whoever
 * saved (an agent repairs what failed), after at most `waitMs`; a build
 * still going then goes on in the background (`waitUntil`, which the
 * platform bounds, as the compiler bounds each call's CPU). Never throws:
 * a build is never a reason for a save to fail.
 */
export const buildOnSave = async (
  env: Env,
  source: SavedSource,
  waitMs = saveBuildWaitMs
): Promise<SavedBuilds> => {
  const { files } = source;
  const done: Partial<SavedBuilds> = {};
  const record = async (
    kind: keyof SavedBuilds,
    result: Promise<SavedBuild>
  ): Promise<void> => {
    done[kind] = await result;
  };
  const all = Promise.all([
    record(
      "screens",
      savedBuild(
        "screens",
        source,
        buildFiles,
        async () => await buildScreens(env, files)
      )
    ),
    record(
      "server",
      savedBuild(
        "server",
        source,
        serverFiles,
        async () => await buildServer(env, files)
      )
    ),
    record(
      "workflows",
      savedBuild(
        "workflows",
        source,
        workflowFiles,
        async () => await buildWorkflows(env, files)
      )
    ),
  ]);
  waitUntil(all);
  await Promise.race([all, scheduler.wait(waitMs)]);
  return {
    screens: done.screens ?? pending,
    server: done.server ?? pending,
    workflows: done.workflows ?? pending,
  };
};
