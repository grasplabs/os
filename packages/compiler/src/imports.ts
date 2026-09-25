import { appModuleName, kitModuleName } from "./kit.ts";
import type { Kit } from "./kit.ts";

/** An import in a source file, as written. */
export interface ImportSite {
  /** The module it names; undefined for an `import()` of a computed value. */
  specifier: string | undefined;
  line: number | undefined;
  /** The names it imports, or undefined for a default or namespace import. */
  names: string[] | undefined;
}

/** The parts of Babel's AST the import scan and rewrite read and write. */
interface Name {
  type: string;
  name?: string;
  value?: string;
}
interface Specifier {
  type: string;
  local: Name;
  imported?: Name;
  exported?: Name;
  importKind?: string | null;
  exportKind?: string | null;
}
interface StringLiteral {
  type: string;
  value: string;
}
interface Statement {
  type: string;
  loc?: { start: { line: number } } | null;
  source?: StringLiteral | null;
  specifiers?: Specifier[];
  importKind?: string | null;
  exportKind?: string | null;
}
interface Call {
  callee: { type: string };
  arguments: { type: string; value?: unknown }[];
  loc?: { start: { line: number } } | null;
}

const moduleStatements = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
]);

/** An import, or an export from another module (`export … from`). */
const isModuleStatement = (statement: Statement): boolean =>
  moduleStatements.has(statement.type) &&
  statement.source !== null &&
  statement.source !== undefined;

const isTypeSpecifier = (specifier: Specifier): boolean =>
  specifier.importKind === "type" || specifier.exportKind === "type";

/** The specifiers that bring in values; types are erased when compiling. */
const valueSpecifiers = (statement: Statement): Specifier[] =>
  (statement.specifiers ?? []).filter(
    (specifier) => !isTypeSpecifier(specifier)
  );

/** An `import type`, or an import whose every name is a type. */
const isTypeOnly = (statement: Statement): boolean =>
  statement.importKind === "type" ||
  statement.exportKind === "type" ||
  ((statement.specifiers ?? []).length > 0 &&
    valueSpecifiers(statement).length === 0);

const nameOf = (name: Name | undefined): string | undefined =>
  name?.name ?? name?.value;

/** The name a specifier takes from the other module. */
const importedName = (specifier: Specifier): string | undefined =>
  specifier.type === "ExportSpecifier"
    ? nameOf(specifier.local)
    : nameOf(specifier.imported);

const namedSpecifiers = new Set(["ImportSpecifier", "ExportSpecifier"]);

/**
 * The names a statement takes from the other module, or undefined when it
 * takes a default, a namespace or everything (`export *`).
 */
const namesOf = (statement: Statement): string[] | undefined => {
  if (statement.type === "ExportAllDeclaration") {
    return undefined;
  }
  const names = valueSpecifiers(statement).map((specifier) =>
    namedSpecifiers.has(specifier.type) ? importedName(specifier) : undefined
  );
  return names.every((name) => name !== undefined) ? names : undefined;
};

const isImportCall = (call: Call): boolean => call.callee.type === "Import";

const stringArgument = (call: Call): string | undefined => {
  const [first] = call.arguments;
  return first?.type === "StringLiteral" && typeof first.value === "string"
    ? first.value
    : undefined;
};

/**
 * A Babel plugin that lists a file's imports into `imports`, as written:
 * it reads the top-level statements before anything else runs. Type-only
 * imports are skipped; they are erased.
 */
export const collectImports = (imports: ImportSite[]) => () => ({
  visitor: {
    Program: (path: { node: { body: Statement[] } }) => {
      for (const statement of path.node.body) {
        if (isModuleStatement(statement) && !isTypeOnly(statement)) {
          imports.push({
            specifier: statement.source?.value,
            line: statement.loc?.start.line,
            names: namesOf(statement),
          });
        }
      }
    },
    CallExpression: (path: { node: Call }) => {
      if (isImportCall(path.node)) {
        imports.push({
          specifier: stringArgument(path.node),
          line: path.node.loc?.start.line,
          names: undefined,
        });
      }
    },
  },
});

/** How an import may name an App file: as written, or without its extension. */
const importSuffixes = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

/** The App file a relative import names, if there is one. */
export const resolveRelative = (
  importer: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined => {
  const parts = importer.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") {
      if (parts.pop() === undefined) {
        return undefined;
      }
    } else if (part !== ".") {
      parts.push(part);
    }
  }
  const path = parts.join("/");
  return importSuffixes
    .map((suffix) => `${path}${suffix}`)
    .find((candidate) => files.has(candidate));
};

