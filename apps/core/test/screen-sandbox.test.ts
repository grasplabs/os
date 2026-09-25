import { isolateSettings } from "@grasp-os/compiler";
import type { Diagnostic, ScreenSource } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildScreens } from "../src/screens.ts";

const app = (files: Record<string, string>): ScreenSource => ({
  app: "sandbox",
  version: crypto.randomUUID(),
  files,
});

/** A screen with this code before its component. */
const screen = (code: string): Record<string, string> => ({
  "screens/desk.tsx": `${code}
export default function Desk() {
  return <p>desk</p>;
}
`,
});

/** Where a diagnostic is, what found it and what it says, on one line. */
const summary = ({ file, line, rule, message }: Diagnostic) =>
  `${file}:${line} ${rule}: ${message}`;

const summaries = async (files: Record<string, string>) => {
  const built = await buildScreens(env, app(files));
  expect(built.ok).toBeFalsy();
  return built.diagnostics.map((diagnostic) => summary(diagnostic));
};

// What App code may try, to reach beyond the kit or to wear the compiler out.
describe("screen sandbox", { timeout: 60_000 }, () => {
  it("refuses a JSX runtime from outside the kit", async () => {
    await expect(
      summaries(screen("/** @jsxImportSource evil */"))
    ).resolves.toStrictEqual([
      expect.stringContaining(
        'screens/desk.tsx:undefined imports: "evil/jsx-runtime" is outside the kit'
      ),
    ]);
    await expect(
      summaries(screen("/** @jsxImportSource https://evil.example */"))
    ).resolves.toStrictEqual([
      expect.stringContaining(
        '"https://evil.example/jsx-runtime" is outside the kit'
      ),
    ]);
  });

  it("refuses names every object has as icons", async () => {
    await expect(
      summaries(
        screen(
          'import { toString, constructor } from "lucide-react";\nvoid [toString, constructor];'
        )
      )
    ).resolves.toStrictEqual([
      'screens/desk.tsx:1 imports: "toString", "constructor" is not a lucide-react icon.',
    ]);
  });

  it("says import() belongs at the top of the file", async () => {
    await expect(
      summaries({
        "screens/desk.tsx": `import { useEffect } from "react";

export default function Desk() {
  useEffect(() => {
    void import("../components/late");
  }, []);
  return <p>desk</p>;
}
`,
        "components/late.ts": "export const late = true;\n",
      })
    ).resolves.toStrictEqual([
      "screens/desk.tsx:5 compile: import() can't be used inside a component or hook: import the module at the top of the file.",
    ]);
  });

  it("builds a file of one huge token quickly", async () => {
    const built = await buildScreens(
      env,
      app(screen(`export const noise = "${")".repeat(150_000)}x";`))
    );

    expect(built.ok).toBeTruthy();
  });

  it("refuses more files and characters than a build takes", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [
        `components/c${index}.ts`,
        "export {};\n",
      ])
    );
    await expect(summaries({ ...screen(""), ...many })).resolves.toStrictEqual([
      "undefined:undefined limits: The App has 202 screens, components and declarations; a build takes at most 200.",
    ]);

    const long = `// ${"x".repeat(200_001)}\n`;
    await expect(
      summaries({
        ...screen(""),
        "components/a.ts": long,
        "components/b.ts": "x".repeat(199_000),
        "components/c.ts": "x".repeat(199_000),
        "components/d.ts": "x".repeat(199_000),
        "components/e.ts": "x".repeat(199_000),
        "components/f.ts": "x".repeat(199_000),
      })
    ).resolves.toStrictEqual([
      expect.stringContaining(
        "components/a.ts:undefined limits: This file has 200005 characters; a file can have at most 200000."
      ),
      expect.stringContaining(
        "undefined:undefined limits: The App's files have 1195"
      ),
    ]);
  });

  it("gives the compiler's isolate no network", async () => {
    const probe = env.LOADER.load({
      ...isolateSettings,
      mainModule: "probe.js",
      modules: {
        "probe.js": `export default {
  async fetch() {
    try {
      await fetch("https://example.com/");
      return new Response("reached the network");
    } catch (error) {
      return new Response(String(error));
    }
  },
};`,
      },
    });
    const response = await probe.getEntrypoint().fetch("https://probe/");

    await expect(response.text()).resolves.not.toBe("reached the network");
  });
});
