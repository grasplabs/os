import type { KnowledgeApi, KnowledgeTools } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { indexApps } from "../src/knowledge/apps-collection.ts";
import { grantReviewed, release, requestGranted } from "./apps.ts";
import { actingFor, envOf, knowledgeIn } from "./contexts.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import {
  knowledgeRacing,
  newTeam,
  readCollection,
  storedGrant,
} from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  refusal,
  signedInApi,
  unique,
} from "./sign-in.ts";

// The Apps collection: each App's AGENTS.md, at its current version, where
// those who may open the App find it. The ways it could go wrong, tried
// below: an entry that lags behind the App's current version, or never
// catches up after indexing failed; someone who may not open an App
// finding it, its text, or its name through search, a read, a listing,
// its history or a link, or still finding it once unshared; an agent
// finding more than the person it acts for, or anything without a grant;
// an App given the collection, keeping another App's AGENTS.md for
// whoever it is shared with; and anyone, admins too, writing the
// collection through Knowledge.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const appsCollection = "apps";

const personOf = async (role: Role) => {
  const person = await signedInApi(idp, role);
  const knowledge: KnowledgeApi = person.api.knowledge;
  return { ...person, knowledge };
};

type Person = Awaited<ReturnType<typeof personOf>>;

/** A word no other test's text has, to search for. */
const term = () => `v${crypto.randomUUID().replaceAll("-", "")}`;

const agentsMd = (word: string) =>
  `# How we approve leave\n\nEvery ${word} request goes to the team lead.\n`;

/** An App of `owner`'s whose current version has `agents` as AGENTS.md. */
const releasedApp = async (
  owner: Person,
  agents: string
): Promise<{ id: string; name: string }> => {
  const name = `Leave ${term()}`;
  const { id } = await owner.api.apps.create({
    name,
    description: "Leave requests, from request to approval.",
  });
  await release(owner, id, { "AGENTS.md": agents });
  return { id, name };
};

/** The Apps `knowledge` finds `word` in, by entry path. */
const entriesFound = async (
  knowledge: Pick<KnowledgeTools, "search">,
  word: string
): Promise<string[]> => {
  const { hits } = await knowledge.search(word);
  return hits
    .filter(({ collectionId }) => collectionId === appsCollection)
    .map(({ path }) => path);
};

/** For each of `words`, the Apps `knowledge` finds it in. */
const foundFor = async (
  knowledge: Pick<KnowledgeTools, "search">,
  ...words: string[]
): Promise<Record<string, string[]>> =>
  Object.fromEntries(
    await Promise.all(
      words.map(async (word): Promise<[string, string[]]> => [
        word,
        await entriesFound(knowledge, word),
      ])
    )
  );

const entryPath = (app: string) => `${app}/AGENTS.md`;

/** Whether `knowledge` lists the document `id` in the Apps collection. */
const listed = async (knowledge: KnowledgeApi, id: string) => {
  const { documents } = await knowledge.listDocuments(appsCollection);
  return documents.some((document) => document.id === id);
};

/** The entry of `app`, as its owner reads it. */
const entryOf = async (owner: Person, app: string) => {
  const { documents } = await owner.knowledge.listDocuments(appsCollection);
  const entry = documents.find(({ path }) => path === entryPath(app));
  if (!entry) {
    throw new Error(`App ${app} has no entry`);
  }
  return entry;
};

/**
 * Where the App's entry stands: the App's current version, the version
 * `app_entries` says the entry holds, the entry's versions (newest first),
 * and which of `words` it is found by.
 */
const entryState = async (owner: Person, app: string, words: string[]) => {
  const { id } = await entryOf(owner, app);
  const [{ currentVersion }, noted, { versions }, found] = await Promise.all([
    owner.api.apps.get(app),
    env.KNOWLEDGE.prepare("SELECT version FROM app_entries WHERE app_id = ?")
      .bind(app)
      .first<{ version: number }>(),
    owner.knowledge.history(id),
    foundFor(owner.knowledge, ...words),
  ]);
  return {
    current: currentVersion,
    noted: noted?.version ?? null,
    versions: versions.map(({ number }) => number),
    found,
  };
};

/** Everything creating and releasing an App needs, without indexing. */
const indexingOff = { apps: true, knowledge: true };