/** The packages App code may import from, for error messages. */
const packagesOf = (kit: Kit): string =>
  [
    ...new Set(
      [...kit.imports, "lucide-react"].map((specifier) =>
        specifier
          .split("/")
          .slice(0, specifier.startsWith("@") ? 2 : 1)
          .join("/")
      )
    ),
  ].join(", ");

/** Why an import of lucide-react isn't allowed, or undefined when it is. */
const iconError = (
  names: string[] | undefined,
  kit: Kit
): string | undefined => {
  if (names === undefined) {
    return "import or export icons from lucide-react by name, e.g. { InboxIcon }.";
  }
  const unknown = names.filter((name) => kit.icons[name] === undefined);
  return unknown.length === 0
    ? undefined
    : `${unknown.map((name) => `"${name}"`).join(", ")} is not a lucide-react icon.`;
};

/** Why an import isn't allowed, or undefined when it is. */
export const importError = (
  { specifier, line, names }: ImportSite,
  file: string,
  files: ReadonlySet<string>,
  kit: Kit
): string | undefined => {
  const where = line === undefined ? file : `${file}:${line}`;
  if (specifier === undefined) {
    return `${where}: import() must name a module in quotes.`;
  }
  if (isRelative(specifier)) {
    return resolveRelative(file, specifier, files) === undefined
      ? `${where}: "${specifier}" is not a file in this App.`
      : undefined;
  }
  if (specifier === "lucide-react") {
    const error = iconError(names, kit);
    return error === undefined ? undefined : `${where}: ${error}`;
  }
  return kit.imports.includes(specifier)
    ? undefined
    : `${where}: "${specifier}" is outside the kit. Screens can import the App's own files and ${packagesOf(kit)}.`;
};

/**
 * One icon's import or re-export, from its own module: `import local from
 * "icon"`, or `export { default as exported } from "icon"`.
 */
const fromIconModule = (specifier: Specifier, module: string): Statement => {
  const source = { type: "StringLiteral", value: module };
  if (specifier.type === "ExportSpecifier") {
    return {
      type: "ExportNamedDeclaration",
      exportKind: "value",
      specifiers: [
        {
          type: "ExportSpecifier",
          local: { type: "Identifier", name: "default" },
          exported: specifier.exported ?? specifier.local,
        },
      ],
      source,
    };
  }
  return {
    type: "ImportDeclaration",
    importKind: "value",
    specifiers: [{ type: "ImportDefaultSpecifier", local: specifier.local }],
    source,
  };
};

/**
 * A Babel plugin that points a compiled module's imports at flat module
 * names: App files by path, kit modules by specifier, and each lucide-react
 * icon at its own module, so a page loads only the icons it uses. Runs on
 * compiled code, so it sees the imports the compiler and the JSX transform
 * added; the imports were checked before.
 */
export const rewriteImports =
  (file: string, files: ReadonlySet<string>, kit: Kit) => () => {
    const moduleFor = (specifier: string): string => {
      if (!isRelative(specifier)) {
        return kitModuleName(specifier);
      }
      const target = resolveRelative(file, specifier, files);
      if (target === undefined) {
        throw new Error(`${file}: "${specifier}" is not a file in this App.`);
      }
      return appModuleName(target);
    };
    // The check allowed only named icons, so every name has a module.
    const icons = (statement: Statement): Statement[] =>
      valueSpecifiers(statement).map((specifier) =>
        fromIconModule(
          specifier,
          kit.icons[importedName(specifier) ?? ""] ?? ""
        )
      );
    return {
      visitor: {
        Program: (path: {
          node: { body: Statement[] };
          scope: { crawl: () => void };
        }) => {
          path.node.body = path.node.body.flatMap((statement) => {
            const { source } = statement;
            if (!isModuleStatement(statement) || !source) {
              return [statement];
            }
            if (source.value === "lucide-react") {
              return icons(statement);
            }
            source.value = moduleFor(source.value);
            return [statement];
          });
          path.scope.crawl();
        },
        CallExpression: (path: { node: Call }) => {
          const [first] = path.node.arguments;
          if (isImportCall(path.node) && typeof first?.value === "string") {
            first.value = moduleFor(first.value);
          }
        },
      },
    };
  };
