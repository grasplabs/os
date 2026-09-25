/**
 * The screen compiler, as it runs in its own isolate (a Dynamic Worker, one
 * per build). It has no bindings and no network: it reads the files it is
 * given and what it knows of the kit, nothing else.
 *
 * Each App file becomes one ES module: Babel runs the React Compiler,
 * strips types and turns JSX into calls, then points imports at flat module
 * names (see kit.ts). There is no bundler: the kit's modules are built once
 * per release and shared by every App. Once every file compiles, the App is
 * type-checked and linted against the kit's design system; then Tailwind
 * compiles the CSS for the classes in the App's and the kit's sources.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { compile } from "tailwindcss";

import kit from "#kit";

import { extractCandidates } from "./candidates.ts";
import { compileModule, transformModule } from "./compile.ts";
import { isError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { collectImports, importError, rewriteImports } from "./imports.ts";
import type { ImportSite } from "./imports.ts";
import { appModuleName, kitStylesheet } from "./kit.ts";
import { lint } from "./lint.ts";
import { typeCheck } from "./type-check.ts";

/**
 * An App's modules by flat name and the CSS they use, or why it failed.
 * Errors fail a build; warnings don't.
 */
export type ScreenBuild =
  | {
      ok: true;
      modules: Record<string, string>;
      css: string;
      diagnostics: Diagnostic[];
    }
  | { ok: false; diagnostics: Diagnostic[] };

const screenFile = /^screens\/[\w-]+\.tsx$/u;
// Folders are plain names, so a path can't step out of `components/`.
const componentFile = /^components\/(?:[\w-]+\/)*[\w.-]+\.tsx?$/u;
/** Types the App's code can use but that aren't code, e.g. its server's. */
const declarationFile = /^[\w-]+\.d\.ts$/u;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface Location {
  file?: string;
  line?: number;
  column?: number;
}

/** Where Babel says an error is: its syntax errors carry `loc`, columns from 0. */
const locationOf = (error: unknown): Location => {
  if (typeof error !== "object" || error === null || !("loc" in error)) {
    return {};
  }
  const { loc } = error;
  if (
    typeof loc !== "object" ||
    loc === null ||
    !("line" in loc) ||
    !("column" in loc)
  ) {
    return {};
  }
  const { line, column } = loc;
  return typeof line === "number" && typeof column === "number"
    ? { line, column: column + 1 }
    : {};
};

/** An error, which fails the build. */
const problem = (
  rule: string,
  message: string,
  at: Location = {}
): Diagnostic => ({ ...at, rule, severity: "error", message });

/** Two App files that would share a module name, e.g. `a.ts` and `a.tsx`. */
const nameClashes = (paths: string[]): Diagnostic[] => {
  const byName = new Map<string, string>();
  const clashes: Diagnostic[] = [];
  for (const path of paths) {
    const other = byName.get(appModuleName(path));
    if (other === undefined) {
      byName.set(appModuleName(path), path);
    } else {
      clashes.push(
        problem("file-names", `Rename it or ${other}; they can't both exist.`, {
          file: path,
        })
      );
    }
  }
  return clashes;
};

/** Compiles one App file, or says why it can't be. */
const compileFile = (
  path: string,
  source: string,
  files: ReadonlySet<string>
): { code: string } | { errors: Diagnostic[] } => {
  const imports: ImportSite[] = [];
  let compiled: string;
  try {
    compiled = compileModule(source, path, [collectImports(imports)]);
  } catch (error) {
    // Babel names the file in syntax errors (as `/<path>`); the React
    // Compiler doesn't. The diagnostic names it on its own.
    const message = messageOf(error);
    return {
      errors: [
        problem(
          "compile",
          message.replace(`/${path}: `, "").replace(`${path}: `, ""),
          { file: path, ...locationOf(error) }
        ),
      ],
    };
  }
  const errors: Diagnostic[] = [];
  for (const site of imports) {
    const message = importError(site, path, files, kit);
    if (message !== undefined) {
      errors.push(
        problem(
          "imports",
          message,
          site.line === undefined
            ? { file: path }
            : { file: path, line: site.line }
        )
      );
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    code: transformModule(compiled, path, [rewriteImports(path, files, kit)]),
  };
};

/** The CSS for the kit's theme and every class the App and the kit use. */
const buildCss = async (sources: string[]): Promise<string> => {
  const tailwind = await compile(kit.stylesheets[kitStylesheet] ?? "", {
    // The kit's stylesheet only imports stylesheets that ship with the kit.
    // oxlint-disable-next-line require-await -- Tailwind expects a promise
    loadStylesheet: async (id: string) => {
      const content = kit.stylesheets[id];
      if (content === undefined) {
        throw new Error(`The stylesheet "${id}" is not in the kit`);
      }
      return { path: id, base: "/", content };
    },
  });
  return tailwind.build([
    ...kit.candidates,
    ...sources.flatMap((source) => extractCandidates(source)),
  ]);
};

/** The files a build reads: screens, components and declarations. */
const appFiles = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        screenFile.test(path) ||
        componentFile.test(path) ||
        declarationFile.test(path)
    )
  );

/**
 * Type-checks the App against the kit's types and lints it against the
 * kit's design system.
 */
export const checkScreens = (files: Record<string, string>): Diagnostic[] => {
  const app = appFiles(files);
  return [...typeCheck(app, kit.types), ...lint(app, kit)];
};

/**
 * Builds an App's screens: `screens/*.tsx`, the `components/` they use and
 * the declarations (`*.d.ts`) at the App's root.
 */
export const buildScreens = async (
  files: Record<string, string>
): Promise<ScreenBuild> => {
  const sources = Object.entries(appFiles(files)).filter(
    ([path]) => !declarationFile.test(path)
  );
  const paths = sources.map(([path]) => path);
  if (!paths.some((path) => screenFile.test(path))) {
    return {
      ok: false,
      diagnostics: [
        problem(
          "screens",
          "The App has no screens: add one as screens/<name>.tsx."
        ),
      ],
    };
  }
  const clashes = nameClashes(paths);
  if (clashes.length > 0) {
    return { ok: false, diagnostics: clashes };
  }
  const known = new Set(paths);
  const modules: Record<string, string> = {};
  const errors: Diagnostic[] = [];
  for (const [path, source] of sources) {
    const result = compileFile(path, source, known);
    if ("code" in result) {
      modules[appModuleName(path)] = result.code;
    } else {
      errors.push(...result.errors);
    }
  }
  // The checks would only say it again, less clearly.
  if (errors.length > 0) {
    return { ok: false, diagnostics: errors };
  }
  const diagnostics = checkScreens(files);
  if (diagnostics.some((diagnostic) => isError(diagnostic))) {
    return { ok: false, diagnostics };
  }
  const css = await buildCss(sources.map(([, source]) => source));
  return { ok: true, modules, css, diagnostics };
};

export default class ScreenCompiler extends WorkerEntrypoint {
  // RPC exposes prototype methods only, so these can't be static.
  // oxlint-disable-next-line class-methods-use-this
  async build(files: Record<string, string>): Promise<ScreenBuild> {
    return await buildScreens(files);
  }

  /** Only the type check and the lint, without building. */
  // oxlint-disable-next-line class-methods-use-this
  check(files: Record<string, string>): Diagnostic[] {
    return checkScreens(files);
  }
}
