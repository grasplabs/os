/**
 * Builds the screen compiler into dist/, once per release at core's build
 * time: the kit's modules, what the compiler needs to know of the kit, and
 * the compiler that runs in its own isolate. Core imports the result
 * through `#isolate`.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";

import { build } from "vite-plus";
import type { InlineConfig, Plugin, Rolldown } from "vite-plus";
import { z } from "zod";

import { extractCandidates } from "./src/candidates.ts";
import { compileModule } from "./src/compile.ts";
import { kitModuleName, kitStylesheet } from "./src/kit.ts";
import type { Kit, KitModules } from "./src/kit.ts";

const root = import.meta.dirname;
const dist = path.join(root, "dist");
const modules = path.join(root, "node_modules");
const ui = realpathSync(path.join(modules, "@grasp-os/ui"));
const require = createRequire(path.join(root, "package.json"));

/** React as the kit's modules and App modules import it. */
const reactSpecifiers = [
  "react",
  "react/jsx-runtime",
  "react/compiler-runtime",
  "react-dom",
  "react-dom/client",
];
/** What App code may import besides `@grasp-os/ui` and lucide-react icons. */
const reactImports = ["react", "react/jsx-runtime"];

// A package.json, as far as the build reads it.
const manifestSchema = z.object({
  exports: z
    .record(
      z.string(),
      z.union([z.string(), z.object({ style: z.string().optional() })])
    )
    .optional(),
  module: z.string().optional(),
});

const readText = (file: string): string => readFileSync(file, "utf-8");

const manifestOf = (dir: string) =>
  manifestSchema.parse(JSON.parse(readText(path.join(dir, "package.json"))));

const exportsOf = (dir: string) => manifestOf(dir).exports ?? {};

/** Every source file under a directory. */
const sourcesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((file) => /\.tsx?$/u.test(file))
    .map((file) => path.join(dir, file));

/** A kit module's entry: its specifier and the file or virtual module it is. */
interface Entry {
  specifier: string;
  id: string;
}

/** `@grasp-os/ui`: one module per file its exports (`./components/*`, …) cover. */
const uiEntries = (): Entry[] =>
  Object.entries(exportsOf(ui)).flatMap(([key, target]) => {
    if (!key.endsWith("/*") || typeof target !== "string") {
      return [];
    }
    const [prefix = "", suffix = ""] = target.split("*");
    const dir = path.join(ui, prefix);
    const files = existsSync(dir)
      ? readdirSync(dir).filter((file) => file.endsWith(suffix))
      : [];
    return files.map((file) => ({
      specifier: `@grasp-os/ui/${key.slice(2, -1)}${file.slice(0, -suffix.length)}`,
      id: path.join(dir, file),
    }));
  });

/**
 * lucide-react's icons, one module each, and the export names App code
 * imports them by. Its index re-exports every icon module, one line each:
 * `export { default as A, default as B } from './icons/a.mjs';`.
 */
const iconEntries = (): { entries: Entry[]; icons: Kit["icons"] } => {
  const dir = realpathSync(path.join(modules, "lucide-react"));
  const index = path.join(dir, manifestOf(dir).module ?? "");
  const lines = readText(index).matchAll(
    /^export \{ (?<names>[^}]+) \} from '\.\/icons\/(?<file>[\w-]+)\.mjs';$/gmu
  );
  const entries: Entry[] = [];
  const icons: Kit["icons"] = {};
  for (const [, names = "", file = ""] of lines) {
    const specifier = `lucide-react/icons/${file}`;
    entries.push({
      specifier,
      id: path.join(path.dirname(index), "icons", `${file}.mjs`),
    });
    for (const name of names.split(", ")) {
      icons[name.split(" as ").at(-1) ?? name] = kitModuleName(specifier);
    }
  }
  if (entries.length === 0) {
    throw new Error(`No icons found in ${index}`);
  }
  return { entries, icons };
};

