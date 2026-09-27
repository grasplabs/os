import {
  purgeMaxDocuments,
  purgeMaxTerms,
  purgeTermMaxLength,
} from "@grasp-os/shared/knowledge";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { proposeMemory } from "../src/knowledge/memory-proposals.ts";
import { forContext, saveUserMemory } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Purging personal data from Knowledge. These tests start from the ways a
// purge can fail or be abused: the text survives somewhere (an earlier
// version, a section, a title, the search index's pages, a memory
// proposal, memory cached by version); the purge record in the audit log,
// which can't be purged, carries the text it removed; a purge reaches
// documents it wasn't aimed at; someone other than the client's admins
// purges, or purges without confirming, or confirms a purge other than the
// one prepared; and a purge leaves a document that can't be read.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const personOf = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personOf>>;

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

const hexOf = (text: string): string =>
  [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/**
 * Every `table.column` of the Knowledge database that holds `term`, in any
 * case, as text or among the bytes of a row: the search index's pages
 * (`search_words_data`) keep whole words. Trigram pages keep three
 * characters at a time, so the trigram index shows only in its content.
 */
const holding = async (term: string): Promise<string[]> => {
  const { results: tables } = await env.KNOWLEDGE.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  ).all<{ name: string }>();
  const found: string[] = [];
  for (const { name: table } of tables) {
    // oxlint-disable-next-line no-await-in-loop -- one table at a time
    const { results: columns } = await env.KNOWLEDGE.prepare(
      "SELECT name FROM pragma_table_info(?)"
    )
      .bind(table)
      .all<{ name: string }>();
    for (const { name: column } of columns) {
      // oxlint-disable-next-line no-await-in-loop -- one column at a time
      const row = await env.KNOWLEDGE.prepare(
        `SELECT count(*) AS n FROM "${table}"
         WHERE instr(lower(CAST("${column}" AS TEXT)), ?) > 0
           OR instr(hex("${column}"), ?) > 0`
      )
        .bind(term.toLowerCase(), hexOf(term.toLowerCase()))
        .first<{ n: number }>();
      if ((row?.n ?? 0) > 0) {
        found.push(`${table}.${column}`);
      }
    }
  }
  return found.toSorted();
};

/** Prepares `input` as `admin` and confirms it with the token. */
const purged = async (admin: Person, input: PurgeInput) => {
  const plan = await admin.api.knowledge.preparePurge(input);
  const result = await admin.api.knowledge.purge(input, plan.token);
  return { plan, result };
};

/** Each version's text of `documentId`, oldest first, whoever may read it. */
const versionTexts = async (documentId: string): Promise<string[]> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT text FROM versions WHERE document_id = ? ORDER BY number"
  )
    .bind(documentId)
    .all<{ text: string }>();
  return results.map(({ text }) => text);
};

/** Saves `text` over what is at `path` now. */
const saveOver = async (
  person: Person,
  collectionId: string,
  path: string,
  text: string,
  message?: string
) => {
  const { documents } = await person.api.knowledge.listDocuments(collectionId);
  const current = documents.find((document) => document.path === path);
  return await person.api.knowledge.saveDocument({
    collectionId,
    path,
    text,
    ifVersion: current?.currentVersion ?? 0,
    ...(message === undefined ? {} : { message }),
  });
};

