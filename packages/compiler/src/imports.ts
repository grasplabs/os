import { appModuleName, kitModuleName, ownEntry } from "./kit.ts";
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
  callee: { type: string; name?: string };
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

/** `import(x)` as Babel may also parse it: an `ImportExpression` node. */
interface ImportExpression {
  source: Call["arguments"][number];
  loc?: Call["loc"];
}

/**
 * An `ImportExpression` as the `import()` call the visitors read. Its
 * source is the same node, so rewriting the call's argument rewrites it.
 */
const asImportCall = ({ source, loc }: ImportExpression): Call => ({
  callee: { type: "Import" },
  arguments: [source],
  loc,
});

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
export const collectImports = (imports: ImportSite[]) => () => {
  const collect = (call: Call): void => {
    if (isImportCall(call)) {
      imports.push({
        specifier: stringArgument(call),
        line: call.loc?.start.line,
        names: undefined,
      });
    }
  };
  return {
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
        collect(path.node);
      },
      ImportExpression: (path: { node: ImportExpression }) => {
        collect(asImportCall(path.node));
      },
    },
  };
};

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
  const unknown = names.filter((name) => !Object.hasOwn(kit.icons, name));
  return unknown.length === 0
    ? undefined
    : `${unknown.map((name) => `"${name}"`).join(", ")} is not a lucide-react icon.`;
};

/** Why an import isn't allowed, or undefined when it is. */
export const importError = (
  { specifier, names }: ImportSite,
  file: string,
  files: ReadonlySet<string>,
  kit: Kit
): string | undefined => {
  if (specifier === undefined) {
    return "import() must name a module in quotes.";
  }
  if (isRelative(specifier)) {
    return resolveRelative(file, specifier, files) === undefined
      ? `"${specifier}" is not a file in this App.`
      : undefined;
  }
  if (specifier === "lucide-react") {
    return iconError(names, kit);
  }
  return kit.imports.includes(specifier)
    ? undefined
    : `"${specifier}" is outside the kit. Screens can import the App's own files and ${packagesOf(kit)}.`;
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

/** What the React Compiler's output imports, besides what App code may. */
const compilerRuntime = "react/compiler-runtime";

/**
 * A Babel plugin that points a compiled module's imports at flat module
 * names: App files by path, kit modules by specifier, and each lucide-react
 * icon at its own module, so a page loads only the icons it uses. It adds
 * the kit modules it points at to `kitImports`.
 *
 * It runs on compiled code, so it also sees the imports the compiler and
 * the JSX transform added, which the check of the source can't: a
 * `@jsxImportSource` comment, for one, makes JSX import from any package.
 * Anything that isn't the kit or the App's own files throws.
 */
export const rewriteImports =
  (
    file: string,
    files: ReadonlySet<string>,
    kit: Kit,
    kitImports: Set<string>
  ) =>
  () => {
    const allowed = new Set([...kit.imports, compilerRuntime]);
    const kitModule = (module: string | undefined): string => {
      if (module === undefined) {
        throw new Error("Not a lucide-react icon.");
      }
      kitImports.add(module);
      return module;
    };
    const moduleFor = (specifier: string): string => {
      if (!isRelative(specifier)) {
        if (!allowed.has(specifier)) {
          throw new Error(
            `"${specifier}" is outside the kit, and the compiled file imports it: remove what adds it, such as a @jsxImportSource comment.`
          );
        }
        return kitModule(kitModuleName(specifier));
      }
      const target = resolveRelative(file, specifier, files);
      if (target === undefined) {
        throw new Error(`"${specifier}" is not a file in this App.`);
      }
      return appModuleName(target);
    };
    const rewriteCall = (call: Call): void => {
      const [first] = call.arguments;
      if (isImportCall(call) && typeof first?.value === "string") {
        first.value = moduleFor(first.value);
      }
    };
    const icons = (statement: Statement): Statement[] =>
      valueSpecifiers(statement).map((specifier) =>
        fromIconModule(
          specifier,
          kitModule(ownEntry(kit.icons, importedName(specifier) ?? ""))
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
          rewriteCall(path.node);
        },
        ImportExpression: (path: { node: ImportExpression }) => {
          rewriteCall(asImportCall(path.node));
        },
      },
    };
  };

