// The compiler isolate's code and the kit's modules, generated into dist/ by build.ts.
import type { KitModules } from "./kit.ts";

/** The compiler's main module: src/worker.ts, bundled with what it knows of the kit. */
export declare const source: string;
/** The kit's modules, shared by every App of this release. */
export declare const kitModules: KitModules;
