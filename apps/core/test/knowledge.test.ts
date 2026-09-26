import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { CollectionInput, KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { createCollection } from "../src/knowledge/collections.ts";
import { allEvents } from "./audit-events.ts";
import { runCron, waitingInOutbox, whileLogDown } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import {
  auditedDuring,
  outcome,
  signedInApi,
  unique,
  whoami,
} from "./sign-in.ts";

// Knowledge through the API people use: every save adds a version, with its
// sections and links, in one transaction; a save from a stale version
// writes nothing; and nobody reads or changes what they may not.

const idp = mockIdp();

/** A signed-in person's Knowledge API, on a connection of their own. */
const knowledgeOf = async (role: Role) => {
  const person = await signedInApi(idp, role);
  const api: KnowledgeApi = person.api.knowledge;
  return { ...person, api };
};

const personal = (): CollectionInput => ({
  name: `Notes ${unique()}`,
  access: "me",
});

const detailsSchema = z.object({
  details: z.record(z.string(), z.unknown()).default({}),
});

/** The code and details a promise was refused with. */
const refusal = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    const { details } = detailsSchema.parse(error);
    return { code: knowledgeErrors.codeOf(error), ...details };
  }
  throw new Error("Expected a refusal");
};

const sectionsSchema = z.array(
  z.object({ version: z.number(), headings: z.string(), text: z.string() })
);

/** The sections stored for a document, in order. */
const storedSections = async (documentId: string) => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT version, headings, text FROM sections WHERE document_id = ? ORDER BY position"
  )
    .bind(documentId)
    .all();
  return sectionsSchema.parse(results).map(({ version, headings, text }) => ({
    version,
    headings: z.array(z.string()).parse(JSON.parse(headings)),
    text,
  }));
};

const leaveV1 = [
  "---",
  "title: Leave policy",
  "description: Read when someone asks about leave.",
  "tags: [hr]",
  "review: 2027-03-01",
  "---",
  "# Leave",
  "Everyone gets leave. See [[handbook/expenses|expenses]].",
  "## Parental leave",
  "Sixteen weeks.",
].join("\n");

const leaveV2 = [
  "---",
  "title: Leave policy",
  "---",
  "# Leave",
  "Everyone gets 25 days. See [[handbook/sick-leave]].",
].join("\n");

/** The paths of the documents that link to `documentId`. */
const backlinkPaths = async (
  api: KnowledgeApi,
  documentId: string,
  options?: { after?: string; limit?: number }
) => {
  const { backlinks } = await api.backlinks(documentId, options);
  return backlinks.map(({ path }) => path);
};

/** The version numbers in a document's history, newest first. */
const versionNumbers = async (api: KnowledgeApi, documentId: string) => {
  const { versions } = await api.history(documentId);
  return versions.map(({ number }) => number);
};

/** A document with that many headings. */
const headings = (count: number) =>
  Array.from({ length: count }, (_, index) => `# Part ${index}`).join("\n");

/** A document with that many links. */
const linksTo = (count: number) =>
  Array.from({ length: count }, (_, index) => `[[doc-${index}]]`).join(" ");

