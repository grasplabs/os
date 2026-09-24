import { cloudflare } from "@cloudflare/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
    // Fail the build on anything the React Compiler can't compile, instead
    // of silently shipping it uncompiled.
    babel({ presets: [reactCompilerPreset({ panicThreshold: "all_errors" })] }),
    tailwindcss(),
  ],
});
