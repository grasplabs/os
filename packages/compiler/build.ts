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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";
import shadcnPreset from "ultracite/oxlint/shadcn";
import { build } from "vite-plus";
import type { InlineConfig, Plugin, Rolldown } from "vite-plus";
import { z } from "zod";

import { extractCandidates } from "./src/candidates.ts";
import { compileModule } from "./src/compile.ts";
import { sdkImports } from "./src/imports.ts";
import {
  compilerAssets,
  kitModule,
  kitModuleName,
  kitStylesheet,
} from "./src/kit.ts";
import type { Kit, KitModules } from "./src/kit.ts";
import { compilerOptions } from "./src/type-check.ts";

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
 * Built chunks as modules by flat name, importing each other by that name
 * instead of by relative path, and what each imports.
 */
const flatModules = (
  chunks: Rolldown.OutputChunk[]
): { code: Record<string, string>; imports: Record<string, string[]> } => {
  const code: Record<string, string> = {};
  const imports: Record<string, string[]> = {};
  for (const chunk of chunks) {
    let flat = chunk.code;
    const imported = [...chunk.imports, ...chunk.dynamicImports];
    for (const name of imported) {
      flat = flat.replaceAll(`"./${name}"`, `"${name}"`);
    }
    if (flat.includes('"./')) {
      throw new Error(`${chunk.fileName} still imports by relative path`);
    }
    code[chunk.fileName] = flat;
    imports[chunk.fileName] = imported;
  }
  return { code, imports };
};

/**
 * The kit's modules: React, `@grasp-os/ui` and lucide-react's icons, built
 * together so they share one React and one copy of every dependency. Entries
 * and the chunks they share are named flat (`react.js`, `kit~….js`), and
 * import each other by that name instead of by relative path. Returns their
 * code and what each imports, by flat name.
 */
const buildKitModules = async (
  entries: Entry[]
): Promise<{
  code: Record<string, string>;
  imports: Record<string, string[]>;
}> => {
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
  const built = flatModules(chunksOf(await build(config)));
  for (const { specifier } of entries) {
    if (built.code[kitModuleName(specifier)] === undefined) {
      throw new Error(`The kit has no module for ${specifier}`);
    }
  }
  return built;
};

/**
 * The workflow SDK's modules, which App workflows import (`sdkImports`):
 * one module per specifier, named by it (`@grasp-os~sdk~workflow.js`),
 * and chunks for what they share (Zod), importing each other by flat name
 * like the kit's modules.
 */
const buildSdkModules = async (): Promise<Record<string, string>> => {
  const sdk = realpathSync(path.join(modules, "@grasp-os/sdk"));
  const exported = exportsOf(sdk);
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    resolve: { conditions: ["workerd", "worker"] },
    build: {
      write: false,
      minify: true,
      target: "es2022",
      modulePreload: false,
      copyPublicDir: false,
      rolldownOptions: {
        input: Object.fromEntries(
          sdkImports.map((specifier) => {
            const target =
              exported[`.${specifier.slice("@grasp-os/sdk".length)}`];
            if (typeof target !== "string") {
              throw new TypeError(`The SDK doesn't export ${specifier}`);
            }
            return [
              kitModuleName(specifier).slice(0, -".js".length),
              path.join(sdk, target),
            ];
          })
        ),
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "sdk~[name]-[hash].js",
        },
      },
    },
  };
  return flatModules(chunksOf(await build(config))).code;
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

/**
 * Drops JSDoc comments: most of TypeScript's and lucide-react's
 * declarations, and nothing a type check reads.
 */
const withoutDocComments = (source: string): string => {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source
  );
  let result = "";
  let kept = 0;
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    const start = scanner.getTokenStart();
    if (
      token === ts.SyntaxKind.MultiLineCommentTrivia &&
      source.startsWith("/**", start)
    ) {
      result += source.slice(kept, start);
      kept = scanner.getTokenEnd();
    }
  }
  return result + source.slice(kept);
};

const declaration = /\.d\.[cm]?ts$/u;

/**
 * The files a type check of App code reads, by the path the isolate knows
 * them by (see src/type-check.ts): TypeScript loads everything App code may
 * import, with the options the isolate checks with, and every file it reads
 * is kept. Packages are flattened into `/node_modules/<name>`, the kit's
 * sources too; two versions of one package would clash, and fail the build.
 */