/** Runs `run` with `owner`'s API on a connection where indexing is off. */
const withIndexingOff = async (
  owner: Person,
  run: (api: Person["api"]) => Promise<void>
): Promise<void> => {
  const { core } = await openRpc(owner.session, {
    coreEnv: { ...env, FEATURES: indexingOff },
  });
  try {
    await run(core.authenticate());
  } finally {
    core[Symbol.dispose]();
  }
};

describe("indexing", setUpTime, () => {
  it("indexes an App's AGENTS.md as soon as a version is made current, and the next version replaces it", async () => {
    const owner = await personOf("builder");
    const first = term();
    const app = await releasedApp(owner, agentsMd(first));
    const path = entryPath(app.id);
    // Its name is searched too.
    const named = app.name.split(" ")[1] ?? "";
    await expect(
      foundFor(owner.knowledge, first, named)
    ).resolves.toStrictEqual({ [first]: [path], [named]: [path] });
    const entry = await entryOf(owner, app.id);
    expect(entry).toMatchObject({ title: app.name, currentVersion: 1 });

    const second = term();
    const events = await auditedDuring(
      async () =>
        await release(owner, app.id, { "AGENTS.md": agentsMd(second) })
    );
    await expect(
      foundFor(owner.knowledge, first, second)
    ).resolves.toStrictEqual({ [first]: [], [second]: [path] });
    expect(events).toContainEqual(
      expect.objectContaining({
        action: "knowledge.document.saved",
        actor: { type: "system" },
        target: { type: "document", id: entry.id },
      })
    );

    // Back to the first version: its text is the entry's again.
    await owner.api.apps.versions.setCurrent(app.id, 1);
    await expect(
      foundFor(owner.knowledge, first, second)
    ).resolves.toStrictEqual({ [first]: [path], [second]: [] });
  });

  it("indexes an App without AGENTS.md by its name and description", async () => {
    const owner = await personOf("builder");
    const name = `Onboarding ${term()}`;
    const { id } = await owner.api.apps.create({ name });
    await release(owner, id, { "notes.md": "# Notes\n" });
    await expect(
      entriesFound(owner.knowledge, name.split(" ")[1] ?? "")
    ).resolves.toStrictEqual([entryPath(id)]);
  });

  it("indexes an App whose AGENTS.md is over Knowledge's limits without it", async () => {
    const owner = await personOf("builder");
    // Within an App's limits, over a document's 500 links.
    const links = Array.from({ length: 501 }, (_, index) => `[[l${index}]]`);
    const word = term();
    const app = await releasedApp(owner, `# ${word}\n${links.join(" ")}\n`);
    const entry = await entryOf(owner, app.id);
    const { version } = await owner.knowledge.getDocument(entry.id);
    expect(version.text).toContain("This App's AGENTS.md is too large");
    await expect(
      foundFor(owner.knowledge, word, app.name.split(" ")[1] ?? "")
    ).resolves.toStrictEqual({
      [word]: [],
      [app.name.split(" ")[1] ?? ""]: [entryPath(app.id)],
    });
  });

  it("keeps one entry version for versions whose AGENTS.md is the same", async () => {
    const owner = await personOf("builder");
    const app = await releasedApp(owner, agentsMd(term()));
    await release(owner, app.id, { "notes.md": "# Notes\n" });
    await expect(entryOf(owner, app.id)).resolves.toMatchObject({
      currentVersion: 1,
    });
  });

  it("catches up on the 15-minute cron trigger with versions made current while indexing was off", async () => {
    const owner = await personOf("builder");
    const word = term();
    let id = "";
    await withIndexingOff(owner, async (api) => {
      ({ id } = await api.apps.create({ name: `Leave ${term()}` }));
      await release({ api }, id, { "AGENTS.md": agentsMd(word) });
    });
    await expect(entriesFound(owner.knowledge, word)).resolves.toStrictEqual(
      []
    );

    // Nothing while it is still off.
    await runQuarterHourCron({ FEATURES: indexingOff });
    await expect(entriesFound(owner.knowledge, word)).resolves.toStrictEqual(
      []
    );

    await runQuarterHourCron();
    await expect(entriesFound(owner.knowledge, word)).resolves.toStrictEqual([
      entryPath(id),
    ]);
    // Caught up: the next run writes nothing.
    const entry = await entryOf(owner, id);
    const events = await auditedDuring(async () => {
      await runQuarterHourCron();
    });
    expect(
      events.filter(({ target }) => target?.id === entry.id)
    ).toStrictEqual([]);
    await expect(entryOf(owner, id)).resolves.toMatchObject({
      currentVersion: 1,
    });
  });

  it("lets only one of two indexings at once write, and nothing of the other", async () => {
    const owner = await personOf("builder");
    const [first, second, third] = [term(), term(), term()];
    const app = await releasedApp(owner, agentsMd(first));
    const { id: entryId } = await entryOf(owner, app.id);
    // Version 2 made current unindexed, version 3 committed.
    await withIndexingOff(owner, async (api) => {
      await release({ api }, app.id, { "AGENTS.md": agentsMd(second) });
      await api.apps.files.commit(
        app.id,
        { "AGENTS.md": agentsMd(third) },
        "Third"
      );
    });

    // The cron indexes version 2; just before its write lands, version 3
    // is made current, and indexed, first.
    const events = await auditedDuring(async () => {
      await indexApps({
        ...env,
        KNOWLEDGE: knowledgeRacing(async () => {
          await owner.api.apps.versions.setCurrent(app.id, 3);
        }),
      });
    });
    await expect(
      entryState(owner, app.id, [first, second, third])
    ).resolves.toStrictEqual({
      current: 3,
      noted: 3,
      versions: [2, 1],
      found: { [first]: [], [second]: [], [third]: [entryPath(app.id)] },
    });
    expect(events.filter(({ target }) => target?.id === entryId)).toHaveLength(
      1
    );
  });

  it("heals an entry left at a version no longer current on the next cron run", async () => {
    const owner = await personOf("builder");
    const [first, second] = [term(), term()];
    const app = await releasedApp(owner, agentsMd(first));
    await withIndexingOff(owner, async (api) => {
      await release({ api }, app.id, { "AGENTS.md": agentsMd(second) });
    });

    // The cron read version 2 as current; before it writes, the App is
    // rolled back to version 1, whose text its entry still has. The cron's
    // write lands after: the entry holds version 2's text, and says so.
    await indexApps({
      ...env,
      KNOWLEDGE: knowledgeRacing(async () => {
        await owner.api.apps.versions.setCurrent(app.id, 1);
      }),
    });
    await expect(
      entryState(owner, app.id, [first, second])
    ).resolves.toMatchObject({
      current: 1,
      noted: 2,
      found: { [first]: [], [second]: [entryPath(app.id)] },
    });

    await runQuarterHourCron();
    await expect(
      entryState(owner, app.id, [first, second])
    ).resolves.toStrictEqual({
      current: 1,
      noted: 1,
      versions: [3, 2, 1],
      found: { [first]: [entryPath(app.id)], [second]: [] },
    });
  });
});

