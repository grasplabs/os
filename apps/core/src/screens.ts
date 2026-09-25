import {
  buildFiles,
  compilerVersion,
  limitErrors,
  startScreenCompiler,
} from "@grasp-os/compiler";
import type { ScreenBuild, ScreenSource } from "@grasp-os/compiler";

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
 * Builds an App's screens into ES modules and their CSS, in an isolate of
 * its own. The modules import the release's kit modules (`kitModules()`);
 * `kitModules` in the result names the ones they need. A build is cached
 * in R2 (in the EU), and later requests for the same files read it from
 * there. Failed builds aren't cached. Two requests for a build that isn't
 * cached yet may both build it; they build the same thing.
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
  const key = await buildKey({ ...source, files });
  const cacheKey = `screen-builds/${key}.json`;
  const cached = await env.FILES.get(cacheKey);
  if (cached) {
    return await cached.json<ScreenBuild>();
  }
  const compiler = startScreenCompiler(env.LOADER, key);
  const built = await compiler.build(files);
  if (built.ok) {
    await env.FILES.put(cacheKey, JSON.stringify(built));
  }
  return built;
};