describe("saving a document", () => {
  it("adds the next version, with its sections and links, and replaces the last one's", async () => {
    const { api, userId } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());

    const first = await api.saveDocument({
      collectionId,
      path: "handbook/leave.md",
      text: leaveV1,
      ifVersion: 0,
    });
    const sectionsOfFirst = await storedSections(first.id);
    const second = await api.saveDocument({
      collectionId,
      path: "handbook/leave.md",
      text: leaveV2,
      ifVersion: 1,
      message: "25 days",
    });

    const sectionsOfSecond = await storedSections(first.id);
    const { version: current, ...read } = await api.getDocument(first.id);
    const { version: earlier } = await api.getDocument(first.id, 1);
    const { versions } = await api.history(first.id);
    expect({
      first,
      sectionsOfFirst,
      second: {
        currentVersion: second.currentVersion,
        tags: second.tags,
        reviewDate: second.reviewDate,
      },
      sectionsOfSecond,
      read: { ...read, version: current },
      earlier: earlier.text,
      history: versions.map(({ number, author, message }) => ({
        number,
        author,
        message,
      })),
    }).toStrictEqual({
      first: {
        id: first.id,
        collectionId,
        path: "handbook/leave.md",
        title: "Leave policy",
        type: "doc",
        description: "Read when someone asks about leave.",
        owner: userId,
        tags: ["hr"],
        reviewDate: "2027-03-01",
        currentVersion: 1,
        updatedAt: first.updatedAt,
      },
      sectionsOfFirst: [
        {
          version: 1,
          headings: ["Leave"],
          text: "# Leave\nEveryone gets leave. See [[handbook/expenses|expenses]].",
        },
        {
          version: 1,
          headings: ["Leave", "Parental leave"],
          text: "## Parental leave\nSixteen weeks.",
        },
      ],
      second: { currentVersion: 2, tags: [], reviewDate: null },
      sectionsOfSecond: [
        {
          version: 2,
          headings: ["Leave"],
          text: "# Leave\nEveryone gets 25 days. See [[handbook/sick-leave]].",
        },
      ],
      read: {
        ...second,
        version: {
          number: 2,
          text: leaveV2,
          author: userId,
          message: "25 days",
          restoredFrom: null,
          createdAt: second.updatedAt,
        },
        provenance: {
          collectionIds: [collectionId],
          sensitive: false,
          restricted: false,
        },
      },
      earlier: leaveV1,
      history: [
        { number: 2, author: userId, message: "25 days" },
        { number: 1, author: userId, message: null },
      ],
    });
  });

  it("finds links to a document, also those saved before it existed", async () => {
    const { api } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    const save = async (path: string, text: string, ifVersion = 0) =>
      await api.saveDocument({ collectionId, path, text, ifVersion });

    const leave = await save("handbook/leave.md", leaveV1);
    await save("index.md", "Start with [[handbook/leave|leave]] and [[faq]].");
    const faq = await save("faq.md", "See [[handbook/leave]].");
    const { backlinks: before } = await api.backlinks(leave.id);
    const pages = [
      await backlinkPaths(api, leave.id, { limit: 1 }),
      await backlinkPaths(api, leave.id, { after: "faq.md", limit: 1 }),
    ];
    // The index stops linking to leave: its links are its current version's.
    await save("index.md", "Only [[faq]] now.", 1);

    expect({
      before: before.map(({ path, label }) => ({ path, label })),
      pages,
      after: await backlinkPaths(api, leave.id),
      faq: await backlinkPaths(api, faq.id),
    }).toStrictEqual({
      before: [
        { path: "faq.md", label: null },
        { path: "index.md", label: "leave" },
      ],
      pages: [["faq.md"], ["index.md"]],
      after: ["faq.md"],
      faq: ["index.md"],
    });
  });

  it("writes nothing from a stale version, and says which version is current", async () => {
    const { api } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    const saved = await api.saveDocument({
      collectionId,
      path: "leave.md",
      text: leaveV1,
      ifVersion: 0,
    });

    const events = await auditedDuring(async () => {
      const refusals = await Promise.all([
        refusal(
          api.saveDocument({
            collectionId,
            path: "leave.md",
            text: leaveV2,
            ifVersion: 0,
          })
        ),
        refusal(
          api.saveDocument({
            collectionId,
            path: "leave.md",
            text: leaveV2,
            ifVersion: 2,
          })
        ),
      ]);
      expect(refusals).toStrictEqual([
        {
          code: "knowledge.conflict",
          documentId: saved.id,
          latestVersion: 1,
        },
        {
          code: "knowledge.conflict",
          documentId: saved.id,
          latestVersion: 1,
        },
      ]);
    });

    const { version } = await api.getDocument(saved.id);
    const sections = await storedSections(saved.id);
    expect({
      events,
      history: await versionNumbers(api, saved.id),
      text: version.text,
      sections: sections.map((section) => section.version),
    }).toStrictEqual({
      events: [],
      history: [1],
      text: leaveV1,
      sections: [1, 1],
    });
  });

  it("lets only one of two saves from the same version through", async () => {
    const { api } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    const save = async (text: string, ifVersion: number) =>
      await outcome(
        api.saveDocument({ collectionId, path: "race.md", text, ifVersion })
      );

    const created = await Promise.all([save("# One", 0), save("# Two", 0)]);
    const {
      documents: [document],
    } = await api.listDocuments(collectionId);
    const edited = await Promise.all([save("# Three", 1), save("# Four", 1)]);

    const current = await api.getDocument(document?.id ?? "");
    expect({
      created: created.toSorted(),
      edited: edited.toSorted(),
      versions: await versionNumbers(api, current.id),
      sections: await storedSections(current.id),
    }).toStrictEqual({
      created: ["knowledge.conflict", "ok"],
      edited: ["knowledge.conflict", "ok"],
      versions: [2, 1],
      sections: [
        {
          version: 2,
          headings: [current.version.text.slice(2)],
          text: current.version.text,
        },
      ],
    });
  });

  it("refuses invalid frontmatter and paths, naming the problem", async () => {
    const { api } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    const save = async (path: string, text: string) =>
      await refusal(
        api.saveDocument({ collectionId, path, text, ifVersion: 0 })
      );

    expect({
      frontmatter: await save("a.md", "---\ntype: essay\n---\nText"),
      path: await save("../escape.md", "Text"),
      // A path with link syntax couldn't be linked to.
      linkSyntax: await save("q#a.md", "Text"),
      skill: await save("pdf/SKILL.md", "No frontmatter."),
    }).toStrictEqual({
      frontmatter: {
        code: "knowledge.invalid",
        issues: ["frontmatter.type: one of doc, skill, memory, decision, file"],
      },
      path: {
        code: "knowledge.invalid",
        issues: [
          "path: A path has no empty, blank, '.' or '..' folders and doesn't start or end with /",
        ],
      },
      linkSyntax: {
        code: "knowledge.invalid",
        issues: ["path: A path has no [, ], # or |"],
      },
      skill: {
        code: "knowledge.invalid",
        issues: [
          "frontmatter.description: Invalid input: expected string, received undefined",
          "frontmatter.name: Invalid input: expected string, received undefined",
        ],
      },
    });
    await expect(api.listDocuments(collectionId)).resolves.toMatchObject({
      documents: [],
    });
  });

  it("stays within D1's limits: bounded size, sections and links", async () => {
    const { api } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    const save = async (path: string, text: string) =>
      await api.saveDocument({ collectionId, path, text, ifVersion: 0 });

    // The most a document may have, in as many statements as D1 needs.
    const largest = await save(
      "largest.md",
      `${headings(1000)}\n${linksTo(500)}`
    );
    const sections = await storedSections(largest.id);
    expect({
      largest: {
        sections: sections.length,
        links: await env.KNOWLEDGE.prepare(
          "SELECT count(*) AS links FROM links WHERE from_document_id = ?"
        )
          .bind(largest.id)
          .first("links"),
      },
      tooLarge: await refusal(save("big.md", "é".repeat(600_000))),
      tooManySections: await refusal(save("long.md", headings(1001))),
      tooManyLinks: await refusal(save("linked.md", linksTo(501))),
    }).toStrictEqual({
      largest: { sections: 1000, links: 500 },
      tooLarge: {
        code: "knowledge.too_large",
        bytes: 1_200_000,
        maxBytes: 1_048_576,
      },
      tooManySections: {
        code: "knowledge.too_many_sections",
        sections: 1001,
        maxSections: 1000,
      },
      tooManyLinks: {
        code: "knowledge.too_many_links",
        links: 501,
        maxLinks: 500,
      },
    });
  });

  it("is audited by who saved which version, without content", async () => {
    const { api, userId } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    let documentId = "";
    const events = await auditedDuring(async () => {
      ({ id: documentId } = await api.saveDocument({
        collectionId,
        path: "handbook/leave.md",
        text: leaveV1,
        ifVersion: 0,
      }));
    });
    expect(
      events.map(({ actor, action, target, detail }) => ({
        actor,
        action,
        target,
        detail,
      }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId },
        action: "knowledge.document.saved",
        target: { type: "document", id: documentId },
        detail: { collectionId, version: 1 },
      },
    ]);
  });

  it("keeps its audit event when the audit log is down, and appends it later", async () => {
    const { api } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    const { id: documentId } = await whileLogDown(async () => {
      const saved = await api.saveDocument({
        collectionId,
        path: "leave.md",
        text: leaveV1,
        ifVersion: 0,
      });
      // It waits in the Knowledge outbox while the log is down.
      await expect(
        waitingInOutbox(env.KNOWLEDGE, "knowledge.document.saved", saved.id)
      ).resolves.toBe(1);
      return saved;
    });
    await runCron();
    const sent = await allEvents();
    expect(
      sent.filter(
        ({ action, target }) =>
          action === "knowledge.document.saved" && target?.id === documentId
      )
    ).toHaveLength(1);
  });
});