const collectTypes = (specifiers: string[]): Record<string, string> => {
  const entry = path.join(root, "kit-types.ts");
  // Third-party declarations can have errors that don't matter here.
  const options = { ...compilerOptions, skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const read = new Map<string, string>();
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => {
    const content = readFile(file);
    if (content !== undefined) {
      read.set(file, content);
    }
    return content;
  };
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...rest) =>
    file === entry
      ? ts.createSourceFile(
          file,
          specifiers.map((specifier) => `import "${specifier}";`).join("\n"),
          ts.ScriptTarget.Latest
        )
      : getSourceFile(file, ...rest);
  const program = ts.createProgram([entry], options, host);
  const [error] = ts.getPreEmitDiagnostics(program);
  if (error !== undefined) {
    throw new Error(
      `The kit doesn't type-check: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`
    );
  }
  const types: Record<string, string> = {};
  for (const [file, content] of read) {
    const real = realpathSync(file);
    const inPackage = real.split("/node_modules/").at(-1) ?? real;
    let name: string;
    if (real.startsWith(`${ui}/`)) {
      name = `/node_modules/@grasp-os/ui${real.slice(ui.length)}`;
    } else if (inPackage === real) {
      // The compiler's own package.json, read for the entry.
      continue;
    } else {
      name = `/node_modules/${inPackage}`;
    }
    const kept = declaration.test(name) ? withoutDocComments(content) : content;
    if (types[name] !== undefined && types[name] !== kept) {
      throw new Error(`Two versions of ${name} in the kit's types`);
    }
    types[name] = kept;
  }
  return types;
};

const componentsJsonSchema = z.looseObject({
  tailwind: z.looseObject({ css: z.string() }),
});

/**
 * The kit as the design-system lint reads it from disk (see src/lint.ts),
 * by path relative to the App. The kit's sources go in `ui/`: in
 * `node_modules`, the lint doesn't read components' sources, so it couldn't
 * name their variants. A tsconfig maps the kit's exports there; the
 * stylesheets the theme imports go in `node_modules`, where the lint looks.
 */
const collectLintProject = (
  stylesheets: Record<string, string>
): Record<string, string> => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "app", private: true }),
    "ui/package.json": readText(path.join(ui, "package.json")),
  };
  for (const file of readdirSync(path.join(ui, "src"), {
    recursive: true,
    encoding: "utf-8",
  })) {
    const source = path.join(ui, "src", file);
    if (statSync(source).isFile()) {
      files[`ui/src/${file}`] = readText(source);
    }
  }
  const components = componentsJsonSchema.parse(
    JSON.parse(readText(path.join(ui, "components.json")))
  );
  files["components.json"] = JSON.stringify({
    ...components,
    tailwind: { ...components.tailwind, css: `ui/${components.tailwind.css}` },
  });
  const paths: Record<string, string[]> = {};
  for (const [key, target] of Object.entries(exportsOf(ui))) {
    if (typeof target === "string") {
      const specifier = `@grasp-os/ui${key.slice(1)}`;
      paths[specifier] = [`./ui${target.slice(1)}`];
      // `components.json` names the components' directory by its alias.
      if (key.endsWith("/*")) {
        paths[specifier.slice(0, -2)] = [
          `./ui${path.posix.dirname(target.slice(1))}`,
        ];
      }
    }
  }
  files["tsconfig.json"] = JSON.stringify({ compilerOptions: { paths } });
  for (const [id, content] of Object.entries(stylesheets)) {
    if (id !== kitStylesheet) {
      files[`node_modules/${id.endsWith(".css") ? id : `${id}/index.css`}`] =
        content;
    }
  }
  return files;
};

const severity = z.enum(["off", "warn", "error"]);
const rulesSchema = z.record(
  z.string(),
  z.union([severity, z.tuple([severity]).rest(z.unknown())])
);

/** Node's built-ins, which the isolate has through `nodejs_compat`. */
const nodeBuiltins = [
  /^node:/u,
  ...builtinModules.filter((name) => !name.startsWith("_")),
];

/**
 * The React Compiler and TypeScript are CommonJS written for Node and
 * `require` Node's built-ins. An ES module has no `require`; the bundle's
 * `require` shim uses one if it is in scope, and `createRequire` makes one.
 * It takes the module's URL, and a Dynamic Worker's modules have no
 * `import.meta.url`, so this passes the URL the module would have. It goes
 * in after minifying, which would rename `require`.
 */
const moduleUrl = "file:///compiler.js";
const requireShim = `import { createRequire } from "node:module"; const require = createRequire("${moduleUrl}");`;

/**
 * Where the module would be, for the libraries that ask: TypeScript
 * (`__filename`, `__dirname`) and @shadcn/lint (`import.meta.url`). They
 * only look next to themselves for files that aren't there, and carry on
 * without them. Babel's generated code mentions them only as text.
 */
const moduleLocation = {
  "import.meta.url": JSON.stringify(moduleUrl),
  __filename: JSON.stringify("/compiler.js"),
  __dirname: JSON.stringify("/"),
};

/**
 * The design-system lint (@shadcn/lint) loads its parser with a `require`
 * at runtime, which in the isolate only finds Node's built-ins: this hands
 * it the bundled typescript-eslint parser instead. oxc-parser, which it
 * tries first, has no build that runs in a Worker (its WASM one needs
 * threads); that `require` fails and it falls back to typescript-eslint.
 */