describe("a personal purge", setUpTime, () => {
  it("removes the person's USER.md, every version, and their agents' proposals, from everywhere", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const stays = await personOf("user");
    const agent = newAgent();
    const secret = `vanderzwaluw${unique()}`;
    const work = await newChat();
    const asLeaver = actingFor(agent, leaver.userId);
    const asStays = actingFor(agent, stays.userId);
    const own = { type: "own" } as const;
    await saveUserMemory(env, asLeaver, work, own, {
      text: `# About me\nI am ${secret}.`,
      ifVersion: 0,
    });
    await saveUserMemory(env, asLeaver, work, own, {
      text: `# About me\nI am ${secret}, on leave.`,
      ifVersion: 1,
      message: `Learned ${secret} is on leave`,
    });
    await saveUserMemory(env, asStays, work, own, {
      text: `# About me\nI work with ${secret}.`,
      ifVersion: 0,
    });
    const memory = await admin.api.memory.collections();
    await saveOver(admin, memory.memory ?? "", "MEMORY.md", "# Company");
    await proposeMemory(env, asLeaver, work, {
      file: "MEMORY.md",
      text: `# Company\n${secret} runs payroll.`,
    });
    // Cached, keyed by the USER.md's version.
    const before = await forContext(env, asLeaver, work, own);
    const { personal } = await leaver.api.memory.collections();
    const heldBefore = await holding(secret);

    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, input);
    });

    const after = await forContext(env, asLeaver, work, own);
    const staysAfter = await forContext(env, asStays, work, own);
    const { plan, result } = outcomeOf ?? {};
    expect({
      plan: {
        ...plan,
        token: typeof plan?.token,
        expiresAt: typeof plan?.expiresAt,
      },
      result: { ...result, purgeId: typeof result?.purgeId },
      before: before.text.includes(secret),
      after: after.text.includes(secret),
      afterFiles: after.files.map(({ name }) => name),
      stays: staysAfter.text.includes(secret),
      leaversCollection: await outcome(
        leaver.api.knowledge.listDocuments(personal)
      ),
    }).toStrictEqual({
      plan: {
        documents: 1,
        versions: 2,
        proposals: 1,
        token: "string",
        expiresAt: "string",
      },
      result: {
        purgeId: "string",
        documents: 1,
        versions: 2,
        proposals: 1,
      },
      before: true,
      after: false,
      afterFiles: ["MEMORY.md"],
      stays: true,
      leaversCollection: "knowledge.not_found",
    });
    // The one who stays still has the name in their own USER.md; the
    // leaver's text is gone from every table, the index's pages too.
    expect(heldBefore).toStrictEqual([
      "memory_proposals.text",
      "search_trigrams.text",
      "search_trigrams_content.c3",
      "search_words.text",
      "search_words_content.c3",
      "search_words_data.block",
      "sections.text",
      "versions.message",
      "versions.text",
    ]);
    const { results: left } = await env.KNOWLEDGE.prepare(
      `SELECT document_id AS documentId FROM versions
       WHERE instr(text, ?) > 0 OR instr(message, ?) > 0`
    )
      .bind(secret, secret)
      .all<{ documentId: string }>();
    expect(left.map(({ documentId }) => documentId)).toStrictEqual(
      staysAfter.files
        .filter(({ name }) => name === "USER.md")
        .map(({ documentId }) => documentId)
    );
    const { results: leftProposals } = await env.KNOWLEDGE.prepare(
      "SELECT id FROM memory_proposals WHERE on_behalf_of = ?"
    )
      .bind(leaver.userId)
      .all();
    expect(leftProposals).toStrictEqual([]);
    expect({
      events: events.map(({ action, actor, target, detail }) => ({
        action,
        actor,
        target,
        detail,
      })),
      carriesText: JSON.stringify(events).includes(secret),
    }).toStrictEqual({
      events: [
        {
          action: "knowledge.purge.prepared",
          actor: { type: "person", userId: admin.userId },
          target: { type: "collection", id: personal },
          detail: {
            kind: "personal",
            reason: "offboarding",
            userId: leaver.userId,
            documents: 1,
            versions: 2,
            proposals: 1,
          },
        },
        {
          action: "knowledge.purged",
          actor: { type: "person", userId: admin.userId },
          target: { type: "collection", id: personal },
          detail: {
            purgeId: result?.purgeId,
            kind: "personal",
            reason: "offboarding",
            userId: leaver.userId,
            documents: 1,
            versions: 2,
            proposals: 1,
          },
        },
      ],
      carriesText: false,
    });
  });

  it("leaves nothing of a person whose text was only theirs, and can run again", async () => {
    const admin = await personOf("admin");
    const leaver = await personOf("user");
    const secret = `oudejans${unique()}`;
    const work = await newChat();
    await saveUserMemory(
      env,
      actingFor(newAgent(), leaver.userId),
      work,
      { type: "own" },
      { text: `# ${secret}\nCall me ${secret}.`, ifVersion: 0 }
    );
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "erasure_request",
    };
    const first = await purged(admin, input);
    const again = await purged(admin, input);
    expect({
      first: first.result.documents,
      again: { ...again.result, purgeId: typeof again.result.purgeId },
      held: await holding(secret),
    }).toStrictEqual({
      first: 1,
      again: {
        purgeId: "string",
        documents: 0,
        versions: 0,
        proposals: 0,
      },
      held: [],
    });
  });
});