describe("restoring a version", () => {
  it("saves its text as the next version, and records that", async () => {
    const { api, userId } = await knowledgeOf("user");
    const { id: collectionId } = await api.createCollection(personal());
    const { id } = await api.saveDocument({
      collectionId,
      path: "leave.md",
      text: leaveV1,
      ifVersion: 0,
    });
    await api.saveDocument({
      collectionId,
      path: "leave.md",
      text: leaveV2,
      ifVersion: 1,
    });

    let restored = 0;
    const events = await auditedDuring(async () => {
      ({ currentVersion: restored } = await api.restoreVersion({
        documentId: id,
        version: 1,
        ifVersion: 2,
      }));
    });
    const stale = await outcome(
      api.restoreVersion({ documentId: id, version: 1, ifVersion: 2 })
    );
    const missing = await outcome(
      api.restoreVersion({ documentId: id, version: 9, ifVersion: 3 })
    );

    const current = await api.getDocument(id);
    const sections = await storedSections(id);
    expect({
      restored,
      version: current.version,
      sections: sections.map((section) => section.headings),
      events: events.map(({ action, detail }) => ({ action, detail })),
      stale,
      missing,
    }).toStrictEqual({
      restored: 3,
      version: {
        number: 3,
        text: leaveV1,
        author: userId,
        message: null,
        restoredFrom: 1,
        createdAt: current.version.createdAt,
      },
      sections: [["Leave"], ["Leave", "Parental leave"]],
      events: [
        {
          action: "knowledge.document.restored",
          detail: { collectionId, version: 3, restoredFrom: 1 },
        },
      ],
      stale: "knowledge.conflict",
      missing: "knowledge.not_found",
    });
  });
});

