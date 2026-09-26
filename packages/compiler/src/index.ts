/**
 * Screen compiler: builds an App's screens into ES modules and CSS, in a
 * Dynamic Worker of its own. The modules import each other and the kit's
 * modules by flat name (see kit.ts); a page maps those names to the code
 * with an import map.
 *
 * The compiler's code and what it knows of the kit are many times core's
 * size, and most requests never build. They are core's static assets
 * (`compilerAssets`), read when a build starts an isolate; core itself
 * imports only the version.
 */
import { compatibilityDate } from "@grasp-os/shared/runtime";

import { version } from "#version";

import { compilerAssets, kitModule } from "./kit.ts";
import type { KitModules } from "./kit.ts";
import type ScreenCompiler from "./worker.ts";

export type { Diagnostic } from "./diagnostic.ts";
export type { KitModules } from "./kit.ts";
export type { ScreenBuild, ServerBuild, WorkflowBuild } from "./worker.ts";
export {
  buildFiles,
  limitErrors,
  serverFiles,
  workflowFiles,
  workflowIdOf,
  workflowPaths,
} from "./inputs.ts";
export { appModuleName, kitModuleName } from "./kit.ts";
/** Part of every build's cache key: a new compiler or kit builds again. */
export { version as compilerVersion } from "#version";

/** An App's screens at one version. */
export interface ScreenSource {
  app: string;
  version: string;
  /**
   * `screens/*.tsx`, `components/` files and declarations at the root
   * (`*.d.ts`, e.g. the server's types) by path; other files are ignored.
   */
  files: Record<string, string>;
}

/**
 * One of this release's compiler files, from core's static assets. The
 * assets answer unknown paths with the frontend's index.html, so anything
 * but the file's own type means it is missing.
 */
const readCompilerFile = async (
  assets: Fetcher,
  file: string,
  type: string
): Promise<string> => {
  const url = `https://assets${compilerAssets.directory(version)}/${file}`;
  const response = await assets.fetch(url);
  const contentType = response.headers.get("content-type") ?? "";
  if (!(response.ok && contentType.includes(type))) {
    throw new Error(
      `The screen compiler's ${file} is not among the static assets: build the compiler into them (packages/compiler/build.ts).`
    );
  }
  return await response.text();
};

const isKitModules = (value: unknown): value is KitModules =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  "modules" in value;

const readModules = async (
  assets: Fetcher,
  file: string
): Promise<KitModules> => {
  const parsed: unknown = JSON.parse(
    await readCompilerFile(assets, file, "json")
  );
  if (!isKitModules(parsed)) {
    throw new Error(`${file} is not in the expected shape.`);
  }
  return parsed;
};

/** The kit's modules, which every App's modules import: one set per release. */
export const kitModules = async (assets: Fetcher): Promise<KitModules> =>
  await readModules(assets, compilerAssets.kitModules);

/**
 * The workflow SDK's modules, which every App's workflows import
 * (`sdkImports`): one set per release.
 */
export const sdkModules = async (assets: Fetcher): Promise<KitModules> =>
  await readModules(assets, compilerAssets.sdkModules);

/**
 * How the compiler's isolate runs: no bindings, no network
 * (`globalOutbound: null` and no subrequests), and at most 20 s of CPU per
 * call, many times what a large App takes. `nodejs_compat` is for the
 * React Compiler, which is written for Node.
 */
export const isolateSettings = {
  compatibilityDate,
  compatibilityFlags: ["nodejs_compat"],
  env: {},
  globalOutbound: null,
  limits: { cpuMs: 20_000, subRequests: 0 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * Starts the compiler in its own isolate, one per build, named `build`,
 * with its code read from core's static assets. The loader reuses a
 * running isolate with the same name, so `build` must name what is built
 * (see core's screens.ts).
 */
export const startScreenCompiler = (
  loader: WorkerLoader,
  assets: Fetcher,
  build: string
): Service<ScreenCompiler> =>
  loader
    .get(`screen-compiler:${build}`, async () => {
      const [source, kitJson] = await Promise.all([
        readCompilerFile(assets, compilerAssets.source, "javascript"),
        readCompilerFile(assets, compilerAssets.kit, "json"),
      ]);
      const kit: unknown = JSON.parse(kitJson);
      return {
        ...isolateSettings,
        mainModule: "compiler.js",
        modules: {
          "compiler.js": source,
          [kitModule]: { json: kit },
        },
      };
    })
    .getEntrypoint<ScreenCompiler>();