describe("a purge of content", setUpTime, () => {
  it("rewrites every version of the documents named, and only those", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("user");
    const name = `Jansen${unique()}`;
    const email = `${name.toLowerCase()}.j@acme.test`;
    const notes = await owner.api.knowledge.createCollection({
      name: "Notes",
      access: "me",
    });
    await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# Leave\nAsk ${name} (${email}) about it.`
    );
    await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# ${name}'s leave\nAsk ${name.toUpperCase()} about it.\n\n## More\nNothing else.`,
      `About ${name}`
    );
    const leave = await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# ${name}'s leave\nAsk ${name.toLowerCase()} about it.\n\n## More\nNothing else. See [[other.md]].`
    );
    const other = await saveOver(
      owner,
      notes.id,
      "other.md",
      `# Other\n${name} is here too.`
    );
    const memory = await admin.api.memory.collections();
    const memoryId = memory.memory ?? "";
    const company = await saveOver(
      admin,
      memoryId,
      "MEMORY.md",
      `# Company\n${name} runs payroll.`
    );
    const agent = newAgent();
    const work = await newChat();
    const asAgent = actingFor(agent, admin.userId);
    const proposal = await proposeMemory(env, asAgent, work, {
      file: "MEMORY.md",
      text: `# Company\n${name} runs payroll and HR.`,
      message: `${name} does HR too`,
    });
    const before = await forContext(env, asAgent, work, { type: "own" });

    const input: PurgeInput = {
      type: "content",
      documentIds: [leave.id, company.id],
      terms: [name, email],
      reason: "erasure_request",
    };
    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, input);
    });

    const after = await forContext(env, asAgent, work, { type: "own" });
    const current = await owner.api.knowledge.getDocument(leave.id);
    const proposalRow = await env.KNOWLEDGE.prepare(
      "SELECT text, message, status, base_version AS baseVersion FROM memory_proposals WHERE id = ?"
    )
      .bind(proposal.id)
      .first();
    const hits = await owner.api.knowledge.search(name);
    const backlinks = await owner.api.knowledge.backlinks(other.id);
    const history = await owner.api.knowledge.history(leave.id);
    const companyTexts = await versionTexts(company.id);
    expect({
      plan: {
        documents: outcomeOf?.plan.documents,
        versions: outcomeOf?.plan.versions,
        proposals: outcomeOf?.plan.proposals,
      },
      result: {
        ...outcomeOf?.result,
        purgeId: typeof outcomeOf?.result.purgeId,
      },
      leave: await versionTexts(leave.id),
      history: history.versions.map(({ message }) => message),
      title: current.title,
      other: await versionTexts(other.id),
      // Earlier tests saved MEMORY.md too.
      company: companyTexts.filter(
        (text) => text.includes(name) || text.includes("(removed)")
      ),
      proposal: proposalRow,
      memoryBefore: before.text.includes(name),
      memoryAfter: after.text.includes(name),
      memoryKeyChanged: after.key !== before.key,
      hits: hits.hits.map(({ documentId }) => documentId),
      backlinks: backlinks.backlinks.map(({ documentId }) => documentId),
    }).toStrictEqual({
      plan: { documents: 2, versions: 4, proposals: 1 },
      result: {
        purgeId: "string",
        documents: 2,
        versions: 4,
        proposals: 1,
      },
      leave: [
        "# Leave\nAsk (removed) ((removed)) about it.",
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else.",
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else. See [[other.md]].",
        // Saved again, so its sections, title and search rows are made
        // again, and anyone who saved meanwhile conflicts.
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else. See [[other.md]].",
      ],
      history: ["Personal data removed", null, "About (removed)", null],
      title: "(removed)'s leave",
      other: [`# Other\n${name} is here too.`],
      company: [
        "# Company\n(removed) runs payroll.",
        "# Company\n(removed) runs payroll.",
      ],
      // Still waiting, on the new version: approving it still works.
      proposal: {
        text: "# Company\n(removed) runs payroll and HR.",
        message: "(removed) does HR too",
        status: "pending",
        baseVersion: companyTexts.length,
      },
      memoryBefore: true,
      memoryAfter: false,
      memoryKeyChanged: true,
      hits: [other.id],
      backlinks: [leave.id],
    });
    expect({
      events: events
        .filter(({ action }) => action.startsWith("knowledge.purge"))
        .map(({ action, provenance, detail }) => ({
          action,
          provenance: provenance.toSorted(),
          detail,
        })),
      carriesText: [name, email].some((term) =>
        JSON.stringify(events).toLowerCase().includes(term.toLowerCase())
      ),
    }).toStrictEqual({
      events: [
        {
          action: "knowledge.purge.prepared",
          provenance: [leave.id, company.id].toSorted(),
          detail: {
            kind: "content",
            reason: "erasure_request",
            terms: 2,
            documents: 2,
            versions: 4,
            proposals: 1,
          },
        },
        {
          action: "knowledge.purged",
          provenance: [leave.id, company.id].toSorted(),
          detail: {
            purgeId: outcomeOf?.result.purgeId,
            kind: "content",
            reason: "erasure_request",
            terms: 2,
            documents: 2,
          },
        },
      ],
      carriesText: false,
    });
    // The proposal moved to the new version, so approving it works.
    await admin.api.memory.approve(proposal.id);
    const approved = await admin.api.knowledge.getDocument(company.id);
    expect(approved.version.text).toBe(
      "# Company\n(removed) runs payroll and HR."
    );
  });

  it("drops the terms from the search index and its pages", async () => {
    const admin = await personOf("admin");
    const secret = `pietersz${unique()}`;
    const kept = `kept${unique()}`;
    // A passage, with characters a pattern would read otherwise.
    const passage = `on sick leave (burnout${unique()}) since May.`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `---\ndescription: About ${secret}\n---\n# ${secret}\nWrite to ${secret} for leave.\nShe is ${passage}\n\n## Other\nNothing ${kept}.`
    );
    const heldBefore = await holding(secret);
    const foundBefore = await admin.api.knowledge.search(secret);
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [secret, passage],
      reason: "other",
    });
    const text = await admin.api.knowledge.getDocument(document.id);
    const foundAfter = await admin.api.knowledge.search(secret);
    const stillFound = await admin.api.knowledge.search(kept);
    expect({
      heldBefore,
      foundBefore: foundBefore.hits.length,
      heldAfter: await holding(secret),
      passageAfter: await holding(passage.slice(15, -12)),
      text: text.version.text,
      foundAfter: foundAfter.hits.length,
      stillFound: stillFound.hits.map(({ documentId, title }) => ({
        documentId,
        title,
      })),
    }).toStrictEqual({
      heldBefore: [
        "documents.description",
        "documents.title",
        "search_trigrams.description",
        "search_trigrams.headings",
        "search_trigrams.text",
        "search_trigrams.title",
        "search_trigrams_content.c0",
        "search_trigrams_content.c1",
        "search_trigrams_content.c2",
        "search_trigrams_content.c3",
        "search_words.description",
        "search_words.headings",
        "search_words.text",
        "search_words.title",
        "search_words_content.c0",
        "search_words_content.c1",
        "search_words_content.c2",
        "search_words_content.c3",
        "search_words_data.block",
        "sections.headings",
        "sections.text",
        "versions.text",
      ],
      foundBefore: 2,
      heldAfter: [],
      passageAfter: [],
      text: `---\ndescription: About (removed)\n---\n# (removed)\nWrite to (removed) for leave.\nShe is (removed)\n\n## Other\nNothing ${kept}.`,
      foundAfter: 0,
      stillFound: [{ documentId: document.id, title: "(removed)" }],
    });
  });

  it("leaves frontmatter that still reads, where a name is the title, owner or a tag", async () => {
    const admin = await personOf("admin");
    const name = `Visser${unique()}`;
    const email = `${name.toLowerCase()}@acme.test`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "person.md",
      `---\ntitle: ${name}\nowner: ${email}\ntags: [${name}, hr]\n---\n# Profile\n${name} works in HR.`
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [name, email],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      title: read.title,
      owner: read.owner,
      tags: read.tags,
      text: read.version.text,
    }).toStrictEqual({
      title: "(removed)",
      owner: "(removed)",
      tags: ["(removed)", "hr"],
      text: "---\ntitle: (removed)\nowner: (removed)\ntags: [(removed), hr]\n---\n# Profile\n(removed) works in HR.",
    });
  });

  it("rewrites every version, however many there are", async () => {
    const admin = await personOf("admin");
    const name = `Bakker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const saved = 23;
    let documentId = "";
    for (let number = 1; number <= saved; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one version after another
      const summary = await saveOver(
        admin,
        handbook.id,
        "log.md",
        `# Log\n${name} did thing ${number}.`
      );
      documentId = summary.id;
    }
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [documentId],
      terms: [name],
      reason: "other",
    });
    const texts = await versionTexts(documentId);
    // Run again once finished: nothing found, nothing written.
    const again = await purged(admin, {
      type: "content",
      documentIds: [documentId],
      terms: [name],
      reason: "other",
    });
    const textsAgain = await versionTexts(documentId);
    expect({
      planned: plan.versions,
      rewritten: result.versions,
      versions: texts.length,
      holding: texts.filter((text) => text.includes(name)).length,
      last: texts.at(-1),
      again: { ...again.result, purgeId: typeof again.result.purgeId },
      unchanged: textsAgain,
    }).toStrictEqual({
      planned: saved,
      rewritten: saved,
      versions: saved + 1,
      holding: 0,
      last: `# Log\n(removed) did thing ${saved}.`,
      again: { purgeId: "string", documents: 0, versions: 0, proposals: 0 },
      unchanged: texts,
    });
  });

  it("saves a new version when only earlier versions held a term", async () => {
    const admin = await personOf("admin");
    const name = `Dekker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "note.md", `# Note\n${name} was here.`);
    const note = await saveOver(
      admin,
      handbook.id,
      "note.md",
      "# Note\nNobody here."
    );
    const { result } = await purged(admin, {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "other",
    });
    const { versions } = await admin.api.knowledge.history(note.id);
    expect({
      versions: result.versions,
      texts: await versionTexts(note.id),
      messages: versions.map(({ message }) => message),
    }).toStrictEqual({
      versions: 1,
      // So anyone who restored the first before it was purged conflicts.
      texts: [
        "# Note\n(removed) was here.",
        "# Note\nNobody here.",
        "# Note\nNobody here.",
      ],
      messages: ["Personal data removed", null, null],
    });
  });

  it("fails for a save made from text not yet purged, and finishes when run again", async () => {
    const admin = await personOf("admin");
    const name = `Smit${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "note.md", `# Note\n${name} one.`);
    const note = await saveOver(
      admin,
      handbook.id,
      "note.md",
      `# Note\n${name} two.`
    );
    // Knowledge as the purge's request sees it: once the purge first
    // writes (its audit event, before any version), someone saves from the
    // text they had open.
    let saved = false;
    const real = env.KNOWLEDGE;
    const knowledge: D1Database = {
      prepare: (query) => real.prepare(query),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const results = await real.batch<T>(statements);
        if (!saved) {
          saved = true;
          await saveOver(admin, handbook.id, "note.md", `# Note\n${name} 3.`);
        }
        return results;
      },
      exec: async (query) => await real.exec(query),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, KNOWLEDGE: knowledge },
    });
    const racing = core.authenticate();
    const input: PurgeInput = {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "other",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    const first = await outcome(racing.knowledge.purge(input, token));
    const afterFirst = await versionTexts(note.id);
    const again = await purged(admin, input);
    expect({
      saved,
      first,
      afterFirst: afterFirst.map((text) => text.includes(name)),
      again: again.result.versions,
      afterAgain: await versionTexts(note.id),
    }).toStrictEqual({
      saved: true,
      first: "knowledge.conflict",
      // The earlier version was rewritten; the current one, and the one
      // saved meanwhile, weren't.
      afterFirst: [false, true, true],
      again: 2,
      afterAgain: [
        "# Note\n(removed) one.",
        "# Note\n(removed) two.",
        "# Note\n(removed) 3.",
        "# Note\n(removed) 3.",
      ],
    });
  });
});

