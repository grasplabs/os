import { appLimits } from "@grasp-os/shared/app-limits";
import { appErrors } from "@grasp-os/shared/apps";
import type { Role } from "@grasp-os/shared/roles";
import { roleErrors } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { auditedDuring, openRpc, signedInWithRole } from "./sign-in.ts";

// An App's code is versioned as a whole: builders write files to its
// working copy and commit them as the next version, which never changes
// afterwards. One version runs (current) and another can wait for review
// (pending). Every commit and every change of version is audited.

const idp = mockIdp();

/** A signed-in person's App API, on a connection of their own. */
const appsApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, apps: core.authenticate().apps };
};

type Apps = Awaited<ReturnType<typeof appsApi>>["apps"];

/** The code a promise was refused with, or "ok" if it wasn't. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return appErrors.codeOf(error) ?? roleErrors.codeOf(error) ?? String(error);
  }
};

const newApp = async (apps: Apps) =>
  await apps.create({ name: "Invoice desk", description: "Invoices@" });

/** Writes `files` and commits them. */
const commit = async (
  apps: Apps,
  app: string,
  files: Record<string, string | null>,
  message = "Change"
) => {
  await apps.files.write(app, files);
  return await apps.files.commit(app, message);
};

const first = {
  "app/server.ts": "export class App {}\n",
  "screens/inbox.tsx": "export default () => <p>Inbox</p>;\n",
  "AGENTS.md": "# Invoice desk — facturen, 請求書 🧾\n",
};

