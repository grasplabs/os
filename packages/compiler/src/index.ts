/**
 * Screen compiler: builds an App's screens into ES modules and CSS, in a
 * Dynamic Worker of its own. The modules import each other and the kit's
 * modules by flat name (see kit.ts); a page maps those names to the code
 * with an import map.
 *
 * The compiler's code and what it knows of the kit are most of core's
 * code, and most requests never build: they are evaluated on first use.
 */
import { compatibilityDate } from "@grasp-os/shared/runtime";

import { kitModule } from "./kit.ts";
import type { KitModules } from "./kit.ts";
import type ScreenCompiler from "./worker.ts";

export type { Diagnostic } from "./diagnostic.ts";
export type { KitModules } from "./kit.ts";
export type { ScreenBuild } from "./worker.ts";
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

/** The kit's modules, which every App's modules import: one set per release. */
export const kitModules = async (): Promise<KitModules> => {
  const { kitModules: modules } = await import("#isolate");
  return modules;
};

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
 * Starts the compiler in its own isolate, one per build, named `build`.
 * The loader reuses a running isolate with the same name, so `build` must
 * name what is built (see core's screens.ts).
 */
export const startScreenCompiler = (
  loader: WorkerLoader,
  build: string
): Service<ScreenCompiler> =>
  loader
    .get(`screen-compiler:${build}`, async () => {
      const [{ source }, { default: kit }] = await Promise.all([
        import("#isolate"),
        import("#kit"),
      ]);
      return {
        ...isolateSettings,
        mainModule: "compiler.js",
        modules: { "compiler.js": source, [kitModule]: { json: kit } },
      };
    })
    .getEntrypoint<ScreenCompiler>();