describe("purging", setUpTime, () => {
  it("is only for the client's admins, and never without the token prepared for it", async () => {
    const admin = await personOf("admin");
    const otherAdmin = await personOf("admin");
    const builder = await personOf("builder");
    const user = await personOf("user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    await saveUserMemory(
      env,
      actingFor(newAgent(), user.userId),
      await newChat(),
      { type: "own" },
      { text: "# About me", ifVersion: 0 }
    );
    const input: PurgeInput = {
      type: "personal",
      userId: user.userId,
      reason: "offboarding",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    const otherInput: PurgeInput = { ...input, reason: "other" };
    const dot = token.indexOf(".");
    const tampered = `${Number(token.slice(0, dot)) + 1}${token.slice(dot)}`;
    const refusals = await Promise.all([
      outcome(builder.api.knowledge.preparePurge(input)),
      outcome(user.api.knowledge.purge(input, token)),
      outcome(staff.knowledge.preparePurge(input)),
      outcome(staff.knowledge.purge(input, token)),
      outcome(otherAdmin.api.knowledge.purge(input, token)),
      outcome(admin.api.knowledge.purge(otherInput, token)),
      outcome(admin.api.knowledge.purge(input, tampered)),
      outcome(admin.api.knowledge.purge(input, "not-a-token")),
      outcome(
        admin.api.knowledge.preparePurge(
          // SAFETY: invalid on purpose: free text as the reason, which a
          // client can send, as Cap'n Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          { ...input, reason: "Jan de Vries left" } as never
        )
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: ["x"],
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: Array.from({ length: purgeMaxDocuments + 1 }, () =>
            crypto.randomUUID()
          ),
          terms: ["Jan"],
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: Array.from(
            { length: purgeMaxTerms + 1 },
            (_, index) => `Jan${index}`
          ),
          reason: "other",
        })
      ),
      outcome(
        admin.api.knowledge.preparePurge({
          type: "content",
          documentIds: [crypto.randomUUID()],
          terms: ["x".repeat(purgeTermMaxLength + 1)],
          reason: "other",
        })
      ),
      // Terms the marker holds: a purge would find them again in it.
      // Or that the marker and the text next to it would make again.
      ...[
        "removed",
        "MOVE",
        "(r",
        "d)",
        ") Jan",
        "Jan (",
        "ED) Jan",
        "Jan (rem",
      ].map(
        async (term) =>
          await outcome(
            admin.api.knowledge.preparePurge({
              type: "content",
              documentIds: [crypto.randomUUID()],
              terms: ["Jan", term],
              reason: "other",
            })
          )
      ),
    ]);
    // Past its ten minutes.
    vi.useFakeTimers({ toFake: ["Date"] });
    let expired: string;
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expired = await outcome(admin.api.knowledge.purge(input, token));
    } finally {
      vi.useRealTimers();
    }
    expect({ refusals, expired }).toStrictEqual({
      refusals: [
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.purge_expired",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.invalid",
      ],
      expired: "knowledge.purge_expired",
    });
    // None of those changed anything: the token still purges it all.
    await expect(
      admin.api.knowledge.purge(input, token)
    ).resolves.toMatchObject({ documents: 1, versions: 1 });
  });

  it("refuses a purge that would leave a document that can't be read, and changes nothing", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const other = `holt${unique()}`;
    const kept = await saveOver(
      admin,
      handbook.id,
      "kept.md",
      `# Kept\n${other} stays until the purge is refused.`
    );
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `---\ndescription: HR\n---\n# People\n${other} is here.`
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [kept.id, document.id],
      // Removing it breaks the frontmatter.
      terms: [other, "description:"],
      reason: "other",
    };
    expect({
      prepared: await outcome(admin.api.knowledge.preparePurge(input)),
      kept: await versionTexts(kept.id),
      document: await versionTexts(document.id),
    }).toStrictEqual({
      prepared: "knowledge.invalid",
      kept: [`# Kept\n${other} stays until the purge is refused.`],
      document: [`---\ndescription: HR\n---\n# People\n${other} is here.`],
    });
  });

  it("refuses to run a purge that a new version made impossible, before changing anything", async () => {
    const admin = await personOf("admin");
    const agent = actingFor(newAgent(), admin.userId);
    const work = await newChat();
    const own = { type: "own" } as const;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const kept = await saveOver(
      admin,
      handbook.id,
      "kept.md",
      "# Kept\nJo stays until the purge is refused."
    );
    const first = await saveUserMemory(env, agent, work, own, {
      text: "# About me\nCall me Jo.",
      ifVersion: 0,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [kept.id, first.id],
      terms: ["Jo"],
      reason: "erasure_request",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    // Within USER.md's 500 tokens, but not once each "Jo" is "(removed)".
    const long = `# About me\n${"Jo ".repeat(400)}`;
    await saveUserMemory(env, agent, work, own, { text: long, ifVersion: 1 });
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(admin.api.knowledge.purge(input, token));
    });
    expect({
      refused,
      events: events.map(({ action }) => action),
      kept: await versionTexts(kept.id),
      user: await versionTexts(first.id),
    }).toStrictEqual({
      refused: "knowledge.invalid",
      events: [],
      kept: ["# Kept\nJo stays until the purge is refused."],
      user: ["# About me\nCall me Jo.", long],
    });
  });

  it("refuses to run a purge of a memory file now over its limit, even when only earlier versions hold a term", async () => {
    const admin = await personOf("admin");
    const agent = actingFor(newAgent(), admin.userId);
    const work = await newChat();
    const own = { type: "own" } as const;
    const name = `Mulder${unique()}`;
    const first = await saveUserMemory(env, agent, work, own, {
      text: `# About me\nCall me ${name}.`,
      ifVersion: 0,
    });
    const current = `# About me\n${"Something else. ".repeat(20)}`;
    await saveUserMemory(env, agent, work, own, {
      text: current,
      ifVersion: 1,
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [first.id],
      terms: [name],
      reason: "erasure_request",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    // The limit lowered since: the current USER.md, which holds no term,
    // is over it, and a purge would save it again.
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, MEMORY_LIMITS: { "USER.md": 10 } },
    });
    const lowered = core.authenticate();
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(lowered.knowledge.purge(input, token));
    });
    expect({
      refused,
      events: events.map(({ action }) => action),
      user: await versionTexts(first.id),
    }).toStrictEqual({
      refused: "knowledge.invalid",
      events: [],
      user: [`# About me\nCall me ${name}.`, current],
    });
  });

  it("is switched off by its flag", async () => {
    const admin = await personOf("admin");
    const coreEnv: Env = {
      ...env,
      FEATURES: { knowledge: true, knowledge_purge: false },
    };
    const { core } = await openRpc(admin.session, { coreEnv });
    const { knowledge } = core.authenticate();
    const input: PurgeInput = {
      type: "personal",
      userId: admin.userId,
      reason: "other",
    };
    await expect(
      Promise.all([
        outcome(knowledge.preparePurge(input)),
        outcome(knowledge.purge(input, "0.x")),
      ])
    ).resolves.toStrictEqual(["feature.disabled", "feature.disabled"]);
  });
});
