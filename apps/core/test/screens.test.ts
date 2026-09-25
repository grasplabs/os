import { kitModules } from "@grasp-os/compiler";
import type { ScreenSource } from "@grasp-os/compiler";
import { compatibilityDate } from "@grasp-os/shared/runtime";
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

/** These of the kit's modules, by flat name. */
const kitModulesNamed = async (
  names: string[]
): Promise<Record<string, string>> => {
  const { modules } = await kitModules(env.ASSETS);
  return Object.fromEntries(names.map((name) => [name, modules[name] ?? ""]));
};

/**
 * Loads modules into a fresh isolate, as a page does with an import map,
 * and says what `imports` evaluate to there.
 */
const evaluate = async (
  code: Record<string, string>,
  imports: string[]
): Promise<unknown> => {
  const modules = Object.fromEntries(
    Object.entries(code).map(([name, js]) => [name, { js }])
  );
  const probe = `${imports.map((name, index) => `import * as m${index} from "${name}";`).join("\n")}
export default {
  fetch: () => Response.json({
${imports.map((name, index) => `    "${name}": Object.fromEntries(Object.entries(m${index}).map(([key, value]) => [key, typeof value])),`).join("\n")}
  }),
};`;
  const worker = env.LOADER.load({
    compatibilityDate,
    mainModule: "probe.js",
    modules: { ...modules, "probe.js": probe },
    globalOutbound: null,
  });
  const response = await worker.getEntrypoint().fetch("https://probe/");
  return await response.json();
};

/** A screen that says `text`. */
const screen = (text: string): Record<string, string> => ({
  "screens/desk.tsx": `export default function Desk() {
  return <p>${text}</p>;
}
`,
});

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

    // Evaluating them with only the kit modules the build names links
    // every import, the icons' too, without `require`.
    await expect(
      evaluate(
        {
          ...(await kitModulesNamed(built.kitModules)),
          ...built.modules,
        },
        ["app~screens~desk.js", "app~screens~inbox.js"]
      )
    ).resolves.toMatchObject({
      "app~screens~desk.js": { default: "function" },
      "app~screens~inbox.js": { default: "function" },
    });
    // The App's own classes, the kit's classes (quotes and all, from the
    // button's icon sizing) and the kit's theme.
    expect(built.css).toContain(".grid-cols-3");
    expect(built.css).toContain("svg:not([class*='size-'])");
    expect(built.css).toContain("--primary:");
  });

  it("names only the kit modules the App needs", async () => {
    const built = await buildScreens(env, app(sampleApp));

    expect(built.ok && built.kitModules).toContain(
      "lucide-react~icons~inbox.js"
    );
    expect(built.ok && built.kitModules).not.toContain(
      "lucide-react~icons~house.js"
    );
  });

  it("has React DOM in the kit, for the page that renders screens", async () => {
    const { modules } = await kitModules(env.ASSETS);

    await expect(
      evaluate(modules, ["react-dom~client.js"])
    ).resolves.toMatchObject({
      "react-dom~client.js": { createRoot: "function" },
    });
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

  it("builds the same files once and serves them from the cache after", async () => {
    const source = app(sampleApp);
    const built = await buildScreens(env, source);
    expect(built.ok).toBeTruthy();

    const cached = await buildScreens({ ...env, LOADER: noBuilds }, source);
    expect(cached).toStrictEqual(built);

    // Another version, or other files under the same version, build again.
    await expect(
      buildScreens(
        { ...env, LOADER: noBuilds },
        { ...source, version: crypto.randomUUID() }
      )
    ).rejects.toThrow("Built again");
    await expect(
      buildScreens(
        { ...env, LOADER: noBuilds },
        {
          ...source,
          files: { ...source.files, "components/extra.ts": "export {};\n" },
        }
      )
    ).rejects.toThrow("Built again");
  });

  it("builds other files under the same version on their own", async () => {
    const version = crypto.randomUUID();
    const first = await buildScreens(env, app(screen("first"), version));
    const second = await buildScreens(env, app(screen("second"), version));

    expect(first.ok && first.modules["app~screens~desk.js"]).toContain("first");
    expect(second.ok && second.modules["app~screens~desk.js"]).toContain(
      "second"
    );
  });
});
