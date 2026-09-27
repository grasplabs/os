import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  clientSkillsCollectionId,
  graspSkills,
  graspSkillsCollectionId,
  syncGraspSkills,
} from "../src/knowledge/grasp-skills.ts";
import type { GraspSkill } from "../src/knowledge/grasp-skills.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  refusal,
  signedInApi,
} from "./sign-in.ts";

// Skills: the Grasp skills, which ship with each release and the cron
// trigger syncs into their collection, and the client's own. These tests
// start from the ways that can fail: a release's changed skill never
// reaches the collection, or reaches it twice when two syncs run at once,
// or a sync writes when nothing changed; someone, an admin too, changes a
// Grasp skill through a save, a restore or a purge, which the next sync
// would silently undo; a copy lands outside the client's skills, is made
// by someone who can't write them, overwrites a skill the client already
// has, or copies something that isn't a Grasp skill; and the catalog
// leaves out one of the two collections.
//
// The tests of a file share their storage, so each copy test copies a
// skill of its own.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const personOf = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personOf>>;

/** The Grasp skills' documents, in path order, as `person` lists them. */
const graspDocuments = async (person: Person) => {
  const { documents } = await person.api.knowledge.listDocuments(
    graspSkillsCollectionId
  );
  return documents;
};

/** The Grasp skill at `path`, synced from this release first. */
const graspDocument = async (person: Person, path: string) => {
  await syncGraspSkills(env);
  const documents = await graspDocuments(person);
  const found = documents.find((document) => document.path === path);
  if (!found) {
    throw new Error(`There's no Grasp skill at ${path}`);
  }
  return found;
};

/** The current text of `documentId`, as `person` reads it. */
const textOf = async (person: Person, documentId: string): Promise<string> => {
  const { version } = await person.api.knowledge.getDocument(documentId);
  return version.text;
};

/** This release's skills, with `path`'s text changed: another release. */
const releaseChanging = (path: string, text: string): GraspSkill[] =>
  graspSkills.map((skill) => (skill.path === path ? { path, text } : skill));

const insertsVersion = /^insert into "versions"/iu;

/**
 * The Knowledge database, but running `first` once, just before the first
 * batch that writes a version: another sync that gets there first.
 */
