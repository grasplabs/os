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
import { appModuleName, kitStylesheet, ownEntry } from "./kit.ts";
import { lint } from "./lint.ts";
import { typeCheck } from "./type-check.ts";

/**
 * An App's modules by flat name, the kit's modules they need (directly or
 * through each other) and the CSS they use; or why it failed. Errors fail
 * a build; warnings don't.
 */
export type ScreenBuild =
  | {
      ok: true;
      modules: Record<string, string>;
      kitModules: string[];
      css: string;
      diagnostics: Diagnostic[];
    }
  | { ok: false; diagnostics: Diagnostic[] };

const screenFile = /^screens\/[\w-]+\.tsx$/u;
// Folders are plain names, so a path can't step out of `components/`.
const componentFile = /^components\/(?:[\w-]+\/)*[\w.-]+\.tsx?$/u;
/** Types the App's code can use but that aren't code, e.g. its server's. */
const declarationFile = /^[\w-]+\.d\.ts$/u;

/**
 * The most a build takes, so that it stays well inside its isolate's CPU
 * and memory, and a mistake (or an attack) fails fast and says why.
 */
const limits = { files: 200, fileLength: 200_000, totalLength: 1_000_000 };
/** The line a React Compiler error points at in its code frame: `> 3 |`. */
const framedLine = /^> *(?<line>\d+) \|/mu;

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

/** Where a compile error is: Babel's location, or the React Compiler's line. */
const compileErrorAt = (error: unknown, message: string): Location => {
  const located = locationOf(error);
  const line = framedLine.exec(message)?.groups?.line;
  return located.line === undefined && line !== undefined
    ? { line: Number(line) }
    : located;
};

/** A compile error's message, in words for whoever fixes the file. */
const compileMessage = (message: string): string =>
  message.includes("Handle Import expressions")
    ? "import() can't be used inside a component or hook: import the module at the top of the file."
    : message;

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

/**
 * An error's message without the file Babel names in it (as `/<path>`):
 * the diagnostic names it on its own.
 */
const messageIn = (path: string, error: unknown): string =>
  messageOf(error).replace(`/${path}: `, "").replace(`${path}: `, "");

/**
 * Compiles one App file, or says why it can't be. Adds the kit modules it
 * imports to `kitImports`.
 */
const compileFile = (
  path: string,
  source: string,
  files: ReadonlySet<string>,
  kitImports: Set<string>
): { code: string } | { errors: Diagnostic[] } => {
  const imports: ImportSite[] = [];
  let compiled: string;
  try {
    compiled = compileModule(source, path, [collectImports(imports)]);
  } catch (error) {
    const message = messageIn(path, error);
    return {
      errors: [
        problem("compile", compileMessage(message), {
          file: path,
          ...compileErrorAt(error, message),
        }),
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
  try {
    return {
      code: transformModule(compiled, path, [
        rewriteImports(path, files, kit, kitImports),
      ]),
    };
  } catch (error) {
    return {
      errors: [problem("imports", messageIn(path, error), { file: path })],
    };
  }
};

/** The kit's modules these import, and every kit module those import. */
const kitModulesFor = (imported: Iterable<string>): string[] => {
  const needed = new Set<string>();
  const queue = [...imported];
  for (const name of queue) {
    if (!needed.has(name)) {
      needed.add(name);
      queue.push(...(ownEntry(kit.moduleImports, name) ?? []));
    }
  }
  return [...needed].toSorted();
};

/** The CSS for the kit's theme and every class the App and the kit use. */
const buildCss = async (sources: string[]): Promise<string> => {
  const tailwind = await compile(kit.stylesheets[kitStylesheet] ?? "", {
    // The kit's stylesheet only imports stylesheets that ship with the kit.
    // oxlint-disable-next-line require-await -- Tailwind expects a promise
    loadStylesheet: async (id: string) => {
      const content = ownEntry(kit.stylesheets, id);
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

/** Why these App files are more than a build takes, if they are. */
const limitErrors = (files: Record<string, string>): Diagnostic[] => {
  const entries = Object.entries(files);
  if (entries.length > limits.files) {
    return [
      problem(
        "limits",
        `The App has ${entries.length} screens, components and declarations; a build takes at most ${limits.files}.`
      ),
    ];
  }
  const errors = entries
    .filter(([, source]) => source.length > limits.fileLength)
    .map(([path, source]) =>
      problem(
        "limits",
        `This file has ${source.length} characters; a file can have at most ${limits.fileLength}. Split it up.`,
        { file: path }
      )
    );
  const total = entries.reduce((sum, [, source]) => sum + source.length, 0);
  if (total > limits.totalLength) {
    errors.push(
      problem(
        "limits",
        `The App's files have ${total} characters together; a build takes at most ${limits.totalLength}.`
      )
    );
  }
  return errors;
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
  const tooMuch = limitErrors(app);
  if (tooMuch.length > 0) {
    return tooMuch;
  }
  return [...typeCheck(app, kit.types), ...lint(app, kit)];
};

/**
 * Builds an App's screens: `screens/*.tsx`, the `components/` they use and
 * the declarations (`*.d.ts`) at the App's root.
 */
export const buildScreens = async (
  files: Record<string, string>
): Promise<ScreenBuild> => {
  const app = appFiles(files);
  const tooMuch = limitErrors(app);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  const sources = Object.entries(app).filter(
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
  const kitImports = new Set<string>();
  const errors: Diagnostic[] = [];
  for (const [path, source] of sources) {
    const result = compileFile(path, source, known, kitImports);
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
  return {
    ok: true,
    modules,
    kitModules: kitModulesFor(kitImports),
    css,
    diagnostics,
  };
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
