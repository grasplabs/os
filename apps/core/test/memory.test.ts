import type { Memory, MemoryContext } from "@grasp-os/shared/memory";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { forContext, saveUserMemory } from "../src/knowledge/memory.ts";
import { restrict } from "../src/restricted.ts";
import type { WorkContext } from "../src/restricted.ts";
import { release } from "./apps.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Memory: the files an agent always has in its context. These tests start
// from the ways it can fail: a context gets a file its rule leaves out,
// above all a USER.md in a channel, where others would see it through the
// agent; one person's USER.md reaches another's agent; a memory file grows
// past its limit and crowds the agent's context; a cached memory outlives
// the file it was made from; an agent writes memory it shouldn't, or
// carries restricted data into memory; and a read of memory leaves no
// trace in the audit log.

const idp = mockIdp();

/** Signing people in and releasing Apps can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const personOf = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personOf>>;

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

/** The Memory collection, as an admin sets it up. */
const memoryOf = async (admin: Person): Promise<string> => {
  const { memory } = await admin.api.memory.collections();
  if (memory === null) {
    throw new Error("An admin gets the Memory collection");
  }
  return memory;
};

/** Saves `text` at `path` over whatever version is there now. */
const saveOver = async (
  person: Person,
  collectionId: string,
  path: string,
  text: string
) => {
  const { documents } = await person.api.knowledge.listDocuments(collectionId);
  const current = documents.find((document) => document.path === path);
  return await person.api.knowledge.saveDocument({
    collectionId,
    path,
    text,
    ifVersion: current?.currentVersion ?? 0,
  });
};

/** A USER.md saved by `agent` for `person`, over what is there now. */
const userMemory = async (
  authority: Authority,
  work: WorkContext,
  text: string,
  ifVersion = 0
) =>
  await saveUserMemory(
    env,
    authority,
    work,
    { type: "own" },
    {
      text,
      ifVersion,
    }
  );

/** How a first USER.md, saved as `authority` in `work` and `context`, ends. */
const firstSave = async (
  authority: Authority,
  work: WorkContext,
  context: MemoryContext
): Promise<string> =>
  await outcome(
    saveUserMemory(env, authority, work, context, { text: "x", ifVersion: 0 })
  );

/** Which files a memory holds, as `source name`, in order. */
const filesOf = (memory: Memory): string[] =>
  memory.files.map(({ source, name }) => `${source} ${name}`);

/** Which of `markers` a memory's text holds. */
const markersIn = (memory: Memory, markers: Record<string, string>) =>
  Object.entries(markers)
    .filter(([, marker]) => memory.text.includes(marker))
    .map(([name]) => name);

/** The IDs of the collections `person` may read. */
const collectionsOf = async (person: Person): Promise<string[]> => {
  const listed = await person.api.knowledge.listCollections();
  return listed.map(({ id }) => id);
};

/** `characters` characters of text. */
const sized = (characters: number): string => "x".repeat(characters);

describe("memory collections", setUpTime, () => {
  it("give each person their own collection, and only admins set up the company's", async () => {
    const user = await personOf("user");
    const other = await personOf("user");
    const admin = await personOf("admin");
    const before = await user.api.memory.collections();
    const memory = await memoryOf(admin);
    const after = await user.api.memory.collections();
    const usersOwn = await collectionsOf(user);
    const othersOwn = await collectionsOf(other);
    expect({
      before: before.memory,
      after: after.memory,
      samePersonal: after.personal === before.personal,
      ownPersonal: usersOwn.includes(before.personal),
      othersPersonal: othersOwn.includes(before.personal),
      othersCanRead: othersOwn.includes(memory),
      userCanSave: await outcome(
        saveOver(user, memory, "MEMORY.md", "# Company")
      ),
    }).toStrictEqual({
      before: null,
      after: "memory",
      samePersonal: true,
      ownPersonal: true,
      othersPersonal: false,
      othersCanRead: true,
      userCanSave: "knowledge.forbidden",
    });
  });
});

