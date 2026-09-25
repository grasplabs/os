/**
 * Screen compiler: builds an App's screens into ES modules and CSS, in a
 * Dynamic Worker of its own. The modules import each other and the kit's
 * modules by flat name (see kit.ts); a page maps those names to the code
 * with an import map.
 */
import { kitModules as builtKitModules, source, version } from "#isolate";
import kit from "#kit";

import { kitModule } from "./kit.ts";
import type { KitModules } from "./kit.ts";
import type ScreenCompiler from "./worker.ts";

export type { Diagnostic } from "./diagnostic.ts";
export type { KitModules } from "./kit.ts";
export type { ScreenBuild } from "./worker.ts";
/** Part of every build's cache key: a new compiler or kit builds again. */
export { version as compilerVersion } from "#isolate";

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
export const kitModules = (): KitModules => builtKitModules;

/** The compiler's compatibility date, as core's. */
const compatibilityDate = "2026-09-15";

/**
 * Starts the compiler in its own isolate, one per build: no bindings and no
 * network (`globalOutbound: null`). `nodejs_compat` is for the React
 * Compiler, which is written for Node.
 */
export const startScreenCompiler = (
  loader: WorkerLoader,
  build: string
): Service<ScreenCompiler> =>
  loader
    .get(`screen-compiler:${version}:${build}`, () => ({
      compatibilityDate,
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "compiler.js",
      modules: { "compiler.js": source, [kitModule]: { json: kit } },
      env: {},
      globalOutbound: null,
    }))
    .getEntrypoint<ScreenCompiler>();
