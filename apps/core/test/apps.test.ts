import { appLimits } from "@grasp-os/shared/app-limits";
import { appErrors } from "@grasp-os/shared/apps";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { commitFiles } from "../src/apps.ts";
import { racingDb } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi } from "./sign-in.ts";

// An App's code is versioned as a whole: builders commit changes over its
// latest version as the next version, which never changes afterwards. One
// version runs (current) and another can wait for review (pending). Every
// commit and every change of version is audited.

const idp = mockIdp();

/** A signed-in person's App API, on a connection of their own. */
const appsApi = async (role: Role) => {
  const person = await signedInApi(idp, role);
  return { ...person, apps: person.api.apps };
};

type Apps = Awaited<ReturnType<typeof appsApi>>["apps"];

const refusalSchema = z.object({
  details: z.object({ issues: z.array(z.string()) }),
});

/** The issues an `app.invalid` gives, joined, or "ok" if it wasn't refused. */
const issuesOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    const refusal = refusalSchema.safeParse(error);
    return refusal.success
      ? refusal.data.details.issues.join("; ")
      : (appErrors.codeOf(error) ?? String(error));
  }
};

const newApp = async (apps: Apps) =>
  await apps.create({ name: "Invoice desk", description: "Invoices@" });

/** Commits `files` over the App's latest version. */
const commit = async (
  apps: Apps,
  app: string,
  files: Record<string, string | null>,
  message = "Change"
) => await apps.files.commit(app, files, message);

/**
 * Gives an App without versions a first one holding `files` exactly,
 * unchecked: committed before a check existed or a limit was lowered.
 */
const storedUnchecked = async (
  app: string,
  author: string,
  files: Record<string, string>
): Promise<void> => {
  const json = canonicalJson(files);
  const tree = await sha256Hex(json);
  await env.FILES.put(`apps/${app}/trees/${tree}.json`, json);
  await env.DB.prepare(
    "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at) VALUES (?, 1, ?, ?, ?, 'Earlier', 0)"
  )
    .bind(app, tree, Object.keys(files).length, author)
    .run();
};

const first = {
  "app/server.ts": "export class App {}\n",
  "screens/inbox.tsx": "export default () => <p>Inbox</p>;\n",
  "AGENTS.md": "# Invoice desk — facturen, 請求書 🧾\n",
};

/** Exports, as an App declares them in `app/exports.json`. */
const exported = {
  findInvoices: {
    access: "read",
    input: {
      type: "object",
      properties: { customer: { type: "string" } },
      required: ["customer"],
    },
    output: { type: "array", items: { type: "string" } },
  },
  payInvoice: {
    access: "write",
    description: "Marks an invoice paid",
    input: { type: "string" },
    output: { type: "boolean" },
  },
} as const;

