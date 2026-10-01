import { fileURLToPath } from "node:url";

import { getConfig } from "@lingui/conf";
import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// Lingui looks for its config from the working directory, which is the repo
// root when Vite+ runs this build, so both of its plugins get this app's.
const linguiConfigPath = fileURLToPath(
  new URL("lingui.config.ts", import.meta.url)
);
const linguiConfig = getConfig({ configPath: linguiConfigPath });

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    babel({
      // Lingui's macros turn the English in the code into catalog lookups
      // first (Babel runs plugins before presets), so the React Compiler
      // sees the code that runs.
      plugins: [["@lingui/babel-plugin-lingui-macro", { linguiConfig }]],
      // Fail the build on anything the React Compiler can't compile,
      // instead of silently shipping it uncompiled.
      presets: [reactCompilerPreset({ panicThreshold: "all_errors" })],
    }),
    // Compiles a `.po` catalog when the page imports it.
    lingui({ configPath: linguiConfigPath }),
    tailwindcss(),
  ],
  define: {
    // The build a page runs, in the error reports it sends: the commit CI
    // built it from, or `local`.
    "import.meta.env.VITE_GRASP_BUILD": JSON.stringify(
      process.env.GITHUB_SHA ?? "local"
    ),
  },
  build: {
    rolldownOptions: {
      output: {
        // Modules run in the order they're imported, whichever chunk holds
        // them: zod-jitless.ts has to run before any module builds a schema,
        // also when Zod lands in a chunk shared with a lazy route.
        strictExecutionOrder: true,
      },
    },
  },
  test: {
    setupFiles: ["./src/test-setup.ts"],
  },
  server: {
    // Core (wrangler dev) serves the API and Cap'n Web.
    proxy: {
      "/api": "http://localhost:8787",
      "/rpc": { target: "ws://localhost:8787", ws: true },
      // The document screens run in, with its own policy (core's screen-frame.ts).
      "/screen-frame": "http://localhost:8787",
    },
  },
});
