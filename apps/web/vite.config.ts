import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    // Fail the build on anything the React Compiler can't compile, instead
    // of silently shipping it uncompiled.
    babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
    tailwindcss(),
  ],
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
