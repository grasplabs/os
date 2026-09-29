import { setFlagsFromString } from "node:v8";

import ultracite from "ultracite/oxfmt";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import shadcn from "ultracite/oxlint/shadcn";
import tanstack from "ultracite/oxlint/tanstack";
import vitest from "ultracite/oxlint/vitest";
import { defineConfig } from "vite-plus";

// Node 24's V8 has a Sparkplug bug that segfaults the Vitest process
// mid-run (exit 139) in GC: BaselineOutOfLinePrologue pushes a stale
// register that the GC reads as a pointer
// (https://github.com/nodejs/node/issues/62393). `vp test` starts Vitest
// itself and NODE_OPTIONS rejects V8 flags, so switch the baseline tier off
// here, where Vitest loads its config. That covers `vp test` from the repo
// root, and only code compiled from here on: what Node compiled while
// starting stays baseline, so this makes the crash rare, not impossible.
// Drop this once the Node release in devEngines carries the backport
// (https://github.com/nodejs/node/pull/65753).
setFlagsFromString("--no-sparkplug");

const generated = [
  "**/routeTree.gen.ts",
  "**/worker-configuration.d.ts",
  "**/src/db/**/migrations/**",
  // Release fixtures and the golden manifest the release test writes.
  "scripts/release/testdata/**",
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
      // TanStack Router's `throw notFound()` is control flow, not an error.
      "typescript/only-throw-error": [
        "error",
        {
          allow: [
            {
              from: "package",
              package: "@tanstack/router-core",
              name: "NotFoundError",
            },
          ],
        },
      ],
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
    // The console's Cloudflare Vite plugin cannot load as a Vitest project;
    // its tests have a config of their own.
    projects: [
      "apps/*",
      "!apps/console",
      "apps/console/vite.test.config.ts",
      "apps/core/vite.screens.config.ts",
      "packages/*",
      "packages/connectors/*",
      // Repo tooling's pure logic, and core's build step, in Node.
      {
        test: {
          name: "scripts",
          include: [
            "scripts/**/*.test.ts",
            "apps/core/build-blueprints.test.ts",
          ],
          environment: "node",
        },
      },
    ],
    passWithNoTests: true,
  },
  staged: {
    "*": ["secretlint", "vp check --fix"],
    "*.{md,mdx}": "node scripts/check-docs.ts",
  },
});