// Making a version with workflows current compiles them and runs their
// tests, as "names the screens and workflows" does. That takes half a
// second locally, and several times that on a loaded runner, closer to
// the default five seconds than the rest of this file. Nothing polls or
// sleeps; sixty seconds is room for a slow runner, as the other tests
// that release Apps give theirs.
describe("App code", { timeout: 60_000 }, () => {
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
    // A version reads back as committed; the commit's answer adds how its
    // builds went (build-on-save.test.ts).
    const { builds: _builds, ...committedV1 } = v1;
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
      beforeTwo: [committedV1],
      one: committedV1,
    });
  });

  it("reads the latest version without a version, and refuses a commit that changes nothing", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    const none = await apps.files.read(app.id);
    await commit(apps, app.id, first);
    const afterFirst = await apps.files.read(app.id);
    await commit(apps, app.id, {
      "AGENTS.md": "# Second\n",
      "app/server.ts": null,
    });

    expect({
      none,
      afterFirst,
      latest: await apps.files.read(app.id),
      one: await apps.files.read(app.id, 1),
    }).toStrictEqual({
      none: {},
      afterFirst: first,
      latest: {
        "screens/inbox.tsx": first["screens/inbox.tsx"],
        "AGENTS.md": "# Second\n",
      },
      one: first,
    });
    // What is already there, and deleting what isn't, change nothing.
    await expect(
      Promise.all([
        outcome(commit(apps, app.id, { "AGENTS.md": "# Second\n" })),
        outcome(commit(apps, app.id, { "app/server.ts": null })),
      ])
    ).resolves.toStrictEqual([
      "app.nothing_to_commit",
      "app.nothing_to_commit",
    ]);
    await expect(apps.versions.list(app.id)).resolves.toHaveLength(2);
  });

  it("fails loudly when a version's files are missing or damaged", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    const version = await commit(apps, app.id, first);
    const key = `apps/${app.id}/trees/${version.tree}.json`;
    const object = await env.FILES.get(key);
    const stored = (await object?.text()) ?? "";

    await env.FILES.put(key, stored.replace("Inbox", "Outbox"));
    const damaged = await outcome(apps.files.read(app.id, 1));
    await env.FILES.delete(key);
    const missing = await outcome(apps.files.read(app.id, 1));
    expect({ damaged, missing }).toStrictEqual({
      damaged: "internal.unexpected",
      missing: "internal.unexpected",
    });
  });

  it("refuses paths that can't both exist: a file and its folder, or names differing only in case", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, { "components/card.tsx": "x" });
    const refusals: Record<string, string | null>[] = [
      { components: "x" },
      { "components/card.tsx/x.ts": "x" },
      { "Components/Card.tsx": "x" },
      { "Components/list.tsx": "x" },
      { "a/b.ts": "x", a: "x" },
    ];
    const outcomes: string[] = [];
    // One after another, so each is refused for its paths alone.
    for (const changes of refusals) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      outcomes.push(await issuesOf(commit(apps, app.id, changes)));
    }
    // Replacing the file with a folder of its name, in one commit, is fine.
    outcomes.push(
      await issuesOf(
        commit(apps, app.id, {
          "components/card.tsx": null,
          "components/card.tsx/index.ts": "x",
        })
      )
    );
    expect(outcomes).toStrictEqual([
      "components: A file and a folder of the same name, with components/card.tsx",
      "components/card.tsx/x.ts: A file and a folder of the same name, with components/card.tsx",
      "Components/Card.tsx: Differs only in case from components/card.tsx",
      "Components/list.tsx: Differs only in case from components/card.tsx",
      "a/b.ts: A file and a folder of the same name, with a",
      "ok",
    ]);
  });

  it("still takes other commits to an App whose paths already collide", async () => {
    const { apps, userId } = await appsApi("builder");
    const app = await newApp(apps);
    await storedUnchecked(app.id, userId, { "lib/a.ts": "x", "Lib/b.ts": "x" });
    const outcomes: string[] = [];
    const changes: Record<string, string>[] = [
      { "other.ts": "x" },
      { "lib/a.ts": "y" },
      { "LIB/c.ts": "x" },
    ];
    for (const changed of changes) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      outcomes.push(await issuesOf(commit(apps, app.id, changed)));
    }
    expect(outcomes).toStrictEqual([
      "ok",
      "ok",
      "LIB/c.ts: Differs only in case from Lib/b.ts",
    ]);
  });

  it("keeps one of two commits over the same version, and refuses the other whole", async () => {
    const { api, apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    const theirs = { "AGENTS.md": "# Theirs\n" };
    // Someone else commits after this commit read the latest version, and
    // before its batch lands.
    const racing: Env = {
      ...env,
      DB: racingDb(
        async () => await commit(apps, app.id, theirs, "Theirs"),
        /^insert into "app_versions"/iu
      ),
    };

    await expect(
      outcome(
        commitFiles(
          racing,
          await api.whoami(),
          app.id,
          { "AGENTS.md": "# Mine\n", "screens/mine.tsx": "x" },
          "Mine"
        )
      )
    ).resolves.toBe("app.conflict");
    const versions = await apps.versions.list(app.id);
    expect(
      versions.map(({ version, message }) => [version, message])
    ).toStrictEqual([
      [2, "Theirs"],
      [1, "Change"],
    ]);
    await expect(apps.files.read(app.id)).resolves.toStrictEqual({
      ...first,
      ...theirs,
    });
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

  it("names the screens, workflows and exports of the version that runs, and only those", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await commit(apps, app.id, first);
    const none = await apps.contents(app.id);
    await apps.versions.setCurrent(app.id, 1);
    await commit(apps, app.id, {
      "screens/archive.tsx": "export default () => null;\n",
      "app/exports.json": JSON.stringify(exported),
      // Neither is a screen or a workflow: code they share.
      "screens/parts/row.tsx": "export const Row = () => null;\n",
      "workflows/lib/dates.ts": "export const today = () => 0;\n",
      "workflows/report.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "report",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`,
      "workflows/report.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import report from "./report.ts";

export default workflowTests(report, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`,
    });
    // Committed, not yet current: what runs is still version 1.
    const beforeCurrent = await apps.contents(app.id);
    const exportsBefore = await apps.exports(app.id);
    await apps.versions.setCurrent(app.id, 2);

    expect({
      none,
      beforeCurrent,
      current: await apps.contents(app.id),
      exportsBefore,
      exports: await apps.exports(app.id),
    }).toStrictEqual({
      none: { version: null, screens: [], workflows: [] },
      beforeCurrent: { version: 1, screens: ["inbox"], workflows: [] },
      current: {
        version: 2,
        screens: ["archive", "inbox"],
        workflows: ["report"],
      },
      exportsBefore: { version: 1, exports: {} },
      // As declared, with the description a declaration leaves out.
      exports: {
        version: 2,
        exports: {
          findInvoices: { ...exported.findInvoices, description: "" },
          payInvoice: exported.payInvoice,
        },
      },
    });
    await expect(
      Promise.all([
        outcome(apps.contents("no-such-app")),
        outcome(apps.exports("no-such-app")),
      ])
    ).resolves.toStrictEqual(["app.not_found", "app.not_found"]);
  });

  it("refuses to commit exports that aren't valid, saying why", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    const committing = async (text: string): Promise<string> =>
      await outcome(
        commit(apps, app.id, { "app/exports.json": text }, "Exports")
      );
    const valid = exported.findInvoices;
    const refused: string[] = [];
    for (const text of [
      "not json",
      JSON.stringify({ find_invoices: valid }),
      JSON.stringify({ toString: valid }),
      // What a permission's actions mean as all exports so marked.
      JSON.stringify({ read: valid }),
      JSON.stringify({ write: valid }),
      JSON.stringify({ toJSON: valid }),
      // A regular expression of the exporting App's, run by core on what
      // another App sends: one written to backtrack takes seconds.
      JSON.stringify({
        findInvoices: {
          ...valid,
          input: { type: "string", pattern: "^(a+)+$" },
        },
      }),
      JSON.stringify({
        findInvoices: {
          ...valid,
          input: {
            type: "object",
            patternProperties: { "^(a+)+$": { type: "string" } },
          },
        },
      }),
      JSON.stringify({
        findInvoices: { ...valid, input: { type: "string", format: "email" } },
      }),
      // Keywords core doesn't check: a bound nobody enforces.
      JSON.stringify({
        findInvoices: { ...valid, output: { type: "array", minItems: 1 } },
      }),
      JSON.stringify({
        findInvoices: {
          ...valid,
          input: { type: "string", contentMediaType: "application/json" },
        },
      }),
      JSON.stringify({
        findInvoices: { ...valid, input: { allOf: [{ type: "string" }] } },
      }),
      // Types every object has by inheritance are no types either.
      JSON.stringify({
        findInvoices: { ...valid, input: { type: "constructor" } },
      }),
      JSON.stringify({
        findInvoices: { ...valid, output: { type: "__proto__" } },
      }),
      JSON.stringify({
        findInvoices: { ...valid, input: { minLength: 1 } },
      }),
      JSON.stringify({
        findInvoices: {
          ...valid,
          input: {
            type: "object",
            properties: { customer: { type: "string", pattern: "^a" } },
          },
        },
      }),
      JSON.stringify({ findInvoices: { ...valid, access: "admin" } }),
      JSON.stringify({ findInvoices: { ...valid, input: { type: 7 } } }),
      JSON.stringify({ findInvoices: { ...valid, extra: true } }),
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`find${index}`, valid])
        )
      ),
      JSON.stringify({
        findInvoices: { ...valid, description: "x".repeat(64_000) },
      }),
    ]) {
      // One at a time: each is refused for its own exports alone.
      // oxlint-disable-next-line no-await-in-loop -- see above
      refused.push(await committing(text));
    }
    expect(refused).toStrictEqual(refused.map(() => "app.exports_invalid"));
    await expect(apps.versions.list(app.id)).resolves.toStrictEqual([]);
    // Refused with what's wrong, never failing on the way.
    await expect(
      commit(apps, app.id, {
        "app/exports.json": JSON.stringify({
          findInvoices: { ...valid, input: { type: "constructor" } },
        }),
      })
    ).rejects.toMatchObject({
      code: "app.exports_invalid",
      details: {
        issues: [expect.stringContaining("findInvoices.input")],
      },
    });
    // And valid exports commit, with every keyword core checks.
    await expect(
      committing(
        JSON.stringify({
          findInvoices: valid,
          countInvoices: {
            access: "read",
            input: {
              type: "object",
              title: "Filter",
              properties: {
                status: { enum: ["open", "paid"] },
                year: {
                  type: "integer",
                  minimum: 2000,
                  exclusiveMaximum: 3000,
                },
                amount: { type: "number", multipleOf: 0.01, maximum: 1e9 },
                note: { type: "string", minLength: 1, maxLength: 200 },
                tags: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 5,
                },
                owner: { anyOf: [{ type: "string" }, { type: "null" }] },
                kind: { const: "invoice" },
              },
              required: ["status"],
              additionalProperties: false,
            },
            output: { oneOf: [{ type: "integer" }, { type: "boolean" }] },
          },
        })
      )
    ).resolves.toBe("ok");
  });

  it("audits every commit and version change, by identifiers only", async () => {
    const { apps, userId } = await appsApi("admin");
    const actor = { type: "person", userId };
    let tree = "";
    const recorded = await auditedDuring(async () => {
      const app = await newApp(apps);
      ({ tree } = await apps.files.commit(
        app.id,
        first,
        "Secret plans in the message"
      ));
      await apps.versions.propose(app.id, 1);
      await apps.versions.setCurrent(app.id, 1);
      // Already current: nothing changes, nothing is recorded.
      await apps.versions.setCurrent(app.id, 1);
      await apps.versions.propose(app.id, 1);
    });
    // The App's own events; indexing it into the Apps collection records
    // its entry's (apps-collection.test.ts).
    const events = recorded.filter(({ target: on }) => on?.type === "app");
    expect(JSON.stringify(recorded)).not.toContain("Secret");

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
        // With what it registered: this version has no workflows.
        detail: {
          version: 1,
          previous: null,
          schedules: 0,
          emails: "",
          events: "",
        },
      },
    ]);
  });

  it("are made by builders and admins, and private to them", async () => {
    const { apps: builder } = await appsApi("builder");
    const { apps: user } = await appsApi("user");
    const app = await newApp(builder);
    await commit(builder, app.id, first);

    await expect(
      Promise.all([outcome(user.create({ name: "Mine" })), user.list()])
    ).resolves.toStrictEqual(["role.forbidden", []]);
    // The rest as for an App that isn't there (app-roles.test.ts).
    const refused = await Promise.all([
      outcome(user.get(app.id)),
      outcome(user.contents(app.id)),
      outcome(user.files.read(app.id, 1)),
      outcome(user.files.commit(app.id, { "AGENTS.md": "# Mine\n" }, "Mine")),
      outcome(user.versions.list(app.id)),
      outcome(user.versions.diff(app.id, 1, 1)),
      outcome(user.versions.propose(app.id, 1)),
      outcome(user.versions.setCurrent(app.id, 1)),
    ]);
    expect(new Set(refused)).toStrictEqual(new Set(["app.not_found"]));
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
        async (path) => await outcome(commit(apps, app.id, { [path]: "x" }))
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
    // Exactly an App's limit is within it.
    await commit(apps, app.id, full);
    await expect(
      Promise.all([
        outcome(commit(apps, app.id, { "AGENTS.md": tooLong })),
        outcome(commit(apps, app.id, { "AGENTS.md": "x" })),
        outcome(commit(apps, app.id, {})),
        outcome(commit(apps, app.id, { "AGENTS.md": "" }, " ")),
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
    await expect(
      commit(apps, app.id, { "components/part-0.ts": null, "AGENTS.md": "x" })
    ).resolves.toMatchObject({ version: 2 });
  });

  it("commits over a version that is over the limits only what is within them", async () => {
    const { apps, userId } = await appsApi("builder");
    const app = await newApp(apps);
    // More files than an App may have now: committed when the limits were
    // higher.
    const count = appLimits.files + 2;
    await storedUnchecked(
      app.id,
      userId,
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `components/part-${index}.ts`,
          "x",
        ])
      )
    );

    // One after another: each is over the same version.
    const steps: [string, Record<string, string | null>][] = [
      ["add", { "components/new.ts": "x" }],
      ["grow", { "components/part-0.ts": "xx" }],
      // Still over them: no version until it's within them.
      ["shrink", { "components/part-0.ts": null }],
      [
        "shrink to fit",
        { "components/part-0.ts": null, "components/part-1.ts": null },
      ],
    ];
    const outcomes: [string, string][] = [];
    for (const [step, changes] of steps) {
      // oxlint-disable-next-line no-await-in-loop -- steps are sequential by design
      outcomes.push([step, await outcome(commit(apps, app.id, changes))]);
    }
    expect(outcomes).toStrictEqual([
      ["add", "app.too_large"],
      ["grow", "app.too_large"],
      ["shrink", "app.too_large"],
      ["shrink to fit", "ok"],
    ]);
  });

  it("refuses Apps and versions that don't exist", async () => {
    const { apps } = await appsApi("builder");
    const app = await newApp(apps);
    await expect(
      Promise.all([
        outcome(apps.get("no-such-app")),
        outcome(commit(apps, "no-such-app", { "AGENTS.md": "x" })),
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
