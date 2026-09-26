import {
  buildFiles,
  compilerVersion,
  limitErrors,
  serverFiles,
  startScreenCompiler,
  workflowFiles,
} from "@grasp-os/compiler";
import type {
  AppSource,
  Diagnostic,
  ScreenBuild,
  ServerBuild,
  WorkflowBuild,
} from "@grasp-os/compiler";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { ErrorPayload } from "@grasp-os/shared/errors";

/** A hash of an App's files, whatever order they come in. */
const hashOf = async (files: Record<string, string>): Promise<string> =>
  await sha256Hex(
    JSON.stringify(
      Object.entries(files).toSorted(([a], [b]) => (a < b ? -1 : 1))
    )
  );

/**
 * What a build is: the App and version it is filed under, the compiler
 * that builds it (a release with a new compiler or kit builds every App
 * again) and a hash of the files, so different files under one version
 * never share a build.
 */
const buildKey = async ({ app, version, files }: AppSource): Promise<string> =>
  `${encodeURIComponent(app)}/${encodeURIComponent(version)}/${compilerVersion}/${await hashOf(files)}`;

/** A build refused before it started, or one that failed. */
interface FailedBuild {
  ok: false;
  diagnostics: Diagnostic[];
}

/**
 * A build of the files `select` picks, the only ones it reads: limited
 * first, so the limits bound the hashing and sending too. From R2 (in the
 * EU), or built in the compiler's isolate and stored there. A failed build
 * is cached too: the same files fail the same way with the same compiler,
 * so an App that doesn't build can't start the compiler on every request.
 * A build that throws isn't cached. Two requests for a build that isn't
 * cached yet may both build it; they build the same thing.
 */
const cachedBuild = async <Build>(
  env: Env,
  kind: "screen" | "server" | "workflow",
  source: AppSource,
  select: (files: Record<string, string>) => Record<string, string>,
  build: (
    compiler: ReturnType<typeof startScreenCompiler>,
    files: Record<string, string>
  ) => Promise<Build>
): Promise<Build | FailedBuild> => {
  const files = select(source.files);
  const tooMuch = limitErrors(files);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  const key = await buildKey({ ...source, files });
  const cacheKey = `${kind}-builds/${key}.json`;
  const cached = await env.FILES.get(cacheKey);
  if (cached) {
    return await cached.json<Build>();
  }
  const compiler = startScreenCompiler(
    env.LOADER,
    env.ASSETS,
    `${kind}:${key}`
  );
  const built = await build(compiler, files);
  await env.FILES.put(cacheKey, JSON.stringify(built));
  return built;
};

/**
 * Builds an App's screens into ES modules and their CSS, in an isolate of
 * its own. The modules import the release's kit modules (`kitModules(env.ASSETS)`);
 * `kitModules` in the result names the ones they need. A build is cached
 * in R2.
 */
export const buildScreens = async (
  env: Env,
  source: AppSource
): Promise<ScreenBuild> =>
  await cachedBuild(
    env,
    "screen",
    source,
    buildFiles,
    async (compiler, files) => await compiler.build(files)
  );

/**
 * Builds an App's server code (`app/**.ts`) into ES modules, in the
 * compiler's isolate. A build is cached in R2, like the screens'.
 */
export const buildServer = async (
  env: Env,
  source: AppSource
): Promise<ServerBuild> =>
  await cachedBuild(
    env,
    "server",
    source,
    serverFiles,
    async (compiler, files) => await compiler.buildServer(files)
  );

/**
 * Builds an App's workflows (`workflows/**.ts`) into ES modules, in the
 * compiler's isolate. A build is cached in R2, like the server's.
 */
export const buildWorkflows = async (
  env: Env,
  source: AppSource
): Promise<WorkflowBuild> =>
  await cachedBuild(
    env,
    "workflow",
    source,
    workflowFiles,
    async (compiler, files) => await compiler.buildWorkflows(files)
  );

/** The details of a `*.build_failed` error: the version, and why. */
export const buildFailed = (
  version: number,
  { diagnostics }: FailedBuild
): NonNullable<ErrorPayload["details"]> => ({
  version,
  diagnostics: diagnostics.map(({ file, line, message }) => ({
    file: file ?? null,
    line: line ?? null,
    message,
  })),
});
