/**
 * Screen compiler. Runs in a Dynamic Worker per build: App .tsx goes through
 * the React Compiler, then @cloudflare/worker-bundler against the vendored kit,
 * with Tailwind per App and @shadcn/lint rules. Output is cached by commit.
 */
export interface BuildInput {
  /** App source files by path, e.g. "screens/desk.tsx". */
  files: Record<string, string>;
  commit: string;
}

export interface BuildOutput {
  client: string;
  css: string;
  server?: string;
  errors: string[];
}

export type Build = (input: BuildInput) => Promise<BuildOutput>;