describe("who finds an App", setUpTime, () => {
  it("finds an App only for those who may open it, from sharing to unsharing", async () => {
    const owner = await personOf("builder");
    const other = await personOf("builder");
    const word = term();
    const app = await releasedApp(owner, agentsMd(word));
    const { id: entryId } = await entryOf(owner, app.id);

    const readsOf = async ({ knowledge }: Person) => ({
      search: await entriesFound(knowledge, word),
      listed: await listed(knowledge, entryId),
      get: await outcome(knowledge.getDocument(entryId)),
      history: await outcome(knowledge.history(entryId)),
      backlinks: await outcome(knowledge.backlinks(entryId)),
      read: await outcome(knowledge.read(entryId)),
      section: await outcome(knowledge.read(entryId, { section: 0 })),
      follow: await outcome(knowledge.follow(entryId)),
    });
    const found = {
      search: [entryPath(app.id)],
      listed: true,
      get: "ok",
      history: "ok",
      backlinks: "ok",
      read: "ok",
      section: "ok",
      follow: "ok",
    };
    const notFound = {
      search: [],
      listed: false,
      get: "knowledge.not_found",
      history: "knowledge.not_found",
      backlinks: "knowledge.not_found",
      read: "knowledge.not_found",
      section: "knowledge.not_found",
      follow: "knowledge.not_found",
    };
    await expect(readsOf(owner)).resolves.toStrictEqual(found);
    await expect(readsOf(other)).resolves.toStrictEqual(notFound);

    await owner.api.apps.members.add(app.id, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    await expect(readsOf(other)).resolves.toStrictEqual(found);

    await owner.api.apps.members.remove(app.id, {
      type: "person",
      id: other.userId,
    });
    await expect(readsOf(other)).resolves.toStrictEqual(notFound);
  });

  it("finds no App, nor the collection, while indexing is switched off, its owner neither", async () => {
    const owner = await personOf("builder");
    const word = term();
    const app = await releasedApp(owner, agentsMd(word));
    const { id: entryId } = await entryOf(owner, app.id);
    const { core } = await openRpc(owner.session, {
      coreEnv: { ...env, FEATURES: { knowledge: true } },
    });
    const knowledge: KnowledgeApi = core.authenticate().knowledge;
    try {
      const collections = await knowledge.listCollections();
      await expect(
        Promise.all([
          entriesFound(knowledge, word),
          outcome(knowledge.getDocument(entryId)),
          outcome(knowledge.listDocuments(appsCollection)),
        ])
      ).resolves.toStrictEqual([
        [],
        "knowledge.not_found",
        "knowledge.not_found",
      ]);
      expect(collections.map(({ id }) => id)).not.toContain(appsCollection);
    } finally {
      core[Symbol.dispose]();
    }
  });

  it("finds no App for someone it is shared with while it has read what they can't", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("builder");
    const anna = await personOf("user");
    const word = term();
    const app = await releasedApp(owner, agentsMd(word));
    await owner.api.apps.members.add(app.id, {
      type: "person",
      id: anna.userId,
      role: "user",
    });
    await expect(entriesFound(anna.knowledge, word)).resolves.toStrictEqual([
      entryPath(app.id),
    ]);

    // Then the App is granted a collection of a team Anna isn't in.
    const hr = await newTeam(admin, [owner]);
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `HR ${unique()}`,
      access: "teams",
      teams: [hr],
    });
    await storedGrant(
      { type: "app", id: app.id },
      { type: "collection", id: collectionId },
      ["read"],
      "HR"
    );
    await expect(
      Promise.all([
        outcome(anna.api.apps.get(app.id)),
        entriesFound(anna.knowledge, word),
        entriesFound(owner.knowledge, word),
      ])
    ).resolves.toStrictEqual(["app.unreadable", [], [entryPath(app.id)]]);
  });

  it("finds an App shared with a team for its people, and every App for admins", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("builder");
    const member = await personOf("user");
    const word = term();
    const app = await releasedApp(owner, agentsMd(word));
    await expect(entriesFound(member.knowledge, word)).resolves.toStrictEqual(
      []
    );
    await expect(entriesFound(admin.knowledge, word)).resolves.toStrictEqual([
      entryPath(app.id),
    ]);

    const team = await newTeam(admin, [member]);
    await owner.api.apps.members.add(app.id, {
      type: "team",
      id: team,
      role: "user",
    });
    await expect(entriesFound(member.knowledge, word)).resolves.toStrictEqual([
      entryPath(app.id),
    ]);
  });

  it("doesn't name an App through a link to its entry", async () => {
    const owner = await personOf("builder");
    const other = await personOf("builder");
    const shared = await releasedApp(owner, agentsMd(term()));
    // The App `other` can't open links to the one they can, and back.
    const hidden = await releasedApp(
      owner,
      `# Hidden\nSee [[${entryPath(shared.id)}]].\n`
    );
    await release(owner, shared.id, {
      "AGENTS.md": `# Shared\nSee [[${entryPath(hidden.id)}]].\n`,
    });
    await owner.api.apps.members.add(shared.id, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const { id: sharedEntry } = await entryOf(owner, shared.id);
    const { id: hiddenEntry } = await entryOf(owner, hidden.id);

    const byOwner = await owner.knowledge.follow(sharedEntry);
    expect(byOwner.links).toMatchObject([{ documentId: hiddenEntry }]);
    expect(byOwner.backlinks).toMatchObject([{ documentId: hiddenEntry }]);

    const byOther = await other.knowledge.follow(sharedEntry);
    expect(byOther.links).toStrictEqual([
      {
        path: entryPath(hidden.id),
        label: null,
        documentId: null,
        title: null,
      },
    ]);
    expect(byOther.backlinks).toStrictEqual([]);
    await expect(other.knowledge.backlinks(sharedEntry)).resolves.toMatchObject(
      { backlinks: [] }
    );
  });

  it("gives an agent the Apps of the person it acts for, and only under a grant", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("builder");
    const other = await personOf("builder");
    const word = term();
    const app = await releasedApp(owner, agentsMd(word));
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const toolsFor = async (person: Person): Promise<KnowledgeTools> => {
      const tools = knowledgeIn(await envOf(actingFor(agent, person.userId)));
      if (!tools) {
        throw new Error("No KNOWLEDGE binding");
      }
      return tools;
    };

    // No grant, no Knowledge tools at all.
    expect(
      knowledgeIn(await envOf(actingFor(agent, owner.userId)))
    ).toBeUndefined();

    await requestGranted(idp, admin, readCollection(agent, appsCollection));
    await expect(
      entriesFound(await toolsFor(owner), word)
    ).resolves.toStrictEqual([entryPath(app.id)]);
    await expect(
      entriesFound(await toolsFor(other), word)
    ).resolves.toStrictEqual([]);
  });

  it("is never given to an App, which would keep what it found for whoever it is shared with", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("builder");
    // Indexed, so the collection is there.
    await releasedApp(owner, agentsMd(term()));
    const { id: app } = await owner.api.apps.create({ name: `X ${term()}` });
    const subject = { type: "app" as const, appId: app };
    // Asked for before requests were refused: the grant refuses it.
    const old = await storedGrant(
      { type: "app", id: app },
      { type: "collection", id: appsCollection },
      ["read"],
      "APPS",
      "requested"
    );

    await expect(
      Promise.all([
        outcome(
          owner.api.permissions.request(readCollection(subject, appsCollection))
        ),
        outcome(grantReviewed(admin.api, old)),
      ])
    ).resolves.toStrictEqual(["permission.invalid", "permission.invalid"]);
    await expect(admin.api.permissions.list(subject)).resolves.toMatchObject([
      { id: old, status: "requested" },
    ]);
  });

  it("keeps an App granted it before from being shared, as what it read there can't be placed", async () => {
    const owner = await personOf("builder");
    const anna = await personOf("user");
    await releasedApp(owner, agentsMd(term()));
    const { id: app } = await owner.api.apps.create({ name: `X ${term()}` });
    // Granted before grants were refused.
    await storedGrant(
      { type: "app", id: app },
      { type: "collection", id: appsCollection },
      ["read"],
      "APPS"
    );

    let refused: unknown;
    try {
      await owner.api.apps.members.add(app, {
        type: "person",
        id: anna.userId,
        role: "user",
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      code: "app.share_unreadable",
      details: { sources: [`collection:${appsCollection}`] },
    });
  });
});