describe("memory for a context", setUpTime, () => {
  it("holds exactly the files of that context's rule, and never a USER.md in a channel", async () => {
    const admin = await personOf("admin");
    const builder = await personOf("builder");
    const other = await personOf("user");
    const agent = newAgent();
    const otherAgent = newAgent();
    const u = unique();
    const markers = {
      companyAgents: `company-agents-${u}`,
      companyMemory: `company-memory-${u}`,
      agent: `agent-${u}`,
      otherAgent: `other-agent-${u}`,
      app: `app-${u}`,
      user: `user-${u}`,
      otherUser: `other-user-${u}`,
    };
    const memory = await memoryOf(admin);
    await saveOver(admin, memory, "AGENTS.md", markers.companyAgents);
    await saveOver(admin, memory, "MEMORY.md", markers.companyMemory);
    await saveOver(
      admin,
      memory,
      `agents/${agent.agentId}/AGENTS.md`,
      markers.agent
    );
    await saveOver(
      admin,
      memory,
      `agents/${otherAgent.agentId}/AGENTS.md`,
      markers.otherAgent
    );
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    await release(builder, appId, { "AGENTS.md": markers.app });
    const work = await newChat();
    const asAgent = actingFor(agent, builder.userId);
    await userMemory(asAgent, work, markers.user);
    await userMemory(actingFor(agent, other.userId), work, markers.otherUser);

    const contexts: Record<string, MemoryContext> = {
      own: { type: "own" },
      ownOnApp: { type: "own", appId },
      direct: { type: "direct" },
      channel: { type: "channel" },
      workflow: { type: "workflow" },
    };
    const results: Record<string, { files: string[]; markers: string[] }> = {};
    for (const [name, context] of Object.entries(contexts)) {
      // oxlint-disable-next-line no-await-in-loop -- one context at a time
      const found = await forContext(env, asAgent, work, context);
      results[name] = {
        files: filesOf(found),
        markers: markersIn(found, markers),
      };
    }
    // The other person's agent, in the same channel: still no USER.md.
    const otherInChannel = await forContext(
      env,
      actingFor(agent, other.userId),
      work,
      { type: "channel" }
    );
    const company = ["company AGENTS.md", "company MEMORY.md"];
    expect({
      ...results,
      otherInChannel: markersIn(otherInChannel, markers),
    }).toStrictEqual({
      own: {
        files: [...company, "user USER.md"],
        markers: ["companyAgents", "companyMemory", "user"],
      },
      ownOnApp: {
        files: [...company, "app AGENTS.md", "user USER.md"],
        markers: ["companyAgents", "companyMemory", "app", "user"],
      },
      direct: {
        files: [...company, "agent AGENTS.md", "user USER.md"],
        markers: ["companyAgents", "companyMemory", "agent", "user"],
      },
      channel: {
        files: [...company, "agent AGENTS.md"],
        markers: ["companyAgents", "companyMemory", "agent"],
      },
      workflow: { files: [], markers: [] },
      otherInChannel: ["companyAgents", "companyMemory", "agent"],
    });
  });

  it("puts each file in its own block, company files first", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const memory = await memoryOf(admin);
    const u = unique();
    await saveOver(admin, memory, "AGENTS.md", `Be brief. ${u}`);
    await saveOver(admin, memory, "MEMORY.md", `We are Acme. ${u}`);
    const work = await newChat();
    const asAgent = actingFor(agent, admin.userId);
    await userMemory(asAgent, work, `Call me Sam. ${u}`);
    const found = await forContext(env, asAgent, work, { type: "own" });
    expect(found.text).toBe(
      [
        `<memory source="company" file="AGENTS.md">\nBe brief. ${u}\n</memory>`,
        `<memory source="company" file="MEMORY.md">\nWe are Acme. ${u}\n</memory>`,
        `<memory source="user" file="USER.md">\nCall me Sam. ${u}\n</memory>`,
      ].join("\n\n")
    );
  });

  it("refuses a context that isn't one, or that the agent or person can't be in", async () => {
    const user = await personOf("user");
    const agent = newAgent();
    const app = { type: "app" as const, appId: `app-${unique()}` };
    const work = await newChat();
    const asAgent = actingFor(agent, user.userId);
    const asApp = actingFor(app, user.userId);
    await expect(
      Promise.all([
        outcome(forContext(env, asAgent, work, { type: "group" })),
        outcome(forContext(env, asAgent, work, { type: "own", extra: 1 })),
        outcome(forContext(env, asApp, work, { type: "direct" })),
        outcome(forContext(env, asApp, work, { type: "channel" })),
        // Only people who can read an App's code work on it.
        outcome(
          forContext(env, asAgent, work, { type: "own", appId: "some-app" })
        ),
        outcome(
          forContext(env, actingFor(agent, `gone-${unique()}`), work, {
            type: "own",
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "knowledge.invalid",
      "knowledge.invalid",
      "permission.context_invalid",
      "permission.context_invalid",
      "role.forbidden",
      "permission.person_inactive",
    ]);
  });

  it("is the same, under the same key, until one of its files has a new version", async () => {
    const admin = await personOf("admin");
    const first = await personOf("user");
    const second = await personOf("user");
    const agent = newAgent();
    const memory = await memoryOf(admin);
    await saveOver(admin, memory, "AGENTS.md", `Agents ${unique()}`);
    await saveOver(admin, memory, "MEMORY.md", `Before ${unique()}`);
    const work = await newChat();
    const asFirst = actingFor(agent, first.userId);
    const own = { type: "own" } as const;
    const read = async (authority: Authority) =>
      await forContext(env, authority, work, own);

    const initial = await read(asFirst);
    const again = await read(asFirst);
    // Two people with the same files share their memory, and its key.
    const withoutUser = await read(actingFor(agent, second.userId));
    const userSaved = await userMemory(asFirst, work, "Likes tea.");
    const afterUser = await read(asFirst);
    await saveOver(admin, memory, "MEMORY.md", "After");
    const afterCompany = await read(asFirst);
    // A lower limit cuts a file saved within the old one.
    const lowered = await forContext(
      { ...env, MEMORY_LIMITS: { "MEMORY.md": 1 } },
      asFirst,
      work,
      own
    );
    expect({
      again: again.key === initial.key && again.text === initial.text,
      shared: withoutUser.key === initial.key,
      afterUser: {
        newKey: afterUser.key !== initial.key,
        text: afterUser.text.includes("Likes tea."),
        version: afterUser.files.at(-1),
      },
      afterCompany: {
        newKey: afterCompany.key !== afterUser.key,
        text: afterCompany.text.includes("After"),
      },
      lowered: {
        newKey: lowered.key !== afterCompany.key,
        cut: lowered.files.map(({ cut }) => cut),
        text: lowered.text.includes(
          '<memory source="company" file="MEMORY.md" cut="true">\nAfte\n</memory>'
        ),
      },
    }).toStrictEqual({
      again: true,
      shared: true,
      afterUser: {
        newKey: true,
        text: true,
        version: {
          source: "user",
          name: "USER.md",
          documentId: userSaved.id,
          appId: null,
          version: 1,
          cut: false,
        },
      },
      afterCompany: { newKey: true, text: true },
      lowered: { newKey: true, cut: [false, true, false], text: true },
    });
  });

  it("is recorded in the audit log on every read, cached or not, with the files it read", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const memory = await memoryOf(admin);
    const work = await newChat();
    const asAgent = actingFor(agent, admin.userId);
    await saveOver(admin, memory, "AGENTS.md", `Agents ${unique()}`);
    const saved = await userMemory(asAgent, work, "Prefers Dutch.");
    let found: Memory | undefined;
    const events = await auditedDuring(async () => {
      await forContext(env, asAgent, work, { type: "own" });
      found = await forContext(env, asAgent, work, { type: "own" });
      // A workflow step reads nothing, so nothing is recorded.
      await forContext(env, asAgent, work, { type: "workflow" });
    });
    const documentIds = found?.files.map(({ documentId }) => documentId) ?? [];
    const read = {
      actor: {
        type: "agent",
        agentId: agent.agentId,
        onBehalfOf: admin.userId,
      },
      action: "knowledge.read",
      provenance: [memory, saved.collectionId, ...documentIds],
      detail: { read: "memory", context: "own", sensitive: false },
    };
    expect({
      documentIds: documentIds.includes(saved.id),
      events: events.map(({ actor, action, provenance, detail }) => ({
        actor,
        action,
        provenance,
        detail,
      })),
      provenance: found?.provenance,
    }).toStrictEqual({
      documentIds: true,
      events: [read, read],
      provenance: {
        collectionIds: [memory, saved.collectionId],
        sensitive: false,
        restricted: false,
      },
    });
  });

  it("is empty while memory is switched off", async () => {
    const admin = await personOf("admin");
    const memory = await memoryOf(admin);
    await saveOver(admin, memory, "AGENTS.md", `On ${unique()}`);
    const found = await forContext(
      { ...env, FEATURES: { knowledge: true } },
      actingFor(newAgent(), admin.userId),
      await newChat(),
      { type: "own" }
    );
    expect({ files: found.files, text: found.text }).toStrictEqual({
      files: [],
      text: "",
    });
  });
});

describe("memory limits", setUpTime, () => {
  it("refuse a save over a memory file's limit, and only a memory file's", async () => {
    const admin = await personOf("admin");
    const builder = await personOf("builder");
    const memory = await memoryOf(admin);
    const { personal } = await admin.api.memory.collections();
    const { id: notes } = await admin.api.knowledge.createCollection({
      name: `Notes ${unique()}`,
      access: "me",
    });
    const { id: appId } = await builder.api.apps.create({ name: "Desk" });
    // AGENTS.md and MEMORY.md at their default, 2,000 tokens (8,000
    // characters); USER.md set to 500 (2,000 characters, vite.config.ts).
    const saves = {
      companyAgents: await outcome(
        saveOver(admin, memory, "AGENTS.md", sized(8001))
      ),
      companyMemory: await outcome(
        saveOver(admin, memory, "MEMORY.md", sized(8001))
      ),
      agent: await outcome(
        saveOver(admin, memory, `agents/${unique()}/AGENTS.md`, sized(8001))
      ),
      user: await outcome(saveOver(admin, personal, "USER.md", sized(2001))),
      appCode: await outcome(
        builder.api.apps.files.write(appId, { "AGENTS.md": sized(8001) })
      ),
      atLimit: await outcome(saveOver(admin, memory, "MEMORY.md", sized(8000))),
      userAtLimit: await outcome(
        saveOver(admin, personal, "USER.md", sized(2000))
      ),
      appCodeAtLimit: await outcome(
        builder.api.apps.files.write(appId, { "AGENTS.md": sized(8000) })
      ),
      // Not memory files: another collection's, another path in the App.
      elsewhere: await outcome(saveOver(admin, notes, "USER.md", sized(9000))),
      otherDocument: await outcome(
        saveOver(admin, memory, "notes.md", sized(9000))
      ),
      appOtherFile: await outcome(
        builder.api.apps.files.write(appId, { "docs/AGENTS.md": sized(9000) })
      ),
    };
    const refused = await admin.api.knowledge
      .saveDocument({
        collectionId: personal,
        path: "USER.md",
        text: sized(2001),
        ifVersion: 1,
      })
      .then(
        () => {},
        (error: unknown) => error
      );
    expect({
      saves,
      details:
        typeof refused === "object" && refused !== null && "details" in refused
          ? refused.details
          : refused,
    }).toStrictEqual({
      saves: {
        companyAgents: "knowledge.memory_too_large",
        companyMemory: "knowledge.memory_too_large",
        agent: "knowledge.memory_too_large",
        user: "knowledge.memory_too_large",
        appCode: "knowledge.memory_too_large",
        atLimit: "ok",
        userAtLimit: "ok",
        appCodeAtLimit: "ok",
        elsewhere: "ok",
        otherDocument: "ok",
        appOtherFile: "ok",
      },
      details: {
        file: "USER.md",
        tokens: 501,
        maxTokens: 500,
        maxCharacters: 2000,
      },
    });
  });

  it("refuse an agent's USER.md over its limit", async () => {
    const user = await personOf("user");
    const asAgent = actingFor(newAgent(), user.userId);
    const work = await newChat();
    await expect(
      Promise.all([
        outcome(userMemory(asAgent, work, sized(2001))),
        outcome(userMemory(asAgent, work, sized(2000))),
      ])
    ).resolves.toStrictEqual(["knowledge.memory_too_large", "ok"]);
  });
});

describe("an agent's USER.md", setUpTime, () => {
  it("is saved by the agent for its own person, who sees it and its history", async () => {
    const user = await personOf("user");
    const other = await personOf("user");
    const agent = newAgent();
    const asAgent = actingFor(agent, user.userId);
    const work = await newChat();
    let first: Awaited<ReturnType<typeof userMemory>> | undefined;
    const events = await auditedDuring(async () => {
      first = await userMemory(asAgent, work, "Works in Utrecht.");
    });
    const second = await saveUserMemory(
      env,
      asAgent,
      work,
      { type: "direct" },
      { text: "Works in Utrecht. Likes tea.", ifVersion: 1, message: "Tea" }
    );
    const { personal } = await user.api.memory.collections();
    const read = await user.api.knowledge.getDocument(second.id);
    const history = await user.api.knowledge.history(second.id);
    const agentActor = {
      type: "agent",
      agentId: agent.agentId,
      onBehalfOf: user.userId,
    };
    expect({
      collection: first?.collectionId === personal,
      text: read.version.text,
      history: history.versions.map(({ number, author, message }) => ({
        number,
        author,
        message,
      })),
      events: events.map(({ actor, action, target }) => ({
        actor,
        action,
        target,
      })),
      otherReads: await outcome(other.api.knowledge.getDocument(second.id)),
      stale: await outcome(userMemory(asAgent, work, "Old", 1)),
    }).toStrictEqual({
      collection: true,
      text: "Works in Utrecht. Likes tea.",
      history: [
        { number: 2, author: user.userId, message: "Tea" },
        { number: 1, author: user.userId, message: null },
      ],
      events: [
        {
          actor: agentActor,
          action: "knowledge.collection.created",
          target: { type: "collection", id: personal },
        },
        {
          actor: agentActor,
          action: "knowledge.document.saved",
          target: { type: "document", id: second.id },
        },
      ],
      otherReads: "knowledge.not_found",
      stale: "knowledge.conflict",
    });
  });

  it("is refused where it isn't the agent's to write, or would carry restricted data", async () => {
    const user = await personOf("user");
    const agent = newAgent();
    const asAgent = actingFor(agent, user.userId);
    const asApp = actingFor(
      { type: "app", appId: `app-${unique()}` },
      user.userId
    );
    const work = await newChat();
    const restricted = await newChat();
    await restrict(env, asAgent, restricted, []);
    await expect(
      Promise.all([
        firstSave(asAgent, work, { type: "channel" }),
        firstSave(asAgent, work, { type: "workflow" }),
        firstSave(asApp, work, { type: "own" }),
        firstSave(asAgent, restricted, { type: "own" }),
        firstSave(actingFor(agent, `gone-${unique()}`), work, { type: "own" }),
        outcome(
          saveUserMemory(
            { ...env, FEATURES: { knowledge: true } },
            asAgent,
            work,
            { type: "own" },
            { text: "x", ifVersion: 0 }
          )
        ),
      ])
    ).resolves.toStrictEqual([
      "permission.denied",
      "permission.denied",
      "permission.denied",
      "permission.restricted",
      "permission.person_inactive",
      "feature.disabled",
    ]);
  });
});