const knowledgeRacing = (first: () => Promise<void>): D1Database => {
  const real = env.KNOWLEDGE;
  let writing = false;
  let raced = false;
  return {
    prepare: (query) => {
      writing ||= insertsVersion.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (writing && !raced) {
        raced = true;
        await first();
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

const knowledgeActions = <Event extends { action: string }>(
  events: Event[]
): Event[] => events.filter(({ action }) => action.startsWith("knowledge."));

describe("the Grasp skills", setUpTime, () => {
  it("are every skill folder of the release, and only those", () => {
    // Vite lists the folders at build time; the Worker imports each one.
    const folders = Object.keys(import.meta.glob("../skills/*/SKILL.md")).map(
      (file) => file.slice("../skills/".length)
    );
    expect(graspSkills.map(({ path }) => path).toSorted()).toStrictEqual(
      folders.toSorted()
    );
  });

  it("are this release's once the cron trigger runs, and a run with nothing changed writes nothing", async () => {
    const admin = await personOf("admin");
    await runCron();

    const documents = await graspDocuments(admin);
    expect(documents.map(({ path }) => path)).toStrictEqual(
      graspSkills.map(({ path }) => path).toSorted()
    );
    const texts = await Promise.all(
      documents.map(async ({ id }) => await textOf(admin, id))
    );
    expect(texts).toStrictEqual(
      documents.map(
        ({ path }) => graspSkills.find((skill) => skill.path === path)?.text
      )
    );
    // Each is a skill named after its folder, as the catalog lists it.
    expect(
      documents.map(({ path, type, title }) => [path, type, title])
    ).toStrictEqual(
      documents.map(({ path }) => [
        path,
        "skill",
        path.slice(0, -"/SKILL.md".length),
      ])
    );

    const events = await auditedDuring(async () => {
      await runCron();
    });
    await expect(graspDocuments(admin)).resolves.toStrictEqual(documents);
    expect(knowledgeActions(events)).toStrictEqual([]);
  });

  it("take a release's changed skill as its next version, written once when another sync gets there first", async () => {
    const admin = await personOf("admin");
    const [skill] = graspSkills;
    if (!skill) {
      throw new Error("This release ships no Grasp skills");
    }
    const changed = await graspDocument(admin, skill.path);
    const before = await graspDocuments(admin);
    const changedText = `${skill.text}\nOne more thing.\n`;
    const next = releaseChanging(skill.path, changedText);

    // The second sync reads the skill at the same version as the first,
    // and writes only once the first has written it.
    const events = await auditedDuring(async () => {
      await syncGraspSkills(
        {
          ...env,
          KNOWLEDGE: knowledgeRacing(async () => {
            await syncGraspSkills(env, next);
          }),
        },
        next
      );
    });

    const after = await graspDocuments(admin);
    expect(
      after.map(({ path, currentVersion }) => [path, currentVersion])
    ).toStrictEqual(
      before.map(({ path, currentVersion }) => [
        path,
        path === skill.path ? currentVersion + 1 : currentVersion,
      ])
    );
    const { version } = await admin.api.knowledge.getDocument(changed.id);
    expect([
      version.number,
      version.author,
      version.message,
      version.text,
    ]).toStrictEqual([
      changed.currentVersion + 1,
      "grasp",
      "From the release",
      changedText,
    ]);
    expect(
      knowledgeActions(events).map(({ action, actor, target }) => ({
        action,
        actor,
        target,
      }))
    ).toStrictEqual([
      {
        action: "knowledge.document.saved",
        actor: { type: "system" },
        target: { type: "document", id: changed.id },
      },
    ]);

    // A rollback to this release puts its text back, as a version too.
    await syncGraspSkills(env);
    const rolledBack = await admin.api.knowledge.getDocument(changed.id);
    expect([rolledBack.version.number, rolledBack.version.text]).toStrictEqual([
      changed.currentVersion + 2,
      skill.text,
    ]);
  });

  it("aren't synced, created or copied while skills is off", async () => {
    const admin = await personOf("admin");
    const [skill] = graspSkills;
    if (!skill) {
      throw new Error("This release ships no Grasp skills");
    }
    const document = await graspDocument(admin, skill.path);
    const before = await graspDocuments(admin);
    const off: Env = { ...env, FEATURES: { knowledge: true } };

    await syncGraspSkills(off, releaseChanging(skill.path, "# Off"));

    await expect(graspDocuments(admin)).resolves.toStrictEqual(before);
    const { core } = await openRpc(admin.session, { coreEnv: off });
    const { knowledge } = core.authenticate();
    await expect(
      Promise.all([
        outcome(knowledge.skillCollections()),
        outcome(knowledge.copySkill({ documentId: document.id })),
      ])
    ).resolves.toStrictEqual(["feature.disabled", "feature.disabled"]);
  });

  it("can't be changed by anyone, an admin neither: not saved, restored or purged", async () => {
    const admin = await personOf("admin");
    const [skill] = graspSkills;
    if (!skill) {
      throw new Error("This release ships no Grasp skills");
    }
    const document = await graspDocument(admin, skill.path);
    const before = await graspDocuments(admin);

    await expect(
      Promise.all([
        outcome(
          admin.api.knowledge.saveDocument({
            collectionId: graspSkillsCollectionId,
            path: document.path,
            text: "---\nname: mine\ndescription: Mine now.\n---",
            ifVersion: document.currentVersion,
          })
        ),
        outcome(
          admin.api.knowledge.saveDocument({
            collectionId: graspSkillsCollectionId,
            path: "new/SKILL.md",
            text: "---\nname: new\ndescription: A new one.\n---",
            ifVersion: 0,
          })
        ),
        outcome(
          admin.api.knowledge.restoreVersion({
            documentId: document.id,
            version: 1,
            ifVersion: document.currentVersion,
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "knowledge.read_only",
      "knowledge.read_only",
      "knowledge.read_only",
    ]);
    await expect(
      refusal(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [document.id],
          terms: ["workflow"],
          reason: "other",
        })
      )
    ).resolves.toMatchObject({
      code: "knowledge.invalid",
      details: {
        issues: [
          `terms: removing them from document ${document.id} leaves text that can't be saved (knowledge.read_only)`,
        ],
      },
    });
    await expect(graspDocuments(admin)).resolves.toStrictEqual(before);
  });
});

describe("copying a Grasp skill", setUpTime, () => {
  it("puts it in the client's skills, at the same path, where admins adapt and purge it", async () => {
    const admin = await personOf("admin");
    const document = await graspDocument(admin, "draw-a-workflow/SKILL.md");

    let copyId = "";
    const events = await auditedDuring(async () => {
      const copy = await admin.api.knowledge.copySkill({
        documentId: document.id,
      });
      copyId = copy.id;
      expect(copy).toMatchObject({
        collectionId: clientSkillsCollectionId,
        path: document.path,
        type: "skill",
        title: document.title,
        currentVersion: 1,
      });
    });
    await expect(textOf(admin, copyId)).resolves.toBe(
      await textOf(admin, document.id)
    );
    expect(
      knowledgeActions(events)
        .filter(({ action }) => action !== "knowledge.collection.created")
        .map(({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        }))
    ).toStrictEqual([
      {
        action: "knowledge.document.saved",
        actor: { type: "person", userId: admin.userId },
        target: { type: "document", id: copyId },
        detail: { collectionId: clientSkillsCollectionId, version: 1 },
      },
      {
        action: "knowledge.skill.copied",
        actor: { type: "person", userId: admin.userId },
        target: { type: "document", id: document.id },
        detail: {
          version: document.currentVersion,
          collectionId: clientSkillsCollectionId,
        },
      },
    ]);

    const adapted = await admin.api.knowledge.saveDocument({
      collectionId: clientSkillsCollectionId,
      path: document.path,
      text: `${await textOf(admin, copyId)}\nAsk Anna de Vries first.\n`,
      ifVersion: 1,
    });
    expect(adapted.currentVersion).toBe(2);
    const input: PurgeInput = {
      type: "content",
      documentIds: [copyId],
      terms: ["Anna de Vries"],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);
    await expect(textOf(admin, copyId)).resolves.toContain(
      "Ask (removed) first."
    );
  });

  it("is refused where the client's skills have the path already, for anyone but admins, and for what isn't a Grasp skill", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const document = await graspDocument(admin, "run-a-baseline/SKILL.md");
    const copy = await admin.api.knowledge.copySkill({
      documentId: document.id,
    });

    await expect(
      refusal(admin.api.knowledge.copySkill({ documentId: document.id }))
    ).resolves.toMatchObject({
      code: "knowledge.conflict",
      details: { documentId: copy.id, latestVersion: 1 },
    });
    await expect(
      refusal(admin.api.knowledge.copySkill({ documentId: copy.id }))
    ).resolves.toMatchObject({
      code: "knowledge.invalid",
      details: { issues: ["documentId: not a Grasp skill"] },
    });
    await expect(
      Promise.all([
        outcome(user.api.knowledge.copySkill({ documentId: document.id })),
        outcome(
          admin.api.knowledge.copySkill({ documentId: crypto.randomUUID() })
        ),
        outcome(admin.api.knowledge.copySkill({ documentId: "" })),
      ])
    ).resolves.toStrictEqual([
      "knowledge.forbidden",
      "knowledge.not_found",
      "knowledge.invalid",
    ]);
  });
});

describe("the skill catalog", setUpTime, () => {
  it("lists both collections, the Grasp skills and the client's, and the skills in each", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const document = await graspDocument(admin, "write-board-page/SKILL.md");
    const both = {
      grasp: graspSkillsCollectionId,
      client: clientSkillsCollectionId,
    };
    await expect(admin.api.knowledge.skillCollections()).resolves.toStrictEqual(
      both
    );
    const copy = await admin.api.knowledge.copySkill({
      documentId: document.id,
    });

    await expect(user.api.knowledge.skillCollections()).resolves.toStrictEqual(
      both
    );
    const catalog = await user.api.knowledge.catalog();
    const ids = new Set<string>([
      graspSkillsCollectionId,
      clientSkillsCollectionId,
    ]);
    expect(
      catalog.collections
        .filter(({ id }) => ids.has(id))
        .map(({ name }) => name)
    ).toStrictEqual(["Grasp skills", "Our skills"]);
    const listed = catalog.skills.map(({ documentId }) => documentId);
    const graspListed = await graspDocuments(user);
    expect(listed).toStrictEqual(
      expect.arrayContaining([...graspListed.map(({ id }) => id), copy.id])
    );
  });
});