/** A content purge of `word` from the document `id`. */
const purgeOf = (id: string, word: string) => ({
  type: "content" as const,
  documentIds: [id],
  terms: [word],
  reason: "erasure_request" as const,
});

const readOnlySchema = z.object({
  code: z.literal("knowledge.read_only"),
  details: z.object({ issues: z.array(z.string()) }),
});

/** The issues `admin` preparing `input` was refused with, as read-only. */
const purgeRefusal = async (
  admin: Person,
  input: ReturnType<typeof purgeOf>
): Promise<string[]> =>
  readOnlySchema.parse(await refusal(admin.knowledge.preparePurge(input)))
    .details.issues;

/** The version the entry of `app` is at. */
const entryVersion = async (owner: Person, app: string): Promise<number> => {
  const { currentVersion } = await entryOf(owner, app);
  return currentVersion;
};

/** How many versions of the document `id` hold `word`. */
const versionsHolding = async (id: string, word: string): Promise<number> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT text FROM versions WHERE document_id = ?"
  )
    .bind(id)
    .all<{ text: string }>();
  return results.filter(({ text }) => text.includes(word)).length;
};

describe("read-only", setUpTime, () => {
  it("refuses saves and restores in the Apps collection, an admin's too, and purges until the App has a version without the term", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("builder");
    const word = term();
    const app = await releasedApp(owner, agentsMd(word));
    const { id } = await entryOf(owner, app.id);
    for (const person of [owner, admin]) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const tries = await Promise.all([
        outcome(
          person.knowledge.saveDocument({
            collectionId: appsCollection,
            path: entryPath(app.id),
            text: "# Mine now\n",
            ifVersion: 1,
          })
        ),
        outcome(
          person.knowledge.saveDocument({
            collectionId: appsCollection,
            path: "new.md",
            text: "# New\n",
            ifVersion: 0,
          })
        ),
        outcome(
          person.knowledge.restoreVersion({
            documentId: id,
            version: 1,
            ifVersion: 1,
          })
        ),
      ]);
      expect(tries).toStrictEqual([
        "knowledge.read_only",
        "knowledge.read_only",
        "knowledge.read_only",
      ]);
    }
    // While the App holds the term, a purge would last only until the next
    // indexing made the entry again from the App, which the purge can't
    // reach.
    const input = purgeOf(id, word);
    const inAgentsMd = `documentIds: document ${id} is an App's entry in the Apps collection, made from the App itself: a term is in the App's AGENTS.md: publish a version without it; then purge`;
    expect({
      issues: await purgeRefusal(admin, input),
      entry: await entryVersion(owner, app.id),
      found: await entriesFound(owner.knowledge, word),
    }).toStrictEqual({
      issues: [inAgentsMd],
      entry: 1,
      found: [entryPath(app.id)],
    });

    // Indexing lags: the entry is of a clean version still, but the App's
    // current version holds the term again, which the next indexing writes.
    await release(owner, app.id, { "AGENTS.md": agentsMd(term()) });
    await withIndexingOff(owner, async (api) => {
      await release({ api }, app.id, { "AGENTS.md": agentsMd(word) });
    });
    expect({
      entry: await entryVersion(owner, app.id),
      issues: await purgeRefusal(admin, input),
    }).toStrictEqual({
      entry: 2,
      issues: [inAgentsMd],
    });

    // Once the App's current version leaves it out, the purge rewrites the
    // entry's history.
    await release(owner, app.id, { "AGENTS.md": agentsMd(term()) });
    const plan = await admin.knowledge.preparePurge(input);
    const result = await admin.knowledge.purge(input, plan.token);
    expect({
      planned: plan.versions,
      purged: result.versions,
      holding: await versionsHolding(id, word),
    }).toStrictEqual({ planned: 1, purged: 1, holding: 0 });
  });

  it("refuses to purge an App's entry while the App's name holds the term, until it is changed, and while the App can't be read", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("builder");
    const word = term();
    const { id: appId } = await owner.api.apps.create({
      name: `Leave ${word}`,
      description: "Leave requests, from request to approval.",
    });
    await release(owner, appId, { "AGENTS.md": agentsMd(term()) });
    const { id } = await entryOf(owner, appId);
    const input = purgeOf(id, word);
    await expect(purgeRefusal(admin, input)).resolves.toStrictEqual([
      `documentIds: document ${id} is an App's entry in the Apps collection, made from the App itself: a term is in the App's name or description, which a purge can't reach: the App's builders or Grasp support must change it first; then purge`,
    ]);

    // No API renames an App yet: the name changes where the App keeps it.
    await env.DB.prepare("UPDATE apps SET name = ? WHERE id = ?")
      .bind("Leave requests", appId)
      .run();
    const plan = await admin.knowledge.preparePurge(input);
    await admin.knowledge.purge(input, plan.token);
    await expect(versionsHolding(id, word)).resolves.toBe(0);

    // An App whose current version can't be read can't be checked: the
    // purge is refused rather than trusted.
    await env.DB.prepare("UPDATE apps SET current_version = ? WHERE id = ?")
      .bind(999, appId)
      .run();
    await expect(purgeRefusal(admin, input)).resolves.toStrictEqual([
      `documentIds: document ${id} is an App's entry in the Apps collection, made from the App itself: the App or its current version can't be read, so it can't be checked for the terms; try again later`,
    ]);
  });
});