const shadcnParser: Plugin = {
  name: "shadcn-lint-parser",
  transform: (code, id) => {
    if (!id.endsWith("/@shadcn/lint/dist/index.js")) {
      return null;
    }
    const required = 'require("@typescript-eslint/parser")';
    if (!code.includes(required)) {
      throw new Error(
        "@shadcn/lint no longer requires its parser the way the build expects"
      );
    }
    return `import * as typescriptEslintParser from "@typescript-eslint/parser";
${code.replace(required, "typescriptEslintParser")}`;
  },
};

/**
 * The compiler's main module. It imports what it knows of the kit (`#kit`)
 * as a module of its own, `kit.json`, which the isolate is started with:
 * most of it is the type check's declarations, which the compiler's code
 * doesn't need to carry.
 */
const buildCompiler = async (): Promise<string> => {
  const config: InlineConfig = {
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    ssr: { noExternal: true, target: "webworker" },
    define: moduleLocation,
    plugins: [shadcnParser],
    build: {
      ssr: "src/worker.ts",
      write: false,
      minify: true,
      target: "es2022",
      rolldownOptions: {
        external: ["cloudflare:workers", "#kit", ...nodeBuiltins],
        output: {
          format: "es",
          codeSplitting: false,
          paths: { "#kit": kitModule },
          postBanner: requireShim,
        },
      },
    },
  };
  const [chunk, ...rest] = chunksOf(await build(config));
  if (chunk === undefined || rest.length > 0) {
    throw new Error("The compiler should build to one module");
  }
  return chunk.code;
};

/** Modules with a version that changes with any change to them. */
const modulesOf = (code: Record<string, string>): KitModules => ({
  version: createHash("sha256")
    .update(JSON.stringify(code))
    .digest("hex")
    .slice(0, 16),
  modules: code,
});

/** Builds the kit, then the compiler, into dist/. */
const buildScreenCompiler = async (
  assets = path.join(dist, "assets")
): Promise<void> => {
  mkdirSync(dist, { recursive: true });
  const { entries: icons, icons: iconNames } = iconEntries();
  const components = uiEntries();
  const react = reactSpecifiers.map((specifier) => ({
    specifier,
    id: `${virtualEntry}${specifier}`,
  }));
  const { code: kitCode, imports: moduleImports } = await buildKitModules([
    ...react,
    ...components,
    ...icons,
  ]);
  const candidates = sourcesIn(path.join(ui, "src")).flatMap((file) =>
    extractCandidates(readText(file))
  );
  const imports = [
    ...reactImports,
    ...components.map(({ specifier }) => specifier),
  ];
  const stylesheets = collectStylesheets();
  const kit: Kit = {
    imports,
    icons: iconNames,
    stylesheets,
    candidates: [...new Set(candidates)].toSorted(),
    moduleImports,
    types: collectTypes([...imports, "lucide-react"]),
    lintProject: collectLintProject(stylesheets),
    // The repo's lint config extends the same preset.
    lintRules: rulesSchema.parse(shadcnPreset.rules),
  };
  const kitJson = JSON.stringify(kit);
  const compiler = await buildCompiler();
  const kitModules = modulesOf(kitCode);
  const sdkModules = modulesOf(await buildSdkModules());
  // Everything a build depends on: the compiler, what it knows of the kit,
  // and the kit's and the SDK's modules the App's modules import.
  const version = createHash("sha256")
    .update(compiler)
    .update(kitJson)
    .update(kitModules.version)
    .update(sdkModules.version)
    .digest("hex")
    .slice(0, 16);
  // Core imports only the version; the rest it reads from its static
  // assets when it starts a build, so it never loads them otherwise.
  writeFileSync(
    path.join(dist, "version.js"),
    `export const version = "${version}";\n`
  );
  const releases = path.join(assets, compilerAssets.directory(""));
  rmSync(releases, { recursive: true, force: true });
  const release = path.join(assets, compilerAssets.directory(version));
  mkdirSync(release, { recursive: true });
  writeFileSync(path.join(release, compilerAssets.source), compiler);
  writeFileSync(path.join(release, compilerAssets.kit), kitJson);
  writeFileSync(
    path.join(release, compilerAssets.kitModules),
    JSON.stringify(kitModules)
  );
  writeFileSync(
    path.join(release, compilerAssets.sdkModules),
    JSON.stringify(sdkModules)
  );
  const kitSize = Object.values(kitCode).join("").length;
  console.info(
    `Screen compiler ${version}: ${(compiler.length / 1e6).toFixed(1)} MB and ${(kitJson.length / 1e6).toFixed(1)} MB of what it knows of the kit; kit ${kitModules.version}: ${Object.keys(kitCode).length} modules, ${(kitSize / 1e6).toFixed(1)} MB`
  );
};

/**
 * Builds the compiler, with its files in `assets` (dist/assets unless
 * given): core runs this with its own static assets directory.
 */
export default buildScreenCompiler;
if (import.meta.main) {
  await buildScreenCompiler(process.argv[2]);
}