const virtualEntry = "\0kit-entry:";
const identifier = /^[A-Za-z_$][\w$]*$/u;

/**
 * React's packages are CommonJS, whose exports a bundler can't list. Each
 * gets an ES module that re-exports what the package exports under Node.
 */
const reactEntries: Plugin = {
  name: "kit-react-entries",
  resolveId: (id) => (id.startsWith(virtualEntry) ? id : null),
  load: (id) => {
    if (!id.startsWith(virtualEntry)) {
      return null;
    }
    const specifier = id.slice(virtualEntry.length);
    const exported = z
      .record(z.string(), z.unknown())
      .parse(require(specifier));
    const names = Object.keys(exported).filter(
      (name) => identifier.test(name) && name !== "default"
    );
    return `import m from "${specifier}";
export const { ${names.join(", ")} } = m;
export default m;`;
  },
};

/**
 * Compiles the kit's own sources with Babel and the React Compiler, the same
 * way as App files. They are the only TypeScript in the build.
 */
const reactCompiler: Plugin = {
  name: "kit-react-compiler",
  enforce: "pre",
  transform: (code, id) =>
    /\.tsx?$/u.test(id)
      ? { code: compileModule(code, path.relative(ui, id)) }
      : null,
};

const chunksOf = (
  result: Awaited<ReturnType<typeof build>>
): Rolldown.OutputChunk[] =>
  [result]
    .flat()
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((file) => file.type === "chunk");

/**
 * The kit's modules: React, `@grasp-os/ui` and lucide-react's icons, built
 * together so they share one React and one copy of every dependency. Entries
 * and the chunks they share are named flat (`react.js`, `kit~….js`), and
 * import each other by that name instead of by relative path.
 */
const buildKitModules = async (
  entries: Entry[]
): Promise<Record<string, string>> => {
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    // Babel compiles TypeScript here, with the React Compiler.
    oxc: false,
    plugins: [reactEntries, reactCompiler],
    build: {
      write: false,
      minify: true,
      target: "es2022",
      modulePreload: false,
      copyPublicDir: false,
      rolldownOptions: {
        input: Object.fromEntries(
          entries.map(({ specifier, id }) => [
            kitModuleName(specifier).slice(0, -".js".length),
            id,
          ])
        ),
        preserveEntrySignatures: "strict",
        // Base UI marks its modules "use client", for React Server
        // Components; screens only render on the client.
        onLog: (level, log, handle) => {
          if (log.code !== "MODULE_LEVEL_DIRECTIVE") {
            handle(level, log);
          }
        },
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "kit~[name]-[hash].js",
        },
      },
    },
  };
  const chunks = chunksOf(await build(config));
  const kitModules: Record<string, string> = {};
  for (const chunk of chunks) {
    let { code } = chunk;
    for (const imported of [...chunk.imports, ...chunk.dynamicImports]) {
      code = code.replaceAll(`"./${imported}"`, `"${imported}"`);
    }
    if (code.includes('"./')) {
      throw new Error(`${chunk.fileName} still imports by relative path`);
    }
    kitModules[chunk.fileName] = code;
  }
  for (const { specifier } of entries) {
    if (kitModules[kitModuleName(specifier)] === undefined) {
      throw new Error(`The kit has no module for ${specifier}`);
    }
  }
  return kitModules;
};

/** The kit's stylesheet and the ones it imports, by their `style` export. */
const collectStylesheets = (): Record<string, string> => {
  const sheet = readText(path.join(ui, "src/styles.css"));
  const stylesheets: Record<string, string> = { [kitStylesheet]: sheet };
  for (const [, id = ""] of sheet.matchAll(/@import "(?<id>[^"]+)"/gu)) {
    const segments = id.split("/");
    const nameLength = id.startsWith("@") ? 2 : 1;
    const dir = path.join(ui, "node_modules", ...segments.slice(0, nameLength));
    const subpath = segments.slice(nameLength).join("/");
    const entry = exportsOf(dir)[subpath === "" ? "." : `./${subpath}`];
    const file = typeof entry === "string" ? entry : entry?.style;
    if (file === undefined) {
      throw new Error(`No stylesheet found for "${id}"`);
    }
    stylesheets[id] = readText(path.join(dir, file));
  }
  return stylesheets;
};

