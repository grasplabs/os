import type { MemoryProposalInput } from "@grasp-os/shared/memory";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { proposeMemory } from "../src/knowledge/memory-proposals.ts";
import { forContext } from "../src/knowledge/memory.ts";
import { restrict } from "../src/restricted.ts";
import type { WorkContext } from "../src/restricted.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedInApi,
  unique,
} from "./sign-in.ts";

// Proposals: shared memory files (the company's AGENTS.md and MEMORY.md,
// an agent's own AGENTS.md) reach every agent, so an agent only proposes
// their new text and someone who can change the Memory collection decides.
// These tests start from the ways that can fail: a proposal changes the
// file before anyone approved it; someone who can't change the file
// approves it; an approval saves over a change made since, or lands with a
// decline at once; a proposal escapes the file's limit, or carries
// restricted data; an agent floods the owner with proposals; a decision is
// made twice or leaves no trace; and a warning about restricted content
// names a collection the editor can't see.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
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

/** A proposal by `authority`, working in `work`. */
const propose = async (
  authority: Authority,
  work: WorkContext,
  input: MemoryProposalInput
) => await proposeMemory(env, authority, work, input);

/** A proposal's status as stored, whoever may see it. */
const statusOf = async (proposalId: string): Promise<string | undefined> => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT status FROM memory_proposals WHERE id = ?"
  )
    .bind(proposalId)
    .first<{ status: string }>();
  return row?.status;
};

/** Whether the memory of an agent acting for `userId` has `text` now. */
const memoryHas = async (
  userId: string,
  work: WorkContext,
  text: string
): Promise<boolean> => {
  const memory = await forContext(env, actingFor(newAgent(), userId), work, {
    type: "own",
  });
  return memory.text.includes(text);
};

/** Whether `person` may decide on the proposal `proposalId` now. */
const isPending = async (
  person: Person,
  proposalId: string
): Promise<boolean> => {
  const proposals = await person.api.memory.proposals();
  return proposals.some(({ id }) => id === proposalId);
};

