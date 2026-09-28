import { buildFiles, serverFiles, workflowFiles } from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import type {
  BuildDiagnostic,
  CommittedVersion,
  SavedBuild,
} from "@grasp-os/shared/apps";
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

const toDiagnostic = ({
  file,
  line,
  severity,
  message,
}: Diagnostic): BuildDiagnostic => ({
  file: file ?? null,
  line: line ?? null,
  severity,
  message,
});

/**
 * One build of saved files, as the save reports it: `none` when there is
 * nothing of its kind to build, and `pending` when the build threw (the
 * compiler couldn't be reached): it builds again at its first use.
 */
const savedBuild = async (
  kind: keyof SavedBuilds,
  files: Record<string, string>,
  select: (files: Record<string, string>) => Record<string, string>,
  build: () => Promise<{ ok: boolean; diagnostics?: Diagnostic[] }>
): Promise<SavedBuild> => {
  if (Object.keys(select(files)).length === 0) {
    return { status: "none", diagnostics: [] };
  }
  try {
    const built = await build();
    return {
      status: built.ok ? "ok" : "failed",
      diagnostics: (built.diagnostics ?? []).map((item) => toDiagnostic(item)),
    };
  } catch (error) {
    log.warn("app.save_build_failed", {
      kind,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return pending;
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
  files: Record<string, string>,
  waitMs = saveBuildWaitMs
): Promise<SavedBuilds> => {
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
        files,
        buildFiles,
        async () => await buildScreens(env, files)
      )
    ),
    record(
      "server",
      savedBuild(
        "server",
        files,
        serverFiles,
        async () => await buildServer(env, files)
      )
    ),
    record(
      "workflows",
      savedBuild(
        "workflows",
        files,
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
