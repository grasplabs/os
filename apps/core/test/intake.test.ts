import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { builtinAppId } from "../src/builtin-app-id.ts";
import { builtins, fingerprintOf, release } from "../src/builtins.ts";
import { grantReviewed, revokeOtherCopies, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The intake, the built-in App (apps/core/blueprints/intake/): an App
// created from it asks for the Playbook, and once an admin grants it,
// keeps drafts of a source and its statements for review, and saves them
// to the Playbook as `source` and `statement` records, which its types
// (app/records.json) check whoever saves. What can go wrong, tried below:
// a draft reaching the Playbook without being saved, or saved twice; a
// save that stops halfway finished with other records than it started;
// someone who may not change the Playbook reading or writing drafts; edits
// over someone else's; and a statement without a source, tags, or with
// tags the intake doesn't know, saved by hand past the App.

const idp = mockIdp();

const intake = builtinAppId("intake");

/** The collection the intake declares, and keeps its records in. */
const playbook = "playbook";

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** What a server method answered (`{ ok }`), as `schema` reads it. */
const okOf = <T>(answer: unknown, schema: z.ZodType<T>): T => {
  const { ok } = z.object({ ok: schema }).parse(answer);
  return ok;
};

const call = async (
  app: AppId,
  userId: string,
  method: string,
  ...args: unknown[]
): Promise<unknown> => await callApp(env, app, as(userId), method, args);

const createdSchema = z.object({ id: z.string(), version: z.number() });

const savedSchema = z.object({ source: z.string(), statements: z.number() });

const overviewSchema = z.object({
  access: z.enum(["none", "ok"]),
  writable: z.boolean(),
  drafts: z.array(
    z.object({
      id: z.string(),
      version: z.number(),
      status: z.string(),
      title: z.string(),
      statements: z.number(),
    })
  ),
});

/** An interview, as someone types it into the review. */
const interview = (title: string) => ({
  source: {
    title,
    medium: "interview",
    date: "2026-09-21",
    from: "  Anna, controller  ",
    notes: "Talked about month-end close.",
  },
  statements: [
    {
      text: "Closing the month takes three days.",
      tags: ["time_sink"],
      quote: "It's three days, every month.",
    },
    {
      text: "  Invoices wait for a second signature over 5,000.  ",
      tags: ["rule", "blocker", "rule"],
      quote: "",
    },
  ],
});

/** An App created from the intake by an admin, its Playbook granted. */
const copyOf = async (admin: Awaited<ReturnType<typeof signedInApi>>) => {
  const created = await admin.api.apps.blueprints.create(intake, 1, {
    name: `Intake ${unique()}`,
  });
  for (const { id } of created.permissions) {
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    await grantReviewed(admin.api, id);
  }
  await admin.api.apps.versions.setCurrent(created.app.id, 1);
  await serverBuilt(created.app.id, 1);
  return {
    app: appIdSchema.parse(created.app.id),
    asked: created.permissions.map(({ object, actions, binding }) => ({
      object,
      actions,
      binding,
    })),
  };
};

/** An admin's intake, the one copy with the Playbook's intake types. */
const setUp = async () => {
  await builtins(env).ensureInstalled(await fingerprintOf(env, release));
  const admin = await signedInApi(idp, "admin");
  const { app, asked } = await copyOf(admin);
  await revokeOtherCopies(admin.api, intake, app);
  return { admin, app, asked };
};

/**
 * The Playbook's documents whose paths start with `prefix`, with their
 * text, as an admin reads them in Knowledge: a page from where they'd be.
 */
const documentsAt = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  prefix: string
): Promise<{ path: string; text: string }[]> => {
  // `after` lists what sorts after it, so from just before the prefix.
  const { documents } = await admin.api.knowledge.listDocuments(playbook, {
    after: prefix.slice(0, -1),
  });
  const found = documents.filter(({ path }) => path.startsWith(prefix));
  return await Promise.all(
    found.map(async ({ id, path }) => {
      const read = await admin.api.knowledge.getDocument(id);
      return { path, text: read.version.text };
    })
  );
};

/** A new path in the Playbook's `folder`, for a record saved by hand. */
const byHand = (folder: string): string => `${folder}/by-hand-${unique()}.md`;

/** A document's text with frontmatter, as someone saves it in Knowledge. */
const recordText = (fields: string[], body = ""): string =>
  ["---", ...fields, "---", body].join("\n");