describe("a proposal to change the company MEMORY.md", setUpTime, () => {
  it("waits for someone who can change it, and then is its next version", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const agent = newAgent();
    const memory = await memoryOf(admin);
    const before = `We sell bikes. ${unique()}`;
    const after = `We sell bikes and scooters. ${unique()}`;
    const { id: documentId, currentVersion } = await saveOver(
      admin,
      memory,
      "MEMORY.md",
      before
    );
    const work = await newChat();
    const asAgent = actingFor(agent, user.userId);
    let proposalId = "";
    const proposed = await auditedDuring(async () => {
      const proposal = await propose(asAgent, work, {
        file: "MEMORY.md",
        text: after,
        message: "Scooters since May",
      });
      proposalId = proposal.id;
    });
    const adminsView = await admin.api.memory.proposals();
    const waiting = {
      memory: await memoryHas(user.userId, work, before),
      forUser: await user.api.memory.proposals(),
      userApproves: await outcome(user.api.memory.approve(proposalId)),
      userDeclines: await outcome(user.api.memory.decline(proposalId)),
      forAdmin: adminsView.find(({ id }) => id === proposalId),
    };
    let saved: Awaited<ReturnType<typeof admin.api.memory.approve>> | undefined;
    const decided = await auditedDuring(async () => {
      saved = await admin.api.memory.approve(proposalId);
    });
    const read = await admin.api.knowledge.getDocument(documentId);
    const agentActor = {
      type: "agent",
      agentId: agent.agentId,
      onBehalfOf: user.userId,
    };
    const adminActor = { type: "person", userId: admin.userId };
    const proposalTarget = { type: "proposal", id: proposalId };
    expect({
      waiting,
      saved: { id: saved?.id, version: saved?.currentVersion },
      text: read.version.text,
      message: read.version.message,
      author: read.version.author,
      memory: await memoryHas(user.userId, work, after),
      stillPending: await isPending(admin, proposalId),
      again: await outcome(admin.api.memory.approve(proposalId)),
      events: [...proposed, ...decided].map(({ actor, action, target }) => ({
        actor,
        action,
        target,
      })),
    }).toStrictEqual({
      waiting: {
        memory: true,
        forUser: [],
        userApproves: "knowledge.forbidden",
        userDeclines: "knowledge.forbidden",
        forAdmin: {
          id: proposalId,
          collectionId: memory,
          path: "MEMORY.md",
          baseVersion: currentVersion,
          text: after,
          message: "Scooters since May",
          source: { actor: agentActor, context: work },
          status: "pending",
          decidedBy: null,
          createdAt: adminsView.find(({ id }) => id === proposalId)?.createdAt,
          decidedAt: null,
        },
      },
      saved: { id: documentId, version: currentVersion + 1 },
      text: after,
      message: "Scooters since May",
      author: admin.userId,
      memory: true,
      stillPending: false,
      again: "knowledge.proposal_decided",
      events: [
        {
          actor: agentActor,
          action: "knowledge.proposal.created",
          target: proposalTarget,
        },
        {
          actor: adminActor,
          action: "knowledge.document.saved",
          target: { type: "document", id: documentId },
        },
        {
          actor: adminActor,
          action: "knowledge.proposal.approved",
          target: proposalTarget,
        },
      ],
    });
  });

  it("is declined without changing the file, once", async () => {
    const admin = await personOf("admin");
    const memory = await memoryOf(admin);
    const text = `Unchanged ${unique()}`;
    await saveOver(admin, memory, "MEMORY.md", text);
    const work = await newChat();
    const proposal = await propose(actingFor(newAgent(), admin.userId), work, {
      file: "MEMORY.md",
      text: "Changed",
    });
    const events = await auditedDuring(async () => {
      await admin.api.memory.decline(proposal.id);
    });
    expect({
      memory: await memoryHas(admin.userId, work, text),
      events: events.map(({ action, target }) => ({ action, target })),
      again: await Promise.all([
        outcome(admin.api.memory.decline(proposal.id)),
        outcome(admin.api.memory.approve(proposal.id)),
      ]),
      unknown: await outcome(admin.api.memory.approve(crypto.randomUUID())),
    }).toStrictEqual({
      memory: true,
      events: [
        {
          action: "knowledge.proposal.declined",
          target: { type: "proposal", id: proposal.id },
        },
      ],
      again: ["knowledge.proposal_decided", "knowledge.proposal_decided"],
      unknown: "knowledge.not_found",
    });
  });

  it("never saves over a change made since it was proposed", async () => {
    const admin = await personOf("admin");
    const memory = await memoryOf(admin);
    await saveOver(admin, memory, "MEMORY.md", `Base ${unique()}`);
    const work = await newChat();
    const asAgent = actingFor(newAgent(), admin.userId);
    const first = await propose(asAgent, work, {
      file: "MEMORY.md",
      text: "First",
    });
    const second = await propose(asAgent, work, {
      file: "MEMORY.md",
      text: "Second",
    });
    await admin.api.memory.approve(first.id);
    expect({
      second: await outcome(admin.api.memory.approve(second.id)),
      pending: await isPending(admin, second.id),
      memory: await memoryHas(admin.userId, work, "First"),
    }).toStrictEqual({
      second: "knowledge.conflict",
      pending: true,
      memory: true,
    });
  });

  it("is either approved and saved, or declined and not, when both happen at once", async () => {
    const admin = await personOf("admin");
    const other = await personOf("admin");
    const memory = await memoryOf(admin);
    const work = await newChat();
    const asAgent = actingFor(newAgent(), admin.userId);
    const outcomes: { saved: boolean; status: string | undefined }[] = [];
    for (let round = 0; round < 5; round += 1) {
      const base = `Base ${unique()}`;
      const proposed = `Proposed ${unique()}`;
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      await saveOver(admin, memory, "MEMORY.md", base);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const { id } = await propose(asAgent, work, {
        file: "MEMORY.md",
        text: proposed,
      });
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const [approved, declined] = await Promise.all([
        outcome(admin.api.memory.approve(id)),
        outcome(other.api.memory.decline(id)),
      ]);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const status = await statusOf(id);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const saved = await memoryHas(admin.userId, work, proposed);
      const consistent =
        (approved === "ok" &&
          declined === "knowledge.proposal_decided" &&
          status === "approved" &&
          saved) ||
        (declined === "ok" &&
          approved === "knowledge.proposal_decided" &&
          status === "declined" &&
          !saved);
      outcomes.push({ saved: consistent, status });
    }
    expect(outcomes.every(({ saved }) => saved)).toBeTruthy();
  });

  it("is checked against the file's limit again when approved", async () => {
    const admin = await personOf("admin");
    const memory = await memoryOf(admin);
    await saveOver(admin, memory, "MEMORY.md", `Base ${unique()}`);
    const work = await newChat();
    const { id } = await propose(actingFor(newAgent(), admin.userId), work, {
      file: "MEMORY.md",
      text: "Longer than four characters",
    });
    // The limit lowered to 1 token (4 characters) since it was proposed.
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, MEMORY_LIMITS: { "MEMORY.md": 1 } },
    });
    const lowered = core.authenticate();
    expect({
      approved: await outcome(lowered.memory.approve(id)),
      status: await statusOf(id),
    }).toStrictEqual({
      approved: "knowledge.memory_too_large",
      status: "pending",
    });
  });
});

