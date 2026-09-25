/**
 * Lints App files with @shadcn/lint's rules, as the repo lints its own
 * code, through ESLint's `Linter` (which needs no file system of its own)
 * and the typescript-eslint parser, on the type check's TypeScript 6.
 *
 * The rules read the project from disk: `components.json`, the theme and
 * the kit's component sources, for their variants. Each lint writes them
 * (`Kit.lintProject`) and the App's files to `/tmp`, which in a Worker
 * belongs to the request: concurrent lints don't see each other's files.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { plugin as shadcn } from "@shadcn/lint";
import * as parser from "@typescript-eslint/parser";
import { Linter } from "eslint/universal";

import type { Diagnostic } from "./diagnostic.ts";
import type { Kit } from "./kit.ts";

const root = "/tmp/app";

/** Added to every message: an App uses the kit as it is. */
const note =
  "Screens can't change the kit (@grasp-os/ui): use what it has, or build the look from plain elements.";

/**
 * ESLint validates rule options against their JSON schema with code it
 * generates at runtime, which Workers forbid. The options are the repo's
 * own and fixed, so the rules go in without a schema.
 */
const rules = Object.fromEntries(
  Object.entries(shadcn.rules).map(([name, rule]) => [
    name,
    { ...rule, meta: { ...rule.meta, schema: false as const } },
  ])
);

const writeFiles = (files: Record<string, string>): void => {
  for (const [path, content] of Object.entries(files)) {
    const file = `${root}/${path}`;
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, content);
  }
};

const toDiagnostic = (
  file: string,
  message: Linter.LintMessage
): Diagnostic => {
  const diagnostic: Diagnostic = {
    file,
    line: message.line,
    column: message.column,
    rule: message.ruleId ?? "lint",
    severity: message.severity === 2 ? "error" : "warning",
    message: message.message,
  };
  const [suggestion] = message.suggestions ?? [];
  if (suggestion !== undefined) {
    diagnostic.fix = suggestion.desc;
  }
  return diagnostic;
};

/** Lints App files (by path relative to the App) against the kit. */
export const lint = (
  appFiles: Record<string, string>,
  kit: Kit
): Diagnostic[] => {
  writeFiles({ ...kit.lintProject, ...appFiles });
  const linter = new Linter({ cwd: root });
  const config: Linter.Config[] = [
    {
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: {
        parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { shadcn: { ...shadcn, rules } },
      settings: { shadcn: { note } },
      rules: kit.lintRules,
    },
  ];
  return Object.entries(appFiles)
    .filter(([path]) => !path.endsWith(".d.ts"))
    .flatMap(([path, source]) =>
      linter
        .verify(source, config, `${root}/${path}`)
        .map((message) => toDiagnostic(path, message))
    );
};
