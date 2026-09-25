import { compilerVersion, startScreenCompiler } from "@grasp-os/compiler";
import type { ScreenBuild, ScreenSource } from "@grasp-os/compiler";

/**
 * Where a build is cached: by App and version, and by compiler version, so a
 * release with a new compiler or kit builds every App again.
 */
const cacheKey = ({ app, version }: ScreenSource): string =>
  `screen-builds/${encodeURIComponent(app)}/${encodeURIComponent(version)}/${compilerVersion}.json`;

/**
 * Builds running in this isolate, by cache key: a request for a version
 * that is already building waits for that build. Isolates don't share
 * these, so two isolates can still build the same version at once; both
 * produce the same result.
 */
const building = new Map<string, Promise<ScreenBuild>>();

const build = async (
  env: Env,
  source: ScreenSource,
  key: string
): Promise<ScreenBuild> => {
  const compiler = startScreenCompiler(
    env.LOADER,
    `${source.app}@${source.version}`
  );
  const built = await compiler.build(source.files);
  if (built.ok) {
    await env.FILES.put(key, JSON.stringify(built));
  }
  return built;
};

/**
 * Builds an App's screens into ES modules and their CSS, in an isolate of
 * its own. The modules import the release's kit modules (`kitModules()`). A version builds once: the result is cached in R2 (in the EU) and
 * later requests read it from there. Failed builds aren't cached.
 */
export const buildScreens = async (
  env: Env,
  source: ScreenSource
): Promise<ScreenBuild> => {
  const key = cacheKey(source);
  const cached = await env.FILES.get(key);
  if (cached) {
    return await cached.json<ScreenBuild>();
  }
  const running = building.get(key);
  if (running) {
    return await running;
  }
  const started = build(env, source, key);
  building.set(key, started);
  try {
    return await started;
  } finally {
    building.delete(key);
  }
};
