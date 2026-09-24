import ultracite from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import shadcn from "ultracite/oxlint/shadcn";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";

const generated = [
  "**/routeTree.gen.ts",
  "**/worker-configuration.d.ts",
  "**/src/db/**/migrations/**",
];

export default defineConfig({
  lint: {
    extends: [core, react, tanstack, vitest, shadcn],
    ignorePatterns: [...(core.ignorePatterns ?? []), ...generated],
    jsPlugins: [...(shadcn.jsPlugins ?? []), ...(antiSlop.jsPlugins ?? [])],
    options: {
      typeAware: true,
      typeCheck: true,
      // No warning tier: a rule is either an error or off.
      denyWarnings: true,
      // A disable comment that no longer suppresses anything must go.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Picked from Ultracite's anti-slop preset: the rules that stop agents
      // from silencing the type checker. The rest of that preset forces
      // workarounds (no options objects, no `unknown`).
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      // Test through real interfaces; mock only outside systems, at their
      // boundary. (anti-slop/no-module-mocking only knows `vitest` imports.)
      "no-restricted-properties": [
        "error",
        ...["mock", "doMock", "hoisted"].map((property) => ({
          object: "vi",
          property,
          message:
            "Don't mock modules. Pass the dependency through a real interface instead.",
        })),
      ],
    },
    settings: {
      shadcn: {
        ui: "@grasp-os/ui/components",
      },
    },
    overrides: [
      {
        // Schema files start as comment-only placeholders until their first table.
        files: ["apps/*/src/db/**/schema.ts"],
        rules: { "unicorn/no-empty-file": "off" },
      },
      {
        files: ["packages/ui/src/components/**"],
        rules: {
          "shadcn/no-arbitrary-values": "off",
          "shadcn/no-restyle": "off",
          "shadcn/require-static-classes": "off",
          // Components are added with the shadcn CLI; keep its code style.
          "func-style": "off",
          "react/function-component-definition": "off",
        },
      },
    ],
  },
  fmt: {
    ...ultracite,
    ignorePatterns: [...(ultracite.ignorePatterns ?? []), ...generated],
  },
  test: {
    // The console's Cloudflare Vite plugin cannot load as a Vitest project.
    projects: [
      "apps/*",
      "!apps/console",
      "packages/*",
      "packages/connectors/*",
    ],
    passWithNoTests: true,
  },
  staged: {
    "*": ["secretlint", "vp check --fix"],
    "*.{md,mdx}": "node scripts/check-docs.ts",
  },
});