describe("proposals", setUpTime, () => {
  it("change an agent's own AGENTS.md once approved", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    await memoryOf(admin);
    const work = await newChat();
    const asAgent = actingFor(agent, admin.userId);
    const text = `Answer in Dutch. ${unique()}`;
    const proposal = await propose(asAgent, work, { file: "agent", text });
    await admin.api.memory.approve(proposal.id);
    const direct = await forContext(env, asAgent, work, { type: "direct" });
    expect({
      path: proposal.path,
      baseVersion: proposal.baseVersion,
      files: direct.files.map(({ source }) => source).includes("agent"),
      text: direct.text.includes(text),
    }).toStrictEqual({
      path: `agents/${agent.agentId}/AGENTS.md`,
      baseVersion: 0,
      files: true,
      text: true,
    });
  });

  it("are checked as a save is, and only an agent makes one", async () => {
    const admin = await personOf("admin");
    await memoryOf(admin);
    const asAgent = actingFor(newAgent(), admin.userId);
    const work = await newChat();
    const restricted = await newChat();
    await restrict(env, asAgent, restricted, []);
    const outcomeOf = async (authority: Authority, input: unknown) =>
      await outcome(proposeMemory(env, authority, work, input));
    await expect(
      Promise.all([
        // Over MEMORY.md's 2,000 tokens.
        outcomeOf(asAgent, { file: "MEMORY.md", text: "x".repeat(8001) }),
        outcomeOf(asAgent, { file: "MEMORY.md", text: "---\ntype: nope\n---" }),
        outcomeOf(asAgent, { file: "USER.md", text: "Not shared" }),
        outcomeOf(
          actingFor({ type: "app", appId: `app-${unique()}` }, admin.userId),
          { file: "MEMORY.md", text: "From an App" }
        ),
        outcomeOf(actingFor(newAgent(), `gone-${unique()}`), {
          file: "MEMORY.md",
          text: "Gone",
        }),
        outcome(
          proposeMemory(
            { ...env, FEATURES: { knowledge: true } },
            asAgent,
            work,
            { file: "MEMORY.md", text: "Off" }
          )
        ),
        // Shared memory would carry restricted data to everyone.
        outcome(
          proposeMemory(env, asAgent, restricted, {
            file: "MEMORY.md",
            text: "From a restricted chat",
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "knowledge.memory_too_large",
      "knowledge.invalid",
      "knowledge.invalid",
      "permission.denied",
      "permission.person_inactive",
      "feature.disabled",
      "permission.restricted",
    ]);
  });

  it("wait at most 20 at a time from one agent", async () => {
    const admin = await personOf("admin");
    await memoryOf(admin);
    const work = await newChat();
    const asAgent = actingFor(newAgent(), admin.userId);
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one proposal at a time
      const { id } = await propose(asAgent, work, {
        file: "MEMORY.md",
        text: `Proposal ${index}`,
      });
      ids.push(id);
    }
    const next = { file: "MEMORY.md", text: "One more" } as const;
    const overCap = await outcome(propose(asAgent, work, next));
    // Another agent has a count of its own.
    const otherAgent = await outcome(
      propose(actingFor(newAgent(), admin.userId), work, next)
    );
    await admin.api.memory.decline(ids[0] ?? "");
    expect({
      overCap,
      otherAgent,
      afterDecline: await outcome(propose(asAgent, work, next)),
    }).toStrictEqual({
      overCap: "knowledge.too_many_proposals",
      otherAgent: "ok",
      afterDecline: "ok",
    });
  });
});

describe("memory warnings", setUpTime, () => {
  it("name the sensitive collections some text mentions, of those the person may read", async () => {
    const admin = await personOf("admin");
    const outsider = await personOf("admin");
    const team = await newTeam(admin, [admin]);
    const name = `Payroll ${unique()}`;
    const { id } = await admin.api.knowledge.createCollection({
      name,
      access: "teams",
      teams: [team],
      sensitive: true,
    });
    await admin.api.knowledge.createCollection({
      name: `Holidays ${unique()}`,
      access: "teams",
      teams: [team],
    });
    const text = `Salaries are in ${name.toUpperCase()}.`;
    expect({
      byName: await admin.api.memory.warnings(text),
      byId: await admin.api.memory.warnings(`See ${id}`),
      insideWord: await admin.api.memory.warnings(`See ${name}x`),
      none: await admin.api.memory.warnings("Nothing sensitive here"),
      // An admin outside the team can't read it, so isn't told of it.
      outsider: await outsider.api.memory.warnings(text),
    }).toStrictEqual({
      byName: [{ collectionId: id, name }],
      byId: [{ collectionId: id, name }],
      insideWord: [],
      none: [],
      outsider: [],
    });
  });
});
