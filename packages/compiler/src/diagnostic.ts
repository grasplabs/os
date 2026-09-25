/**
 * A problem the compiler found in an App's files, for whoever fixes them
 * (usually an agent). Errors fail the build; warnings don't.
 */
export interface Diagnostic {
  /** The App file, e.g. `screens/desk.tsx`; absent when it is about the App as a whole. */
  file?: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
  /**
   * What found it: a TypeScript error code (`TS2322`), a lint rule
   * (`shadcn/no-restyle`), or a compiler stage (`imports`, `compile`).
   */
  rule: string;
  severity: "error" | "warning";
  message: string;
  /** A change that would fix it, when the check suggests one. */
  fix?: string;
}

export const isError = (diagnostic: Diagnostic): boolean =>
  diagnostic.severity === "error";
