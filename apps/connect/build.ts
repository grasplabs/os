/**
 * Builds the native connectors into dist/connectors.js, once per release at
 * connect's build time: every package in packages/connectors, each as its
 * manifest and its MCP server bundled into one ES module. Connect imports
 * the result through `#connectors` and loads a connector's module into an
 * isolate of its own for each call, so adding a connector is adding a
 * package: no Worker, no wrangler.jsonc entry.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import type { ConnectorManifest } from "@grasp-os/connector-kit/manifest";
import { build } from "vite-plus";
import type { Plugin, Rolldown } from "vite-plus";
import { z } from "zod";

const root = import.meta.dirname;
const packages = path.join(root, "../../packages/connectors");

/** Where connect's `#connectors` import finds the release's connectors. */
export const connectorsFile = path.join(root, "dist/connectors.js");

const packageSchema = z.object({
  exports: z.object({ ".": z.string() }),
});

/** Every connector package's entry module. */
export const connectorEntries = (): string[] =>
  readdirSync(packages)
    .map((dir) => path.join(packages, dir))
    .filter((dir) => existsSync(path.join(dir, "package.json")))
    .map((dir) => {
      const manifest = packageSchema.parse(
        JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
      );
      return path.join(dir, manifest.exports["."]);
    });

const moduleSchema = z.object({
  default: z.object({ manifest: z.unknown() }),
});

const entryId = "\0connector-entry";

/**
 * The isolate's main module: the connector's MCP server as its fetch
 * handler, and nothing else. Its env and context aren't passed on: the
 * connector gets neither.
 */
const entryModule = (entry: string): Plugin => ({
  name: "connector-entry",
  resolveId: (id) => (id === entryId ? id : null),
  load: (id) =>
    id === entryId
      ? `import connector from ${JSON.stringify(entry)};
export default { fetch: (request) => connector.fetch(request) };`
      : null,
});

const chunksOf = (
  result: Awaited<ReturnType<typeof build>>
): Rolldown.OutputChunk[] =>
  [result]
    .flat()
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((file) => file.type === "chunk");

/** The connector at `entry`, bundled with what it imports into one module. */
const bundle = async (entry: string): Promise<string> => {
  const chunks = chunksOf(
    await build({
      configFile: false,
      root,
      logLevel: "warn",
      mode: "production",
      plugins: [entryModule(entry)],
      build: {
        write: false,
        minify: true,
        target: "es2022",
        modulePreload: false,
        copyPublicDir: false,
        rolldownOptions: {
          input: entryId,
          preserveEntrySignatures: "strict",
          // The runtime's own modules, which the isolate refuses anyway:
          // it gets no env and no bindings to import.
          external: [/^cloudflare:/u],
          output: { format: "es", codeSplitting: false },
        },
      },
    })
  );
  const [chunk] = chunks;
  if (chunk === undefined || chunks.length !== 1) {
    throw new Error(`${entry} didn't bundle into one module`);
  }
  return chunk.code;
};

/**
 * Builds the connectors at `entries` into `outFile`. Each one's manifest
 * comes from its module (so the manifest and the tools can't drift apart)
 * and must be valid; two connectors may not share a name.
 */
export const buildConnectors = async (
  entries: readonly string[],
  outFile: string
): Promise<void> => {
  const connectors: { manifest: ConnectorManifest; code: string }[] = [];
  for (const entry of entries) {
    const loaded = moduleSchema.parse(
      // oxlint-disable-next-line no-await-in-loop -- one connector at a time
      await import(pathToFileURL(entry).href)
    );
    const manifest = connectorManifestSchema.parse(loaded.default.manifest);
    if (connectors.some((each) => each.manifest.name === manifest.name)) {
      throw new Error(`Two connectors are named ${manifest.name}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- one connector at a time
    connectors.push({ manifest, code: await bundle(entry) });
  }
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `export default ${JSON.stringify(connectors)};\n`);
  for (const { manifest, code } of connectors) {
    console.info(
      `Connector ${manifest.name} ${manifest.version}: ${(code.length / 1e3).toFixed(0)} kB`
    );
  }
};

if (import.meta.main) {
  await buildConnectors(connectorEntries(), connectorsFile);
}
