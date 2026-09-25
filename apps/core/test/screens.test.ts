import { kitModules } from "@grasp-os/compiler";
import type { ScreenSource } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { buildScreens } from "../src/screens.ts";

/** A sample App: two screens on the kit, sharing one of its own components. */
const sampleApp: Record<string, string> = {
  "screens/desk.tsx": `import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@grasp-os/ui/components/card";
import { useState } from "react";

import { Greeting } from "../components/greeting";

export default function Desk() {
  const [count, setCount] = useState(0);
  return (
    <Card>
      <CardHeader>
        <CardTitle><Greeting name="desk" /></CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-2">
          <Button onClick={() => setCount(count + 1)}>Clicked {count}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
`,
  "screens/inbox.tsx": `import { Badge } from "@grasp-os/ui/components/badge";
import { Input } from "@grasp-os/ui/components/input";
import { type LucideProps, InboxIcon } from "lucide-react";

import { Greeting } from "../components/greeting";
import { Mail } from "../components/icons";

const iconProps: LucideProps = { "aria-hidden": true };

export default function Inbox() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Greeting name="inbox" />
      <Badge variant="secondary"><InboxIcon {...iconProps} /> 3 new</Badge>
      <Mail {...iconProps} />
      <Input placeholder="Search" />
    </main>
  );
}
`,
  "components/icons.ts": `export { MailIcon as Mail } from "lucide-react";
`,
  "components/greeting.tsx": `export function Greeting({ name }: { name: string }) {
  return <h1 className="text-lg font-semibold">Hello from {name}</h1>;
}
`,
};

const app = (
  files: Record<string, string>,
  version = crypto.randomUUID()
): ScreenSource => ({ app: "sample", version, files });

/**
 * Loads an App's modules and the kit's into a fresh isolate, as a page does
 * with an import map, and says what `imports` evaluate to there.
 */
const evaluate = async (
  appModules: Record<string, string>,
  imports: string[]
): Promise<unknown> => {
  const modules = Object.fromEntries(
    Object.entries({ ...kitModules().modules, ...appModules }).map(
      ([name, js]) => [name, { js }]
    )
  );
  const probe = `${imports.map((name, index) => `import * as m${index} from "${name}";`).join("\n")}
export default {
  fetch: () => Response.json({
${imports.map((name, index) => `    "${name}": Object.fromEntries(Object.entries(m${index}).map(([key, value]) => [key, typeof value])),`).join("\n")}
  }),
};`;
  const worker = env.LOADER.load({
    compatibilityDate: "2026-09-15",
    mainModule: "probe.js",
    modules: { ...modules, "probe.js": probe },
    globalOutbound: null,
  });
  const response = await worker.getEntrypoint().fetch("https://probe/");
  return await response.json();
};

/** A Worker Loader that fails the test if anything is built. */
const noBuilds: WorkerLoader = {
  get: () => {
    throw new Error("Built again");
  },
  load: () => {
    throw new Error("Built again");
  },
};

// Every build starts an isolate with the compiler in it.
describe("screen builds", { timeout: 60_000 }, () => {
  it("builds every screen into modules that run on the kit's", async () => {
    const built = await buildScreens(env, app(sampleApp));
    if (!built.ok) {
      throw new Error(JSON.stringify(built.diagnostics, null, 2));
    }
    expect(built.diagnostics).toStrictEqual([]);

    // Evaluating them links every import, the icon's too, without `require`.
    await expect(
      evaluate(built.modules, [
        "app~screens~desk.js",
        "app~screens~inbox.js",
        "react-dom~client.js",
      ])
    ).resolves.toMatchObject({
      "app~screens~desk.js": { default: "function" },
      "app~screens~inbox.js": { default: "function" },
      "react-dom~client.js": { createRoot: "function" },
    });
    // The App's own classes, the kit's classes (quotes and all, from the
    // button's icon sizing) and the kit's theme.
    expect(built.css).toContain(".grid-cols-3");
    expect(built.css).toContain("svg:not([class*='size-'])");
    expect(built.css).toContain("--primary:");
  });

  it("runs screens through the React Compiler", async () => {
    const built = await buildScreens(
      env,
      app({
        "screens/counter.tsx": `import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`,
      })
    );

    expect(built.ok && built.modules["app~screens~counter.js"]).toContain(
      '"react~compiler-runtime.js"'
    );
  });

  it("refuses imports from outside the kit, saying where", async () => {
    const built = await buildScreens(
      env,
      app({
        "screens/desk.tsx": `import leftPad from "left-pad";
import { Dialog } from "@base-ui/react/dialog";
import { Nope } from "@grasp-os/ui/components/nope";
import { secret } from "../../outside";
import { InboxIcon, NotAnIcon } from "lucide-react";
import * as icons from "lucide-react";
export * from "lucide-react";

const remote = import("https://example.com/remote.js");

export default function Desk() {
  return <p>{leftPad(Dialog, Nope, secret, remote, InboxIcon, NotAnIcon, icons)}</p>;
}
`,
      })
    );

    expect(built.ok).toBeFalsy();
    expect(
      built.diagnostics.map(
        ({ file, line, rule, message }) => `${file}:${line} ${rule}: ${message}`
      )
    ).toStrictEqual([
      expect.stringContaining(
        'screens/desk.tsx:1 imports: "left-pad" is outside the kit'
      ),
      expect.stringContaining(
        'screens/desk.tsx:2 imports: "@base-ui/react/dialog" is outside the kit'
      ),
      expect.stringContaining(
        'screens/desk.tsx:3 imports: "@grasp-os/ui/components/nope" is outside the kit'
      ),
      'screens/desk.tsx:4 imports: "../../outside" is not a file in this App.',
      'screens/desk.tsx:5 imports: "NotAnIcon" is not a lucide-react icon.',
      expect.stringContaining(
        "screens/desk.tsx:6 imports: import or export icons from lucide-react by name"
      ),
      expect.stringContaining(
        "screens/desk.tsx:7 imports: import or export icons from lucide-react by name"
      ),
      expect.stringContaining(
        'screens/desk.tsx:9 imports: "https://example.com/remote.js" is outside the kit'
      ),
    ]);
  });

  it("builds a version once and serves it from the cache after", async () => {
    const source = app(sampleApp);
    const built = await buildScreens(env, source);
    expect(built.ok).toBeTruthy();

    const cached = await buildScreens({ ...env, LOADER: noBuilds }, source);
    expect(cached).toStrictEqual(built);

    const next = buildScreens(
      { ...env, LOADER: noBuilds },
      { ...source, version: crypto.randomUUID() }
    );
    await expect(next).rejects.toThrow("Built again");
  });

  it("builds a version once when requests for it arrive together", async () => {
    let builds = 0;
    const counting: WorkerLoader = {
      get: (name, code) => {
        builds += 1;
        return env.LOADER.get(name, code);
      },
      load: (code) => env.LOADER.load(code),
    };
    const source = app(sampleApp);
    const [first, second] = await Promise.all([
      buildScreens({ ...env, LOADER: counting }, source),
      buildScreens({ ...env, LOADER: counting }, source),
    ]);

    expect(second).toStrictEqual(first);
    expect(builds).toBe(1);
  });
});
