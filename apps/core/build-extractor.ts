/**
 * Builds the extractor (src/knowledge/extractor/worker.ts) into one ES
 * module among core's static assets, once per release at core's build
 * time, as the screen compiler is. Core reads it from there for each
 * extraction and runs it in a Dynamic Worker of its own
 * (src/knowledge/extract.ts); its libraries (pdf.js above all) never load
 * in core's own isolate.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { build } from "vite-plus";
import type { Rolldown } from "vite-plus";

import { extractorAsset } from "./src/knowledge/extractor/asset.ts";

const root = import.meta.dirname;

/** Node's built-ins, which the isolate has through `nodejs_compat`. */
const nodeBuiltins = [
  /^node:/u,
  ...builtinModules.filter((name) => !name.startsWith("_")),
];

const bundleExtractor = async (): Promise<string> => {
  const result = await build({
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    ssr: { noExternal: true, target: "webworker" },
    build: {
      ssr: "src/knowledge/extractor/worker.ts",
      write: false,
      minify: true,
      target: "es2022",
      rolldownOptions: {
        external: ["cloudflare:workers", ...nodeBuiltins],
        output: { format: "es", codeSplitting: false },
      },
    },
  });
  const chunks = [result]
    .flat()
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((file): file is Rolldown.OutputChunk => file.type === "chunk");
  const [chunk, ...rest] = chunks;
  if (chunk === undefined || rest.length > 0) {
    throw new Error("The extractor should build to one module");
  }
  return chunk.code;
};

/** Builds the extractor into `assets`, core's static assets directory. */
const buildExtractor = async (assets: string): Promise<void> => {
  const code = await bundleExtractor();
  const file = path.join(assets, extractorAsset);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, code);
  console.info(`Extractor: ${(code.length / 1e6).toFixed(1)} MB`);
};

export default buildExtractor;
if (import.meta.main) {
  const [assets] = process.argv.slice(2);
  if (assets === undefined) {
    throw new Error("Usage: node build-extractor.ts <assets directory>");
  }
  await buildExtractor(assets);
}
