import {
  buildFiles,
  compilerVersion,
  limitErrors,
  serverFiles,
  startScreenCompiler,
} from "@grasp-os/compiler";
import type {
  ScreenBuild,
  ScreenSource,
  ServerBuild,
} from "@grasp-os/compiler";

/** A hash of an App's files, whatever order they come in. */
const hashOf = async (files: Record<string, string>): Promise<string> => {
  const sorted = Object.entries(files).toSorted(([a], [b]) => (a < b ? -1 : 1));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sorted))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * What a build is: the App and version it is filed under, the compiler
 * that builds it (a release with a new compiler or kit builds every App
 * again) and a hash of the files, so different files under one version
 * never share a build.
 */
const buildKey = async ({
  app,
  version,
  files,
}: ScreenSource): Promise<string> =>
  `${encodeURIComponent(app)}/${encodeURIComponent(version)}/${compilerVersion}/${await hashOf(files)}`;

/**
 * A build of `files` (already limited to what the build reads) from R2 (in
 * the EU), or built in the compiler's isolate and stored there. A failed
 * build is cached too: the same files fail the same way with the same
 * compiler, so an App that doesn't build can't start the compiler on every
 * request. A build that throws isn't cached. Two requests for a build that
 * isn't cached yet may both build it; they build the same thing.
 */
const cachedBuild = async <Build>(
  env: Env,
  kind: "screen" | "server",
  source: ScreenSource,
  build: (
    compiler: ReturnType<typeof startScreenCompiler>,
    files: Record<string, string>
  ) => Promise<Build>
): Promise<Build> => {
  const key = await buildKey(source);
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
  const built = await build(compiler, source.files);
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
  source: ScreenSource
): Promise<ScreenBuild> => {
  // Only what a build reads is limited, hashed and sent; the limits come
  // before the hash, so they bound that work too.
  const files = buildFiles(source.files);
  const tooMuch = limitErrors(files);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  return await cachedBuild(
    env,
    "screen",
    { ...source, files },
    async (compiler, sent) => await compiler.build(sent)
  );
};

/**
 * Builds an App's server code (`app/**.ts`) into ES modules, in the
 * compiler's isolate. A build is cached in R2, like the screens'.
 */
export const buildServer = async (
  env: Env,
  source: ScreenSource
): Promise<ServerBuild> => {
  const files = serverFiles(source.files);
  const tooMuch = limitErrors(files);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  return await cachedBuild(
    env,
    "server",
    { ...source, files },
    async (compiler, sent) => await compiler.buildServer(sent)
  );
};