/**
 * App code that runs outside the screens: its server (`app/`) or its
 * workflows (`workflows/`). Each imports its own files and a few of the
 * platform's modules, by the flat name each is loaded under.
 */
export interface CodeKind {
  /** What the code is, for messages: "Server" or "Workflow". */
  name: string;
  folder: string;
  /** The modules it may import besides its own files, and their flat names. */
  imports: ReadonlyMap<string, string>;
}

/** Server code imports its own files and the Workers runtime. */
export const serverCode: CodeKind = {
  name: "Server",
  folder: "app/",
  imports: new Map([["cloudflare:workers", "cloudflare:workers"]]),
};

/**
 * The SDK modules workflow code may import: the workflow SDK and its test
 * harness, never the engine and never the Workers runtime.
 */
export const sdkImports = [
  "@grasp-os/sdk/workflow",
  "@grasp-os/sdk/testing",
] as const;

/** Workflow code imports its own files and the SDK (`sdkImports`). */
export const workflowCode: CodeKind = {
  name: "Workflow",
  folder: "workflows/",
  imports: new Map(
    sdkImports.map((specifier) => [specifier, kitModuleName(specifier)])
  ),
};

const javascriptExtension = /\.js$/u;

/**
 * The file a relative import names: as `resolveRelative` finds it, or
 * written with `.js` for the `.ts` file, as TypeScript's own ES module
 * output wants it.
 */
const resolveCodeFile = (
  importer: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined =>
  resolveRelative(importer, specifier, files) ??
  (specifier.endsWith(".js")
    ? resolveRelative(
        importer,
        specifier.replace(javascriptExtension, ".ts"),
        files
      )
    : undefined);

/** Why an import in `kind` code isn't allowed, or undefined when it is. */
export const codeImportError = (
  kind: CodeKind,
  specifier: string | undefined,
  file: string,
  files: ReadonlySet<string>
): string | undefined => {
  if (specifier === undefined) {
    return "import() must name a module in quotes.";
  }
  if (isRelative(specifier)) {
    return resolveCodeFile(file, specifier, files) === undefined
      ? `"${specifier}" is not a file of the App's ${kind.name.toLowerCase()} (${kind.folder}).`
      : undefined;
  }
  return kind.imports.has(specifier)
    ? undefined
    : `"${specifier}" can't be imported here. ${kind.name} code can import its own files in ${kind.folder} and ${[...kind.imports.keys()].join(", ")}.`;
};

const isRequireCall = ({ callee }: Call): boolean =>
  callee.type === "Identifier" && callee.name === "require";

/**
 * A Babel plugin that points a module's imports at the flat names of the
 * App's files and the platform's modules. Like `rewriteImports`, it runs
 * on compiled code, so it also sees imports the source check can't, and
 * throws on anything `kind` can't import, `require()` included.
 */
export const rewriteCodeImports =
  (kind: CodeKind, file: string, files: ReadonlySet<string>) => () => {
    const moduleFor = (specifier: string | undefined): string => {
      const error = codeImportError(kind, specifier, file, files);
      if (error !== undefined || specifier === undefined) {
        throw new Error(error);
      }
      const target = isRelative(specifier)
        ? resolveCodeFile(file, specifier, files)
        : undefined;
      return target === undefined
        ? (kind.imports.get(specifier) ?? specifier)
        : appModuleName(target);
    };
    const rewriteCall = (call: Call): void => {
      if (isImportCall(call)) {
        const module = moduleFor(stringArgument(call));
        const [first] = call.arguments;
        if (first) {
          first.value = module;
        }
      }
    };
    return {
      visitor: {
        Program: (path: { node: { body: Statement[] } }) => {
          for (const statement of path.node.body) {
            if (isModuleStatement(statement) && statement.source) {
              statement.source.value = moduleFor(statement.source.value);
            }
          }
        },
        CallExpression: (path: { node: Call }) => {
          if (isRequireCall(path.node)) {
            throw new Error(
              `require() isn't available in ${kind.name.toLowerCase()} code: use import.`
            );
          }
          rewriteCall(path.node);
        },
        ImportExpression: (path: { node: ImportExpression }) => {
          rewriteCall(asImportCall(path.node));
        },
      },
    };
  };
