import type { SavedBuild } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { commitFiles, versionFiles } from "../src/apps.ts";
import { buildOnSave } from "../src/save-builds.ts";
import { buildScreens, buildServer, buildWorkflows } from "../src/screens.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// Saving an App's files builds them at once, so the version opens without
// building, and whoever saved (an agent, most of all) hears what doesn't
// build in the same call. A build never fails or holds up the save.

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
    ({ file, line, severity }) => `${file}:${line} ${severity}`
  );

/** A new App of `builder`'s with `files` in its working copy. */
const appWith = async (
  builder: Awaited<ReturnType<typeof signedInApi>>,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Saved" });
  await builder.api.apps.files.write(id, files);
  return id;
};

describe("building on save", { timeout: 60_000 }, () => {
  it("builds a saved version's screens, server code and workflows, so it opens without building", async () => {
    const builder = await signedInApi(idp, "builder");
    // Files no other test builds, so nothing is in the cache before.
    const unique = crypto.randomUUID();
    const app = await appWith(builder, {
      ...screen(unique),
      ...server(unique),
      ...workflowFiles("saved", `  return "${unique}";`),
    });

    const { version, builds } = await builder.api.apps.files.commit(
      app,
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
    const app = await appWith(builder, {
      "screens/desk.tsx": `export default function Desk() {
  const count: number = "three";
  return <p>{count}</p>;
}
`,
      "app/server.ts": `import { readFileSync } from "node:fs";
export class App {}
`,
    });

    const committed = await builder.api.apps.files.commit(app, "Broken");

    const { screens, server: serverBuild, workflows } = committed.builds;

    expect({
      screens: [screens.status, ...where(screens)],
      server: [serverBuild.status, ...where(serverBuild)],
      workflows: workflows.status,
      typeError:
        screens.diagnostics[0]?.message.includes(
          "not assignable to type 'number'"
        ) ?? false,
    }).toStrictEqual({
      screens: ["failed", "screens/desk.tsx:2 error"],
      server: ["failed", "app/server.ts:1 error"],
      workflows: "none",
      typeError: true,
    });
    await expect(
      builder.api.apps.versions.get(app, committed.version)
    ).resolves.toMatchObject({ version: committed.version });
  });

  it("commits when the compiler can't be reached, leaving the builds to their first use", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, screen(crypto.randomUUID()));
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
      "Save"
    );

    expect(committed).toMatchObject({
      version: 1,
      builds: {
        screens: { status: "pending", diagnostics: [] },
        server: { status: "none" },
        workflows: { status: "none" },
      },
    });
    const files = await versionFiles(env, appIdSchema.parse(app), 1);
    await expect(buildScreens(env, files)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("answers after at most its wait, and builds on in the background", async () => {
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

    const builds = await buildOnSave({ ...env, FILES: holding }, files, 50);
    held.resolve(true);

    expect(builds.screens).toStrictEqual({
      status: "pending",
      diagnostics: [],
    });
    await vi.waitFor(
      async () => {
        await expect(
          buildScreens({ ...env, LOADER: noBuilds }, files)
        ).resolves.toMatchObject({ ok: true });
      },
      { timeout: 10_000, interval: 100 }
    );
  });
});
