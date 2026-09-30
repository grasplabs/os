import type { SavedBuild } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { commitFiles, versionFiles } from "../src/apps.ts";
import { buildOnSave } from "../src/save-builds.ts";
import { buildScreens, buildServer, buildWorkflows } from "../src/screens.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// Saving an App's files builds them at once, so the version opens without
// building, and whoever saved (an agent, most of all) hears what doesn't
// build in the same call. A build never fails the save, and one that
// can't finish is reported as such within a bound.

const idp = mockIdp();

/** A screen that says `text`, on the kit. */
const screen = (text: string): Record<string, string> => ({
  "screens/desk.tsx": `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return <Button>${text}</Button>;
}
`,
});

/** Server code that answers `text`. */
const server = (text: string): Record<string, string> => ({
  "app/server.ts": `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  hello(): string {
    return "${text}";
  }
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

/** Where each problem is, and how bad, as the agent's repair loop reads it. */
const where = (build: SavedBuild): string[] =>
  build.diagnostics.map(
    ({ file, line, rule, severity }) => `${file}:${line} ${rule} ${severity}`
  );

/** A new App of `builder`'s, without versions. */
const newApp = async (
  builder: Awaited<ReturnType<typeof signedInApi>>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Saved" });
  return id;
};

describe("building on save", { timeout: 60_000 }, () => {
  it("builds a saved version's screens, server code and workflows, so it opens without building", async () => {
    const builder = await signedInApi(idp, "builder");
    // Files no other test builds, so nothing is in the cache before.
    const unique = crypto.randomUUID();
    const app = await newApp(builder);

    const { version, builds } = await builder.api.apps.files.commit(
      app,
      {
        ...screen(unique),
        ...server(unique),
        ...workflowFiles("saved", `  return "${unique}";`),
      },
      "Save"
    );
    const files = await versionFiles(env, appIdSchema.parse(app), version);
    const unbuilt = { ...env, LOADER: noBuilds };

    expect(builds).toStrictEqual({
      screens: { status: "ok", diagnostics: [] },
      server: { status: "ok", diagnostics: [] },
      workflows: { status: "ok", diagnostics: [] },
    });
    // Opening, calling and running it load what the save built.
    await expect(buildScreens(unbuilt, files)).resolves.toMatchObject({
      ok: true,
    });
    await expect(buildServer(unbuilt, files)).resolves.toMatchObject({
      ok: true,
    });
    await expect(buildWorkflows(unbuilt, files)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("tells whoever saved what doesn't build and where, and commits all the same", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const broken = {
      "screens/desk.tsx": `export default function Desk() {
  const count: number = "three";
  return <p>{count}</p>;
}
`,
      "app/server.ts": `import { readFileSync } from "node:fs";
export class App {}
`,
    };

    const committed = await builder.api.apps.files.commit(
      app,
      broken,
      "Broken"
    );

    const { screens, server: serverBuild, workflows } = committed.builds;

    const [typeError] = screens.diagnostics;

    expect({
      screens: [screens.status, ...where(screens)],
      server: [serverBuild.status, ...where(serverBuild)],
      workflows: workflows.status,
      column: typeError?.column,
      message:
        typeError?.message.includes("not assignable to type 'number'") ?? false,
    }).toStrictEqual({
      screens: ["failed", "screens/desk.tsx:2 TS2322 error"],
      server: ["failed", "app/server.ts:1 imports error"],
      workflows: "none",
      column: 9,
      message: true,
    });
    await expect(
      builder.api.apps.versions.get(app, committed.version)
    ).resolves.toMatchObject({ version: committed.version });
  });

  it("says a build couldn't run when the compiler can't be reached, commits, and leaves it to its first use", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder);
    const by = await builder.api.whoami();
    const unreachable: WorkerLoader = {
      get: () => {
        throw new Error("The compiler is unreachable");
      },
      load: () => {
        throw new Error("The compiler is unreachable");
      },
    };

    const committed = await commitFiles(
      { ...env, LOADER: unreachable },
      by,
      app,
      screen(crypto.randomUUID()),
      "Save"
    );

    expect(committed).toMatchObject({
      version: 1,
      builds: {
        screens: {
          status: "error",
          diagnostics: [],
          error:
            "The build couldn't run now. It runs again when this is first used.",
        },
        server: { status: "none" },
        workflows: { status: "none" },
      },
    });
    const files = await versionFiles(env, appIdSchema.parse(app), 1);
    await expect(buildScreens(env, files)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("says a build that doesn't finish within its wait couldn't run, rather than wait on", async () => {
    const files = screen(crypto.randomUUID());
    const held = Promise.withResolvers<boolean>();
    // The build cache, which answers only once the test lets it: the
    // build waits on it before it starts.
    const holding = new Proxy(env.FILES, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "get" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            await held.promise;
            return Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const builds = await buildOnSave(
      { ...env, FILES: holding },
      { app: appIdSchema.parse(crypto.randomUUID()), version: 1, files },
      50
    );
    held.resolve(true);

    expect(builds).toStrictEqual({
      screens: {
        status: "error",
        diagnostics: [],
        error:
          "The build didn't finish in time. It runs again when this is first used.",
      },
      server: { status: "none", diagnostics: [] },
      workflows: { status: "none", diagnostics: [] },
    });
    // Its first use builds it.
    await expect(buildScreens(env, files)).resolves.toMatchObject({
      ok: true,
    });
  });
});
