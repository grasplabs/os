/**
 * Type-checks App files with TypeScript 6, the last TypeScript with a
 * JavaScript API, against the kit's declarations. Everything is in memory:
 * App files at `/<path>`, the kit's packages at `/node_modules/<name>/…`,
 * as `build.ts` collected them (`Kit.types`).
 */
import ts from "typescript";

import type { Diagnostic } from "./diagnostic.ts";

/**
 * How App code is checked. `build.ts` loads the kit with the same options
 * to collect the files a check reads, so both must agree.
 */
export const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  // Babel compiles each file on its own.
  isolatedModules: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  // The kit's declarations are checked when it is built.
  skipLibCheck: true,
  types: [],
};

/** Where TypeScript's own declarations (`lib.dom.d.ts`, …) are. */
export const libLocation = "/node_modules/typescript/lib";

const trailingSlashes = /\/+$/u;

/** Every directory that holds one of these files. */
const directoriesOf = (paths: Iterable<string>): Set<string> => {
  const directories = new Set<string>(["/"]);
  for (const path of paths) {
    for (
      let end = path.lastIndexOf("/");
      end > 0;
      end = path.lastIndexOf("/", end - 1)
    ) {
      directories.add(path.slice(0, end));
    }
  }
  return directories;
};

/**
 * The kit's files and what TypeScript made of them, once per isolate:
 * parsing the kit's declarations is most of a check's work.
 */
let kitCache:
  | {
      files: Record<string, string>;
      directories: Set<string>;
      parsed: Map<string, ts.SourceFile>;
    }
  | undefined;

const kitOf = (files: Record<string, string>) => {
  if (kitCache?.files !== files) {
    kitCache = {
      files,
      directories: directoriesOf(Object.keys(files)),
      parsed: new Map(),
    };
  }
  return kitCache;
};

const severities: Partial<
  Record<ts.DiagnosticCategory, Diagnostic["severity"]>
> = {
  [ts.DiagnosticCategory.Error]: "error",
  [ts.DiagnosticCategory.Warning]: "warning",
};

const toDiagnostic = (diagnostic: ts.Diagnostic): Diagnostic | undefined => {
  const severity = severities[diagnostic.category];
  if (severity === undefined) {
    return undefined;
  }
  const result: Diagnostic = {
    rule: `TS${diagnostic.code}`,
    severity,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
  const { file, start } = diagnostic;
  if (file !== undefined) {
    result.file = file.fileName.slice(1);
    if (start !== undefined) {
      const { line, character } = file.getLineAndCharacterOfPosition(start);
      result.line = line + 1;
      result.column = character + 1;
    }
  }
  return result;
};

/**
 * Type-checks App files (paths relative to the App, e.g.
 * `screens/desk.tsx`) against the kit, and against the App's own
 * declaration files among them (e.g. its server's types).
 */
export const typeCheck = (
  appFiles: Record<string, string>,
  kitTypes: Record<string, string>
): Diagnostic[] => {
  const kit = kitOf(kitTypes);
  const app = new Map(
    Object.entries(appFiles).map(([path, source]) => [`/${path}`, source])
  );
  const appDirectories = directoriesOf(app.keys());
  const readFile = (path: string): string | undefined =>
    app.get(path) ?? kit.files[path];
  const parse = (
    path: string,
    languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions
  ): ts.SourceFile | undefined => {
    const source = readFile(path);
    return source === undefined
      ? undefined
      : ts.createSourceFile(path, source, languageVersion);
  };
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) => {
      if (app.has(path)) {
        return parse(path, languageVersion);
      }
      const parsed = kit.parsed.get(path) ?? parse(path, languageVersion);
      if (parsed !== undefined) {
        kit.parsed.set(path, parsed);
      }
      return parsed;
    },
    getDefaultLibFileName: (options) =>
      `${libLocation}/${ts.getDefaultLibFileName(options)}`,
    getDefaultLibLocation: () => libLocation,
    writeFile: () => {
      // Nothing is emitted.
    },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (path) => readFile(path) !== undefined,
    readFile,
    directoryExists: (path) => {
      const directory = path.replace(trailingSlashes, "") || "/";
      return kit.directories.has(directory) || appDirectories.has(directory);
    },
    getDirectories: () => [],
  };
  const program = ts.createProgram([...app.keys()], compilerOptions, host);
  const checked = program
    .getSourceFiles()
    .filter((file) => app.has(file.fileName));
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...checked.flatMap((file) => [
      ...program.getSyntacticDiagnostics(file),
      ...program.getSemanticDiagnostics(file),
    ]),
  ]
    .map((diagnostic) => toDiagnostic(diagnostic))
    .filter((diagnostic) => diagnostic !== undefined);
};