describe("App code", () => {
  it("reads back every version exactly as it was committed", async () => {
    const { apps, userId } = await appsApi("builder");
    const app = await newApp(apps);
    const v1 = await commit(apps, app.id, first, "First screen");
    const v2 = await commit(apps, app.id, {
      "screens/inbox.tsx": "export default () => <p>Invoices</p>;\n",
      "components/row.tsx": "export const Row = () => null;\n",
      "AGENTS.md": null,
    });

    expect({ v1, v2 }).toMatchObject({
      v1: { version: 1, parent: null, files: 3, author: userId },
      v2: { version: 2, parent: 1, files: 3, author: userId },
    });
    await expect(apps.files.read(app.id, 1)).resolves.toStrictEqual(first);
    await expect(apps.files.read(app.id, 2)).resolves.toStrictEqual({
      "app/server.ts": first["app/server.ts"],
      "screens/inbox.tsx": "export default () => <p>Invoices</p>;\n",
      "components/row.tsx": "export const Row = () => null;\n",
    });
    const [newestFirst, beforeTwo, one] = await Promise.all([
      apps.versions.list(app.id),
      apps.versions.list(app.id, 2),
      apps.versions.get(app.id, 1),
    ]);
    expect({
      newestFirst: newestFirst.map(({ version, message }) => [
        version,
        message,
      ]),
      beforeTwo,
      one,
    }).toStrictEqual({
      newestFirst: [
        [2, "Change"],
        [1, "First screen"],
      ],
      beforeTwo: [v1],
      one: v1,
    });
  });

  it("keeps writes in the working copy until they are committed", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);

    await apps.files.write(app.id, { "AGENTS.md": "# Draft\n" });
    await apps.files.write(app.id, { "app/server.ts": null });
    await expect(apps.files.read(app.id)).resolves.toStrictEqual({
      "screens/inbox.tsx": first["screens/inbox.tsx"],
      "AGENTS.md": "# Draft\n",
    });
    await expect(apps.files.read(app.id, 1)).resolves.toStrictEqual(first);

    await apps.files.commit(app.id, "Draft");
    await expect(apps.files.read(app.id)).resolves.toStrictEqual(
      await apps.files.read(app.id, 2)
    );
    await expect(outcome(apps.files.commit(app.id, "Again"))).resolves.toBe(
      "app.nothing_to_commit"
    );
    // Writing what is already there changes nothing either.
    await apps.files.write(app.id, { "AGENTS.md": "# Draft\n" });
    await expect(outcome(apps.files.commit(app.id, "Same"))).resolves.toBe(
      "app.nothing_to_commit"
    );
  });

  it("commits the working copy once when two commits race", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await apps.files.write(app.id, first);

    const results = await Promise.all([
      outcome(apps.files.commit(app.id, "One")),
      outcome(apps.files.commit(app.id, "Two")),
    ]);
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(
      results.every((result) =>
        ["ok", "app.conflict", "app.nothing_to_commit"].includes(result)
      )
    ).toBeTruthy();
    await expect(apps.versions.list(app.id)).resolves.toHaveLength(1);
    await expect(apps.files.read(app.id)).resolves.toStrictEqual(first);
  });

  it("loses no write made while a commit runs", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await apps.files.write(app.id, first);

    const edited = { ...first, "AGENTS.md": "# Edited meanwhile\n" };
    await Promise.all([
      apps.files.commit(app.id, "First"),
      apps.files.write(app.id, { "AGENTS.md": edited["AGENTS.md"] }),
    ]);
    // Committed with the first version or left in the working copy, the
    // write is in the working copy's files either way.
    await expect(apps.files.read(app.id)).resolves.toStrictEqual(edited);
  });

  it("diffs two versions by path", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    await commit(apps, app.id, {
      "screens/inbox.tsx": "export default () => null;\n",
      "screens/detail.tsx": "export default () => <p>Detail</p>;\n",
      "AGENTS.md": null,
    });

    await expect(apps.versions.diff(app.id, 1, 2)).resolves.toStrictEqual([
      { path: "AGENTS.md", change: "deleted", before: first["AGENTS.md"] },
      {
        path: "screens/detail.tsx",
        change: "added",
        after: "export default () => <p>Detail</p>;\n",
      },
      {
        path: "screens/inbox.tsx",
        change: "modified",
        before: first["screens/inbox.tsx"],
        after: "export default () => null;\n",
      },
    ]);
    await expect(apps.versions.diff(app.id, 2, 2)).resolves.toStrictEqual([]);
  });

  it("runs the version made current, after review, without changing any version's files", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    await apps.versions.setCurrent(app.id, 1);
    await commit(apps, app.id, { "AGENTS.md": "# Changed\n" });

    const proposed = await apps.versions.propose(app.id, 2);
    const approved = await apps.versions.setCurrent(app.id, 2);
    expect({ app, proposed, approved }).toMatchObject({
      app: { currentVersion: null, pendingVersion: null },
      proposed: { currentVersion: 1, pendingVersion: 2 },
      approved: { currentVersion: 2, pendingVersion: null },
    });
    await expect(apps.get(app.id)).resolves.toStrictEqual(approved);

    // Rolling back is making an earlier version current.
    const rolledBack = await apps.versions.setCurrent(app.id, 1);
    expect(rolledBack).toMatchObject({ currentVersion: 1 });
    await expect(
      Promise.all([apps.files.read(app.id, 1), apps.files.read(app.id, 2)])
    ).resolves.toStrictEqual([first, { ...first, "AGENTS.md": "# Changed\n" }]);
    await expect(
      Promise.all([
        outcome(apps.versions.setCurrent(app.id, 3)),
        outcome(apps.versions.propose(app.id, 0)),
      ])
    ).resolves.toStrictEqual([
      "app.version_not_found",
      "app.version_not_found",
    ]);
  });

  it("audits every commit and version change, by identifiers only", async () => {
    const { apps, userId } = await appsApi("admin");
    const actor = { type: "person", userId };
    let tree = "";
    const events = await auditedDuring(async () => {
      const app = await newApp(apps);
      await apps.files.write(app.id, first);
      ({ tree } = await apps.files.commit(
        app.id,
        "Secret plans in the message"
      ));
      await apps.versions.propose(app.id, 1);
      await apps.versions.setCurrent(app.id, 1);
      // Already current: nothing changes, nothing is recorded.
      await apps.versions.setCurrent(app.id, 1);
      await apps.versions.propose(app.id, 1);
    });

    const [created] = events;
    const target = { type: "app", id: created?.target?.id };
    expect(
      events.map(({ actor: by, action, target: on, detail }) => ({
        by,
        action,
        on,
        detail,
      }))
    ).toStrictEqual([
      {
        by: actor,
        action: "app.created",
        on: target,
        detail: { blueprint: null },
      },
      {
        by: actor,
        action: "app.committed",
        on: target,
        detail: {
          version: 1,
          parent: null,
          tree,
          files: 3,
        },
      },
      {
        by: actor,
        action: "app.version.proposed",
        on: target,
        detail: { version: 1 },
      },
      {
        by: actor,
        action: "app.version.current",
        on: target,
        detail: { version: 1, previous: null },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("Secret");
  });

  it("are for builders and admins only", async () => {
    const { apps: builder } = await appsApi("builder");
    const { apps: user } = await appsApi("user");
    const app = await newApp(builder);
    await commit(builder, app.id, first);

    const refused = await Promise.all([
      outcome(user.create({ name: "Mine" })),
      outcome(user.list()),
      outcome(user.get(app.id)),
      outcome(user.files.read(app.id, 1)),
      outcome(user.files.write(app.id, { "AGENTS.md": "# Mine\n" })),
      outcome(user.files.commit(app.id, "Mine")),
      outcome(user.versions.list(app.id)),
      outcome(user.versions.diff(app.id, 1, 1)),
      outcome(user.versions.propose(app.id, 1)),
      outcome(user.versions.setCurrent(app.id, 1)),
    ]);
    expect(new Set(refused)).toStrictEqual(new Set(["role.forbidden"]));
    await expect(builder.get(app.id)).resolves.toMatchObject({
      currentVersion: null,
    });
    await expect(builder.files.read(app.id)).resolves.toStrictEqual(first);
  });

  it("refuses paths outside the App and files over its limits", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    const paths = [
      "../server.ts",
      "screens/../../x.ts",
      "/etc/passwd",
      "screens//inbox.tsx",
      "screens\\inbox.tsx",
      "./AGENTS.md",
      ".env",
      "screens/",
      "__proto__",
      `${"a/".repeat(appLimits.pathDepth)}x.ts`,
    ];
    const refusedPaths = await Promise.all(
      paths.map(
        async (path) => await outcome(apps.files.write(app.id, { [path]: "x" }))
      )
    );
    expect(refusedPaths).toStrictEqual(paths.map(() => "app.invalid"));

    const tooLong = "x".repeat(appLimits.fileLength + 1);
    const nearlyFull = "x".repeat(appLimits.fileLength);
    const full = Object.fromEntries(
      Array.from(
        { length: appLimits.totalLength / appLimits.fileLength },
        (_, index) => [`components/part-${index}.ts`, nearlyFull]
      )
    );
    await apps.files.write(app.id, full);
    await expect(
      Promise.all([
        outcome(apps.files.write(app.id, { "AGENTS.md": tooLong })),
        outcome(apps.files.write(app.id, { "AGENTS.md": "x" })),
        outcome(apps.files.write(app.id, {})),
        outcome(apps.files.commit(app.id, " ")),
        outcome(apps.create({ name: "" })),
      ])
    ).resolves.toStrictEqual([
      "app.invalid",
      "app.too_large",
      "app.invalid",
      "app.invalid",
      "app.invalid",
    ]);
    // Deleting makes room.
    await apps.files.write(app.id, {
      "components/part-0.ts": null,
      "AGENTS.md": "x",
    });
    await expect(apps.files.commit(app.id, "Full")).resolves.toMatchObject({
      version: 1,
    });
  });

  it("keeps the working copy within its limits when two writes race", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    const largest = "x".repeat(appLimits.fileLength);
    const count = appLimits.totalLength / appLimits.fileLength;
    // Room for one more of the largest files, not two.
    await apps.files.write(
      app.id,
      Object.fromEntries(
        Array.from({ length: count - 1 }, (_, index) => [
          `components/part-${index}.ts`,
          largest,
        ])
      )
    );

    const results = await Promise.all(
      ["components/a.ts", "components/b.ts"].map(
        async (path) =>
          await outcome(apps.files.write(app.id, { [path]: largest }))
      )
    );
    expect(results.toSorted()).toStrictEqual(
      results.includes("app.conflict")
        ? ["app.conflict", "ok"]
        : ["app.too_large", "ok"]
    );
    await expect(apps.files.read(app.id)).resolves.toSatisfy(
      (files: Record<string, string>) => Object.keys(files).length === count
    );
  });

  it("lets an App over its limits shrink, but not grow or commit", async () => {
    const { apps, userId } = await appsApi("builder");
    const app = await newApp(apps);
    // More files than an App may have now: written when the limits were
    // higher, straight into its working copy.
    const count = appLimits.files + 2;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE apps SET working_revision = 'earlier' WHERE id = ?"
      ).bind(app.id),
      ...Array.from({ length: count }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO app_working_files (app_id, path, content, revision, written_by, written_at) VALUES (?, ?, 'x', 'earlier', ?, 0)"
        ).bind(app.id, `components/part-${index}.ts`, userId)
      ),
    ]);

    // One after another: each step depends on the one before.
    const steps: [string, () => Promise<unknown>][] = [
      [
        "add",
        async () => {
          await apps.files.write(app.id, { "components/new.ts": "x" });
        },
      ],
      [
        "grow",
        async () => {
          await apps.files.write(app.id, { "components/part-0.ts": "xx" });
        },
      ],
      [
        "shrink",
        async () => {
          await apps.files.write(app.id, { "components/part-0.ts": null });
        },
      ],
      // Still over them: it can't become a version until it's within them.
      ["commit over", async () => await apps.files.commit(app.id, "Smaller")],
      [
        "shrink again",
        async () => {
          await apps.files.write(app.id, { "components/part-1.ts": null });
        },
      ],
      ["commit within", async () => await apps.files.commit(app.id, "Fits")],
    ];
    const outcomes: [string, string][] = [];
    for (const [step, run] of steps) {
      // oxlint-disable-next-line no-await-in-loop -- steps are sequential by design
      outcomes.push([step, await outcome(run())]);
    }
    expect(outcomes).toStrictEqual([
      ["add", "app.too_large"],
      ["grow", "app.too_large"],
      ["shrink", "ok"],
      ["commit over", "app.too_large"],
      ["shrink again", "ok"],
      ["commit within", "ok"],
    ]);
  });

  it("refuses Apps and versions that don't exist", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await expect(
      Promise.all([
        outcome(apps.get("no-such-app")),
        outcome(apps.files.write("no-such-app", { "AGENTS.md": "x" })),
        outcome(apps.files.read(app.id, 1)),
        outcome(apps.versions.get(app.id, 1)),
        outcome(apps.versions.diff(app.id, 1, 2)),
      ])
    ).resolves.toStrictEqual([
      "app.not_found",
      "app.not_found",
      "app.version_not_found",
      "app.version_not_found",
      "app.version_not_found",
    ]);
  });
});
