// Vite's `import.meta.glob`, for the tests only (skills.test.ts lists the
// skill folders with it). Only `glob`, not Vite's client types: wrangler's
// esbuild supports neither `glob` nor `env`, so Worker code must not use
// them. Core has one tsconfig, so this is visible to src too; nothing
// there calls it.
interface ImportMeta {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}