describe("the intake", { timeout: 60_000 }, () => {
  it("keeps a draft for review, and saves it, as edited, to the Playbook as a source and its statements", async () => {
    const { admin, app, asked } = await setUp();
    const title = `Month-end ${unique()}`;
    const draft = interview(title);

    const created = okOf(
      await call(app, admin.userId, "create", draft),
      createdSchema
    );
    const listed = okOf(
      await call(app, admin.userId, "overview"),
      overviewSchema
    );
    // Reviewed: the first statement retagged, a third added.
    const edited = {
      ...draft,
      statements: [
        { ...draft.statements[0], tags: ["time_sink", "handover"] },
        draft.statements[1],
        {
          text: "The team wants close done in one day.",
          tags: ["goal"],
          quote: "",
        },
      ],
    };
    const kept = okOf(
      await call(app, admin.userId, "keep", {
        id: created.id,
        ifVersion: 1,
        draft: edited,
      }),
      z.object({ version: z.number() })
    );
    const stale = await call(app, admin.userId, "keep", {
      id: created.id,
      ifVersion: 1,
      draft,
    });
    const inPlaybookBefore = await documentsAt(admin, "sources/2026-09-21-");
    const saved = okOf(
      await call(app, admin.userId, "save", {
        id: created.id,
        ifVersion: kept.version,
        draft: edited,
      }),
      savedSchema
    );
    const stem = saved.source.replace(/^sources\//u, "").replace(/\.md$/u, "");
    const after = okOf(
      await call(app, admin.userId, "overview"),
      overviewSchema
    );

    expect({
      asked,
      listed: listed.drafts
        .filter(({ id }) => id === created.id)
        .map(({ version, status, title: listedTitle, statements }) => ({
          version,
          status,
          title: listedTitle,
          statements,
        })),
      kept: kept.version,
      stale,
      before: inPlaybookBefore.filter(({ path }) => path === saved.source),
      saved: saved.statements,
      source: await documentsAt(admin, saved.source),
      statements: await documentsAt(admin, `statements/${stem}-`),
      // Saved, the draft is gone.
      after: after.drafts.some(({ id }) => id === created.id),
      again: await call(app, admin.userId, "draft", created.id),
    }).toStrictEqual({
      asked: [
        {
          object: { type: "collection", collectionId: playbook },
          actions: ["read", "write"],
          binding: "PLAYBOOK",
        },
      ],
      listed: [{ version: 1, status: "open", title, statements: 2 }],
      kept: 2,
      stale: { error: "intake.conflict" },
      before: [],
      saved: 3,
      source: [
        {
          path: saved.source,
          text: recordText(
            [
              "type: source",
              `title: ${title}`,
              "medium: interview",
              "date: 2026-09-21",
              "from: Anna, controller",
            ],
            "Talked about month-end close.\n"
          ),
        },
      ],
      statements: [
        {
          path: `statements/${stem}-1.md`,
          text: recordText(
            [
              "type: statement",
              "title: Closing the month takes three days.",
              `source: ${saved.source}`,
              "date: 2026-09-21",
              "tags:",
              "  - time_sink",
              "  - handover",
            ],
            `From [[${saved.source}]].\n\n> It's three days, every month.\n`
          ),
        },
        {
          path: `statements/${stem}-2.md`,
          text: recordText(
            [
              "type: statement",
              "title: Invoices wait for a second signature over 5,000.",
              `source: ${saved.source}`,
              "date: 2026-09-21",
              "tags:",
              "  - blocker",
              "  - rule",
            ],
            `From [[${saved.source}]].\n`
          ),
        },
        {
          path: `statements/${stem}-3.md`,
          text: recordText(
            [
              "type: statement",
              "title: The team wants close done in one day.",
              `source: ${saved.source}`,
              "date: 2026-09-21",
              "tags:",
              "  - goal",
            ],
            `From [[${saved.source}]].\n`
          ),
        },
      ],
      after: false,
      again: { error: "intake.not_found" },
    });
  });

  it("refuses a draft that doesn't fit, and saves none without a statement", async () => {
    const { admin, app } = await setUp();
    const draft = interview(`Refused ${unique()}`);
    const refused = async (changed: unknown) =>
      await call(app, admin.userId, "create", changed);
    const empty = okOf(
      await call(app, admin.userId, "create", { ...draft, statements: [] }),
      createdSchema
    );
    expect({
      noTitle: await refused({
        ...draft,
        source: { ...draft.source, title: "  " },
      }),
      badDate: await refused({
        ...draft,
        source: { ...draft.source, date: "2026-02-30" },
      }),
      badMedium: await refused({
        ...draft,
        source: { ...draft.source, medium: "rumour" },
      }),
      untagged: await refused({
        ...draft,
        statements: [{ text: "Something", tags: [], quote: "" }],
      }),
      unknownTag: await refused({
        ...draft,
        statements: [{ text: "Something", tags: ["gossip"], quote: "" }],
      }),
      tooLong: await refused({
        ...draft,
        statements: [{ text: "x".repeat(201), tags: ["goal"], quote: "" }],
      }),
      tooMany: await refused({
        ...draft,
        statements: Array.from({ length: 101 }, () => ({
          text: "Something",
          tags: ["goal"],
          quote: "",
        })),
      }),
      nothingToSave: await call(app, admin.userId, "save", {
        id: empty.id,
        ifVersion: 1,
        draft: { ...draft, statements: [] },
      }),
    }).toStrictEqual({
      noTitle: { error: "intake.invalid" },
      badDate: { error: "intake.invalid" },
      badMedium: { error: "intake.invalid" },
      untagged: { error: "intake.invalid" },
      unknownTag: { error: "intake.invalid" },
      tooLong: { error: "intake.invalid" },
      tooMany: { error: "intake.invalid" },
      nothingToSave: { error: "intake.no_statements" },
    });
  });

  it("is only for whoever may change the Playbook", async () => {
    const { admin, app } = await setUp();
    const user = await signedInApi(idp, "user");
    const { id } = okOf(
      await call(app, admin.userId, "create", interview(`Mine ${unique()}`)),
      createdSchema
    );
    expect({
      overview: await call(app, user.userId, "overview"),
      create: await call(app, user.userId, "create", interview("Theirs")),
      draft: await call(app, user.userId, "draft", id),
      keep: await call(app, user.userId, "keep", {
        id,
        ifVersion: 1,
        draft: interview("Theirs"),
      }),
      save: await call(app, user.userId, "save", {
        id,
        ifVersion: 1,
        draft: interview("Theirs"),
      }),
      discard: await call(app, user.userId, "discard", { id, ifVersion: 1 }),
      // Still the admin's, as they left it.
      stillThere: okOf(
        await call(app, admin.userId, "draft", id),
        z.object({ version: z.number(), status: z.string() })
      ),
    }).toStrictEqual({
      overview: { ok: { access: "ok", writable: false, drafts: [] } },
      create: { error: "knowledge.forbidden" },
      draft: { error: "knowledge.forbidden" },
      keep: { error: "knowledge.forbidden" },
      save: { error: "knowledge.forbidden" },
      discard: { error: "knowledge.forbidden" },
      stillThere: { version: 1, status: "open" },
    });
  });

  it("finishes a save that stopped halfway with what it started, never with later edits", async () => {
    const { admin, app: first } = await setUp();
    // The first copy saves, and so claims the Playbook's intake types
    // (knowledge/record-types.ts). A second copy's save then lands its
    // source, and is refused at its first statement, whose source and
    // date only the owner's save sets.
    const { id: claiming } = okOf(
      await call(first, admin.userId, "create", interview(`First ${unique()}`)),
      createdSchema
    );
    okOf(
      await call(first, admin.userId, "save", {
        id: claiming,
        ifVersion: 1,
        draft: interview(`First ${unique()}`),
      }),
      savedSchema
    );
    const { app: second } = await copyOf(admin);
    const draft = interview(`Halfway ${unique()}`);
    const { id } = okOf(
      await call(second, admin.userId, "create", draft),
      createdSchema
    );
    const stopped = await call(second, admin.userId, "save", {
      id,
      ifVersion: 1,
      draft,
    });
    // Its paths (the server's `pathsOf`): by the date, title and draft.
    const stem = `2026-09-21-${draft.source.title.toLowerCase().replace(" ", "-")}-${id.slice(0, 8)}`;
    const [sourceLanded, statementsLanded] = await Promise.all([
      documentsAt(admin, `sources/${stem}.md`),
      documentsAt(admin, `statements/${stem}-`),
    ]);
    const whileSaving = okOf(
      await call(second, admin.userId, "draft", id),
      z.object({ version: z.number(), status: z.string() })
    );
    const edits = await call(second, admin.userId, "keep", {
      id,
      ifVersion: whileSaving.version,
      draft: interview("Changed since"),
    });
    const discarded = await call(second, admin.userId, "discard", {
      id,
      ifVersion: whileSaving.version,
    });
    // The first copy goes: the second now has the types.
    await revokeOtherCopies(admin.api, intake, second);
    const finished = okOf(
      await call(second, admin.userId, "save", {
        id,
        ifVersion: whileSaving.version,
        draft: interview("Changed since"),
      }),
      savedSchema
    );
    const [source, statements] = await Promise.all([
      documentsAt(admin, finished.source),
      documentsAt(admin, `statements/${stem}-`),
    ]);
    expect({
      stopped,
      landed: {
        source: sourceLanded.length,
        statements: statementsLanded.length,
      },
      whileSaving,
      edits,
      discarded,
      finished,
      source: source.map(({ text }) =>
        text.includes(`title: ${draft.source.title}`)
      ),
      statements: statements.map(({ text }) => text.split("\n")[2]),
    }).toStrictEqual({
      // The source landed; its statements, which only the types' owner
      // saves, didn't.
      stopped: { error: "knowledge.invalid" },
      landed: { source: 1, statements: 0 },
      whileSaving: { version: 2, status: "saving" },
      edits: { error: "intake.conflict" },
      discarded: { error: "intake.conflict" },
      finished: { source: `sources/${stem}.md`, statements: 2 },
      source: [true],
      statements: [
        "title: Closing the month takes three days.",
        "title: Invoices wait for a second signature over 5,000.",
      ],
    });
  });

  it("has the Playbook refuse a statement or source that doesn't fit its type, and a statement's source changed or made by hand", async () => {
    const { admin, app } = await setUp();
    const draft = interview(`By hand ${unique()}`);
    const { id } = okOf(
      await call(app, admin.userId, "create", draft),
      createdSchema
    );
    const saved = okOf(
      await call(app, admin.userId, "save", { id, ifVersion: 1, draft }),
      savedSchema
    );
    const stem = saved.source.replace(/^sources\//u, "").replace(/\.md$/u, "");
    const statementPath = `statements/${stem}-1.md`;
    const save = async (path: string, fields: string[], ifVersion = 0) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: playbook,
          path,
          text: recordText(fields),
          ifVersion,
        })
      );
    const title = "title: Closing takes three days.";
    const edits = {
      noTags: await save(
        statementPath,
        ["type: statement", title, "tags: []"],
        1
      ),
      unknownTag: await save(
        statementPath,
        ["type: statement", title, "tags: [gossip]"],
        1
      ),
      otherSource: await save(
        statementPath,
        [
          "type: statement",
          title,
          "source: sources/elsewhere.md",
          "tags: [goal]",
        ],
        1
      ),
      retagged: await save(
        statementPath,
        [
          "type: statement",
          title,
          `source: ${saved.source}`,
          "date: 2026-09-21",
          "tags: [blocker, time_sink]",
        ],
        1
      ),
    };
    const [edited] = await documentsAt(admin, statementPath);
    expect({
      ...edits,
      edited: edited?.text,
      byHand: await save(byHand("statements"), [
        "type: statement",
        "title: Approvals wait a week.",
        `source: ${saved.source}`,
        "date: 2026-09-21",
        "tags: [blocker]",
      ]),
      source: await save(byHand("sources"), [
        "type: source",
        "title: A call with finance",
        "medium: chat",
        "date: 2026-09-21",
      ]),
      badMedium: await save(byHand("sources"), [
        "type: source",
        "title: A call with finance",
        "medium: rumour",
        "date: 2026-09-21",
      ]),
      noDate: await save(byHand("sources"), [
        "type: source",
        "title: A call with finance",
        "medium: chat",
      ]),
    }).toStrictEqual({
      noTags: "knowledge.invalid",
      unknownTag: "knowledge.invalid",
      otherSource: "knowledge.invalid",
      retagged: "ok",
      edited: recordText([
        "type: statement",
        title,
        `source: ${saved.source}`,
        "date: 2026-09-21",
        "tags: [blocker, time_sink]",
      ]),
      // Only the intake's save, once someone reviewed it, makes one.
      byHand: "knowledge.invalid",
      source: "ok",
      badMedium: "knowledge.invalid",
      noDate: "knowledge.invalid",
    });
  });
});
