/**
 * The screen compiler, as it runs in its own isolate (a Dynamic Worker, one
 * per build). It has no bindings and no network: it reads the files it is
 * given and what it knows of the kit, nothing else.
 *
 * Each App file becomes one ES module: Babel runs the React Compiler,
 * strips types and turns JSX into calls, then points imports at flat module
 * names (see kit.ts). There is no bundler: the kit's modules are built once
 * per release and shared by every App. Tailwind compiles the CSS for the
 * classes in the App's and the kit's sources.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { compile } from "tailwindcss";

import kit from "#kit";

import { extractCandidates } from "./candidates.ts";
import { compileModule, transformModule } from "./compile.ts";
import { collectImports, importError, rewriteImports } from "./imports.ts";
import type { ImportSite } from "./imports.ts";
import { appModuleName, kitStylesheet } from "./kit.ts";

/** An App's modules by flat name and the CSS they use; or why it failed. */
export type ScreenBuild =
  | { ok: true; modules: Record<string, string>; css: string }
  | { ok: false; errors: string[] };

const screenFile = /^screens\/[\w-]+\.tsx$/u;
// Folders are plain names, so a path can't step out of `components/`.
const componentFile = /^components\/(?:[\w-]+\/)*[\w.-]+\.tsx?$/u;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Two App files that would share a module name, e.g. `a.ts` and `a.tsx`. */
const nameClashes = (paths: string[]): string[] => {
  const byName = new Map<string, string>();
  const errors: string[] = [];
  for (const path of paths) {
    const other = byName.get(appModuleName(path));
    if (other === undefined) {
      byName.set(appModuleName(path), path);
    } else {
      errors.push(`${path}: rename it or ${other}; they can't both exist.`);
    }
  }
  return errors;
};

/** Compiles one App file, or says why it can't be. */
const compileFile = (
  path: string,
  source: string,
  files: ReadonlySet<string>
): { code: string } | { errors: string[] } => {
  const imports: ImportSite[] = [];
  let compiled: string;
  try {
    compiled = compileModule(source, path, [collectImports(imports)]);
  } catch (error) {
    // Babel names the file in syntax errors; the React Compiler doesn't.
    const message = messageOf(error);
    return {
      errors: [message.startsWith(path) ? message : `${path}: ${message}`],
    };
  }
  const errors = imports
    .map((site) => importError(site, path, files, kit))
    .filter((error) => error !== undefined);
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

/** Builds an App's screens: `screens/*.tsx`, and the `components/` they use. */
export const buildScreens = async (
  files: Record<string, string>
): Promise<ScreenBuild> => {
  const sources = Object.entries(files).filter(
    ([path]) => screenFile.test(path) || componentFile.test(path)
  );
  const paths = sources.map(([path]) => path);
  if (!paths.some((path) => screenFile.test(path))) {
    return {
      ok: false,
      errors: ["The App has no screens: add one as screens/<name>.tsx."],
    };
  }
  const clashes = nameClashes(paths);
  if (clashes.length > 0) {
    return { ok: false, errors: clashes };
  }
  const known = new Set(paths);
  const modules: Record<string, string> = {};
  const errors: string[] = [];
  for (const [path, source] of sources) {
    const result = compileFile(path, source, known);
    if ("code" in result) {
      modules[appModuleName(path)] = result.code;
    } else {
      errors.push(...result.errors);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const css = await buildCss(sources.map(([, source]) => source));
  return { ok: true, modules, css };
};

export default class ScreenCompiler extends WorkerEntrypoint {
  // RPC exposes prototype methods only, so this can't be static.
  // oxlint-disable-next-line class-methods-use-this
  async build(files: Record<string, string>): Promise<ScreenBuild> {
    return await buildScreens(files);
  }
}