describe("collections", () => {
  it("managed by Grasp or derived from Apps can't be written, even by an admin", async () => {
    const admin = await knowledgeOf("admin");
    const identity = await whoami(admin.session);
    const refused = await Promise.all(
      (["grasp", "apps"] as const).map(async (source) => {
        const { id } = await createCollection(
          env,
          identity,
          { name: `Managed ${source}`, access: "everyone" },
          source
        );
        return await outcome(
          admin.api.saveDocument({
            collectionId: id,
            path: "SKILL.md",
            text: "---\nname: pdf\ndescription: Read PDFs.\n---",
            ifVersion: 0,
          })
        );
      })
    );
    expect(refused).toStrictEqual([
      "knowledge.read_only",
      "knowledge.read_only",
    ]);
  });

  it("that are personal are invisible to everyone but their owner", async () => {
    const owner = await knowledgeOf("user");
    const admin = await knowledgeOf("admin");
    const { id: collectionId } = await owner.api.createCollection(personal());
    const { id } = await owner.api.saveDocument({
      collectionId,
      path: "diary.md",
      text: "# Private",
      ifVersion: 0,
    });

    const attempts = await Promise.all([
      outcome(admin.api.listDocuments(collectionId)),
      outcome(admin.api.getDocument(id)),
      outcome(admin.api.getDocument(id, 1)),
      outcome(admin.api.history(id)),
      outcome(admin.api.backlinks(id)),
      outcome(
        admin.api.saveDocument({
          collectionId,
          path: "diary.md",
          text: "# Mine now",
          ifVersion: 1,
        })
      ),
      outcome(
        admin.api.restoreVersion({ documentId: id, version: 1, ifVersion: 1 })
      ),
    ]);
    const listed = await admin.api.listCollections();
    expect({
      attempts,
      listed: listed.some((collection) => collection.id === collectionId),
    }).toStrictEqual({
      attempts: attempts.map(() => "knowledge.not_found"),
      listed: false,
    });
  });

  it("for teams are read and written by their members only", async () => {
    const admin = await knowledgeOf("admin");
    const member = await knowledgeOf("user");
    const outsider = await knowledgeOf("user");
    const teamId = await newTeam(admin, [member]);

    const collection = await admin.api.createCollection({
      name: "Finance",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const saved = await member.api.saveDocument({
      collectionId: collection.id,
      path: "budget.md",
      text: "# Budget",
      ifVersion: 0,
    });

    const sees = async (api: KnowledgeApi) => {
      const listed = await api.listCollections();
      return listed.some(({ id }) => id === collection.id);
    };
    expect({
      collection: {
        teams: collection.teams,
        sensitive: collection.sensitive,
        source: collection.source,
      },
      // Its owner isn't in the team, and still sees it.
      ownerSees: await sees(admin.api),
      memberSees: await sees(member.api),
      outsiderSees: await sees(outsider.api),
      outsiderReads: await outcome(outsider.api.getDocument(saved.id)),
      outsiderWrites: await outcome(
        outsider.api.saveDocument({
          collectionId: collection.id,
          path: "budget.md",
          text: "# Mine",
          ifVersion: 1,
        })
      ),
    }).toStrictEqual({
      collection: { teams: [teamId], sensitive: true, source: "here" },
      ownerSees: true,
      memberSees: true,
      outsiderSees: false,
      outsiderReads: "knowledge.not_found",
      outsiderWrites: "knowledge.not_found",
    });
  });

  it("for everyone are read by all, and changed by their owner and admins", async () => {
    const admin = await knowledgeOf("admin");
    const otherAdmin = await knowledgeOf("admin");
    const person = await knowledgeOf("user");
    const { id: collectionId } = await admin.api.createCollection({
      name: "Handbook",
      description: "How we work.",
      access: "everyone",
    });
    const { id } = await admin.api.saveDocument({
      collectionId,
      path: "leave.md",
      text: leaveV1,
      ifVersion: 0,
    });
    const save = async (api: KnowledgeApi, ifVersion: number) =>
      await outcome(
        api.saveDocument({
          collectionId,
          path: "leave.md",
          text: leaveV2,
          ifVersion,
        })
      );

    const read = await person.api.getDocument(id);
    expect({
      read: read.title,
      personWrites: await save(person.api, 1),
      personRestores: await outcome(
        person.api.restoreVersion({ documentId: id, version: 1, ifVersion: 1 })
      ),
      otherAdminWrites: await save(otherAdmin.api, 1),
    }).toStrictEqual({
      read: "Leave policy",
      personWrites: "knowledge.forbidden",
      personRestores: "knowledge.forbidden",
      otherAdminWrites: "ok",
    });
  });

  it("can be shared only by admins; anyone can make a personal one", async () => {
    const builder = await knowledgeOf("builder");
    const admin = await knowledgeOf("admin");
    const events = await auditedDuring(async () => {
      await builder.api.createCollection(personal());
    });
    expect({
      personal: events.map(({ action, detail }) => ({ action, detail })),
      everyone: await outcome(
        builder.api.createCollection({ name: "All", access: "everyone" })
      ),
      unknownTeam: await refusal(
        admin.api.createCollection({
          name: "Ghosts",
          access: "teams",
          teams: ["no-such-team"],
        })
      ),
      sensitivePersonal: await outcome(
        builder.api.createCollection({ ...personal(), sensitive: true })
      ),
    }).toStrictEqual({
      personal: [
        {
          action: "knowledge.collection.created",
          detail: { access: "me", sensitive: false, source: "here" },
        },
      ],
      everyone: "knowledge.forbidden",
      unknownTeam: {
        code: "knowledge.invalid",
        issues: ["teams: there's no team no-such-team"],
      },
      sensitivePersonal: "knowledge.invalid",
    });
  });
});