/** Node's built-ins, which the isolate has through `nodejs_compat`. */
const nodeBuiltins = [
  /^node:/u,
  ...builtinModules.filter((name) => !name.startsWith("_")),
];

/**
 * The React Compiler is CommonJS written for Node and `require`s Node's
 * built-ins. An ES module has no `require`; the bundle's `require` shim uses
 * one if it is in scope, and `createRequire` makes one. It takes the
 * module's URL, and a Dynamic Worker's modules have no `import.meta.url`, so
 * this passes the URL the module would have. It goes in after minifying,
 * which would rename `require`. Nothing else in the bundle
 * reads `import.meta.url`, `__filename` or `__dirname`: they only appear in
 * code Babel generates as text.
 */
const requireShim =
  'import { createRequire } from "node:module"; const require = createRequire("file:///compiler.js");';

/** The compiler's main module; `#kit` resolves to dist/kit.json. */
const buildCompiler = async (): Promise<string> => {
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    ssr: { noExternal: true, target: "webworker" },
    build: {
      ssr: "src/worker.ts",
      write: false,
      minify: true,
      target: "es2022",
      rolldownOptions: {
        external: ["cloudflare:workers", ...nodeBuiltins],
        output: { format: "es", codeSplitting: false, postBanner: requireShim },
      },
    },
  };
  const [chunk, ...rest] = chunksOf(await build(config));
  if (chunk === undefined || rest.length > 0) {
    throw new Error("The compiler should build to one module");
  }
  return chunk.code;
};

/** Builds the kit, then the compiler, into dist/. */
const buildScreenCompiler = async (): Promise<void> => {
  mkdirSync(dist, { recursive: true });
  const { entries: icons, icons: iconNames } = iconEntries();
  const components = uiEntries();
  const react = reactSpecifiers.map((specifier) => ({
    specifier,
    id: `${virtualEntry}${specifier}`,
  }));
  const kitCode = await buildKitModules([...react, ...components, ...icons]);
  const candidates = sourcesIn(path.join(ui, "src")).flatMap((file) =>
    extractCandidates(readText(file))
  );
  const kit: Kit = {
    imports: [...reactImports, ...components.map(({ specifier }) => specifier)],
    icons: iconNames,
    stylesheets: collectStylesheets(),
    candidates: [...new Set(candidates)].toSorted(),
  };
  writeFileSync(path.join(dist, "kit.json"), JSON.stringify(kit));
  const compiler = await buildCompiler();
  const kitModules: KitModules = {
    version: createHash("sha256")
      .update(JSON.stringify(kitCode))
      .digest("hex")
      .slice(0, 16),
    modules: kitCode,
  };
  // Everything a build depends on: the compiler, what it knows of the kit,
  // and the kit's modules the App's modules import.
  const version = createHash("sha256")
    .update(compiler)
    .update(kitModules.version)
    .digest("hex")
    .slice(0, 16);
  writeFileSync(
    path.join(dist, "isolate.js"),
    `export const version = "${version}";
export const source = ${JSON.stringify(compiler)};
export const kitModules = ${JSON.stringify(kitModules)};
`
  );
  const kitSize = Object.values(kitCode).join("").length;
  console.info(
    `Screen compiler ${version}: ${(compiler.length / 1e6).toFixed(1)} MB; kit ${kitModules.version}: ${Object.keys(kitCode).length} modules, ${(kitSize / 1e6).toFixed(1)} MB`
  );
};

// Core's tests run this as their global setup; core's build runs the file.
export default buildScreenCompiler;
if (import.meta.main) {
  await buildScreenCompiler();
}
