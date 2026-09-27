import { actorOf, delegateActorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  appIdSchema,
  collectionIdSchema,
  documentIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { DocumentSummary, Provenance } from "@grasp-os/shared/knowledge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import {
  memoryCharactersPerToken,
  memoryContextSchema,
  memoryTokens,
  userMemoryInputSchema,
} from "@grasp-os/shared/memory";
import type {
  Memory,
  MemoryCollections,
  MemoryFile,
  MemoryFileName,
  MemorySource,
} from "@grasp-os/shared/memory";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { findApp, versionFiles } from "../apps.ts";
import { memberRole } from "../auth/identity.ts";
import { collections, documents, versions } from "../db/knowledge/schema.ts";
import { featureEnabled, requireFeature } from "../features.ts";
import { isRestricted } from "../restricted.ts";
import type { WorkContext } from "../restricted.ts";
import { noteProvenance, readableForPerson } from "./access.ts";
import { ensureCollection } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { writeVersion } from "./documents.ts";
import {
  agentMemoryPath,
  appMemoryPath,
  memoryCollectionId,
  memoryLimit,
  personalCollectionId,
} from "./memory-files.ts";

// An agent's memory: the files it always has in its context, by where it
// works. The agent loop calls `forContext` for the memory of each turn,
// and `saveUserMemory` when the agent changes what it knows about its
// person. What each context gets:
//
// - a person's own chat: the company's AGENTS.md and MEMORY.md, their
//   USER.md, and the App's AGENTS.md when they're working on one;
// - an agent in a direct message: the company files, the agent's
//   AGENTS.md and that person's USER.md;
// - an agent in a shared channel: the company files and the agent's
//   AGENTS.md, never a USER.md, which others there would see through it;
// - a workflow's AI step: nothing, so a run does the same whoever's
//   memory changed.
//
// Memory is read for the person the agent acts for, without a permission:
// only what that person may read themselves (access.ts), which for these
// collections is the company's (for everyone) and their own. Each read
// goes through `noteProvenance`, as any Knowledge read does: recorded in
// the audit log, and restricting the context if any of it were sensitive
// (neither memory collection can be).

/** The provenance of memory that holds no Knowledge document. */
const noProvenance: Provenance = {
  collectionIds: [],
  sensitive: false,
  restricted: false,
};

/** A memory file a context gets, if it exists, and where it is. */
interface Wanted {
  source: MemorySource;
  name: MemoryFileName;
  /** A document's place, or the App whose code has it. */
  at: { collectionId: string; path: string } | { appId: AppId };
}

const companyFiles: Wanted[] = [
  {
    source: "company",
    name: "AGENTS.md",
    at: { collectionId: memoryCollectionId, path: "AGENTS.md" },
  },
  {
    source: "company",
    name: "MEMORY.md",
    at: { collectionId: memoryCollectionId, path: "MEMORY.md" },
  },
];

const contextInvalid = () =>
  permissionErrors.create("permission.context_invalid");

/** The agent `authority` names; one in a direct message or a channel. */
const agentOf = (authority: Authority): string => {
  if (authority.subject.type !== "agent") {
    throw contextInvalid();
  }
  return authority.subject.agentId;
};

/** The agent's own AGENTS.md. */
const agentFile = (authority: Authority): Wanted => ({
  source: "agent",
  name: "AGENTS.md",
  at: {
    collectionId: memoryCollectionId,
    path: agentMemoryPath(agentOf(authority)),
  },
});

/** The USER.md of the person `authority` acts for. */
const userFile = async (authority: Authority): Promise<Wanted> => ({
  source: "user",
  name: "USER.md",
  at: {
    collectionId: await personalCollectionId(authority.onBehalfOf),
    path: "USER.md",
  },
});

/** The files `context` gets, in the order its memory has them. */
const wantedFor = async (
  authority: Authority,
  context: ReturnType<typeof memoryContextSchema.parse>
): Promise<Wanted[]> => {
  if (context.type === "workflow") {
    return [];
  }
  if (context.type === "channel") {
    return [...companyFiles, agentFile(authority)];
  }
  if (context.type === "direct") {
    return [...companyFiles, agentFile(authority), await userFile(authority)];
  }
  const app: Wanted[] =
    context.appId === undefined
      ? []
      : [{ source: "app", name: "AGENTS.md", at: { appId: context.appId } }];
  return [...companyFiles, ...app, await userFile(authority)];
};

/** A file found for a context: its version now, and where it is. */
interface Found {
  wanted: Wanted;
  documentId: string | null;
  collection: { id: string; sensitive: boolean } | null;
  version: number;
}

/**
 * The files of `wanted` that exist and that the person `userId` may read,
 * with their versions now, in `wanted`'s order. An App's AGENTS.md needs
 * the person to be able to read the App's code: an admin or a builder.
 */
const findFiles = async (
  env: Env,
  userId: string,
  wanted: Wanted[]
): Promise<Found[]> => {
  const role = await memberRole(env.DB, userId);
  if (!role) {
    throw permissionErrors.create("permission.person_inactive");
  }
  const places = wanted.flatMap(({ at }) => ("path" in at ? [at] : []));
  const db = drizzle(env.KNOWLEDGE);
  const rows =
    places.length === 0
      ? []
      : await db
          .select({
            id: documents.id,
            collectionId: documents.collectionId,
            path: documents.path,
            version: documents.currentVersion,
            sensitive: collections.sensitive,
          })
          .from(documents)
          .innerJoin(collections, eq(collections.id, documents.collectionId))
          .where(
            and(
              or(
                ...places.map(({ collectionId, path }) =>
                  and(
                    eq(documents.collectionId, collectionId),
                    eq(documents.path, path)
                  )
                )
              ),
              await readableForPerson(env, db, userId)
            )
          );
  const found: Found[] = [];
  for (const file of wanted) {
    const { at } = file;
    if ("path" in at) {
      const row = rows.find(
        ({ collectionId, path }) =>
          collectionId === at.collectionId && path === at.path
      );
      if (row) {
        found.push({
          wanted: file,
          documentId: row.id,
          collection: { id: row.collectionId, sensitive: row.sensitive },
          version: row.version,
        });
      }
      continue;
    }
    if (!canBuild(role)) {
      throw roleErrors.create("role.forbidden");
    }
    // oxlint-disable-next-line no-await-in-loop -- at most one App per context
    const app = await findApp(env, at.appId);
    if (app.currentVersion !== null) {
      found.push({
        wanted: file,
        documentId: null,
        collection: null,
        version: app.currentVersion,
      });
    }
  }
  return found;
};

/**
 * Assembled memory by the versions of its files and their limits.
 * Versions never change, so an entry is right for as long as it is kept,
 * and a new version of any file is a new key. Per isolate, kept to the
 * latest {@link cacheMaxEntries}.
 */
const assembled = new Map<string, { files: MemoryFile[]; text: string }>();

const cacheMaxEntries = 100;

const remember = (
  key: string,
  entry: { files: MemoryFile[]; text: string }
): void => {
  assembled.delete(key);
  assembled.set(key, entry);
  for (const oldest of assembled.keys()) {
    if (assembled.size <= cacheMaxEntries) {
      break;
    }
    assembled.delete(oldest);
  }
};

/**
 * `text` cut to `maxCharacters`, never through a surrogate pair. Memory
 * saved within its limit never is; one saved before its limit was lowered,
 * or an App's, can be.
 */
const cutTo = (text: string, maxCharacters: number): string => {
  const cut = text.slice(0, maxCharacters);
  const last = cut.codePointAt(cut.length - 1) ?? 0;
  const highSurrogate = last >= 0xd8_00 && last <= 0xdb_ff;
  return highSurrogate ? cut.slice(0, -1) : cut;
};

/**
 * The texts of `found`, at the versions found; `undefined` for an App
 * whose code has no AGENTS.md.
 */
const textsOf = async (
  env: Env,
  found: Found[]
): Promise<(string | undefined)[]> => {
  const documentVersions = found.flatMap(({ documentId, version }) =>
    documentId === null ? [] : [{ documentId, version }]
  );
  const db = drizzle(env.KNOWLEDGE);
  const rows =
    documentVersions.length === 0
      ? []
      : await db
          .select({
            documentId: versions.documentId,
            number: versions.number,
            text: versions.text,
          })
          .from(versions)
          .where(
            or(
              ...documentVersions.map(({ documentId, version }) =>
                and(
                  eq(versions.documentId, documentId),
                  eq(versions.number, version)
                )
              )
            )
          );
  return await Promise.all(
    found.map(async ({ wanted: { at }, documentId, version }) => {
      if (!("appId" in at)) {
        return (
          rows.find(
            (row) => row.documentId === documentId && row.number === version
          )?.text ?? ""
        );
      }
      const files = await versionFiles(env, at.appId, version);
      return files[appMemoryPath];
    })
  );
};

/** `found`'s files and their texts, each cut to its limit, as one text. */
const assemble = async (
  env: Env,
  found: Found[]
): Promise<{ files: MemoryFile[]; text: string }> => {
  const texts = await textsOf(env, found);
  const files: MemoryFile[] = [];
  const blocks: string[] = [];
  for (const [index, { wanted, documentId, version }] of found.entries()) {
    const text = texts[index];
    if (text === undefined) {
      continue;
    }
    const limit = memoryLimit(env, wanted.name);
    const cut = memoryTokens(text) > limit;
    files.push({
      source: wanted.source,
      name: wanted.name,
      documentId:
        documentId === null ? null : documentIdSchema.parse(documentId),
      appId: "appId" in wanted.at ? appIdSchema.parse(wanted.at.appId) : null,
      version,
      cut,
    });
    const body = cut ? cutTo(text, limit * memoryCharactersPerToken) : text;
    blocks.push(
      `<memory source="${wanted.source}" file="${wanted.name}"${cut ? ' cut="true"' : ""}>\n${body}\n</memory>`
    );
  }
  return { files, text: blocks.join("\n\n") };
};

/**
 * The memory of an agent acting as `authority`, working in `work`, for
 * `context` (`memoryContextSchema`): the files that context gets, as they
 * are now, that exist and that the person it acts for may read, each cut
 * to its limit. Throws `knowledge.invalid` for a context that isn't one,
 * `permission.context_invalid` for an agent's context (a direct message or
 * a channel) that isn't an agent's, `permission.person_inactive` when the
 * person has left, and, for an App's AGENTS.md, `role.forbidden` when they
 * can't build Apps and `app.not_found` for one that doesn't exist. No
 * memory while `memory` (or `knowledge`) is switched off.
 */
export const forContext = async (
  env: Env,
  authority: Authority,
  work: WorkContext,
  input: unknown
): Promise<Memory> => {
  const context = knowledgeErrors.parse(
    "knowledge.invalid",
    memoryContextSchema,
    input
  );
  const switchedOn =
    featureEnabled(env, "knowledge") && featureEnabled(env, "memory");
  const wanted = switchedOn ? await wantedFor(authority, context) : [];
  const found =
    wanted.length === 0
      ? []
      : await findFiles(env, authority.onBehalfOf, wanted);
  const key = await sha256Hex(
    JSON.stringify(
      found.map(({ wanted: { source, name, at }, documentId, version }) => [
        source,
        documentId ?? ("appId" in at ? at.appId : ""),
        version,
        memoryLimit(env, name),
      ])
    )
  );
  const entry = assembled.get(key) ?? (await assemble(env, found));
  remember(key, entry);
  const sources = found.flatMap(({ collection }) =>
    collection === null ? [] : [collection]
  );
  // Before anyone gets the text: an agent that reads something sensitive
  // is restricted first, and every read is recorded, cached or not.
  const provenance =
    sources.length === 0
      ? noProvenance
      : await noteProvenance(
          env,
          { type: "delegate", authority, context: work },
          {
            action: "knowledge.read",
            documentIds: found.flatMap(({ documentId }) =>
              documentId === null ? [] : [documentId]
            ),
            detail: { read: "memory", context: context.type },
          },
          ...sources
        );
  return { ...entry, key, provenance };
};

/** The Memory collection, as the admin `ownerId` sets it up. */
const memoryCollectionRow = (ownerId: string): CollectionRow => ({
  id: memoryCollectionId,
  name: "Memory",
  description:
    "What every agent knows: the company's AGENTS.md and MEMORY.md, and each agent's own at agents/<agent>/AGENTS.md.",
  owner: ownerId,
  access: "everyone",
  sensitive: false,
  source: "here",
  createdAt: new Date(),
});

/**
 * The Personal collection of `userId`, created by `actor` if it doesn't
 * exist yet. Only they read it, and only they and their agents write it.
 */
const personalCollection = async (
  env: Env,
  userId: string,
  actor: Parameters<typeof ensureCollection>[2]
): Promise<CollectionRow> => {
  const collection = await ensureCollection(
    env,
    {
      id: await personalCollectionId(userId),
      name: "Personal",
      description:
        "Only yours: your USER.md, what your agents know about you and keep up to date.",
      owner: userId,
      access: "me",
      sensitive: false,
      source: "here",
      createdAt: new Date(),
    },
    actor
  );
  // Its ID is made from the person's, and nothing else creates one with
  // it; this keeps a row that isn't theirs from ever being written.
  if (collection.owner !== userId || collection.access !== "me") {
    throw new Error(`Collection ${collection.id} isn't a Personal collection`);
  }
  return collection;
};

/**
 * The Memory collection and `person`'s Personal collection, creating the
 * Personal one if it doesn't exist yet, and the Memory one too when they
 * are an admin (who owns it then; every admin can change it).
 */
export const memoryCollections = async (
  env: Env,
  person: Identity
): Promise<MemoryCollections> => {
  const actor = actorOf(person);
  const personal = await personalCollection(env, person.userId, actor);
  const memory = isAdmin(person.role)
    ? await ensureCollection(env, memoryCollectionRow(person.userId), actor)
    : await drizzle(env.KNOWLEDGE)
        .select({ id: collections.id })
        .from(collections)
        .where(eq(collections.id, memoryCollectionId))
        .get();
  return {
    memory: memory ? memoryCollectionId : null,
    personal: collectionIdSchema.parse(personal.id),
  };
};

/**
 * Saves a new USER.md for the person the agent `authority` acts for, in
 * their Personal collection (created if needed), from `ifVersion` (0 for
 * their first): the agent keeps what it knows about its own person up to
 * date. The person sees each version in their collection's history, and
 * the audit log records the agent as the one who saved it.
 *
 * Only an agent, and only in a context with that person's USER.md in it
 * (`own` or `direct`): in a channel, what others say would reach it.
 * Refused with `permission.restricted` from a context that read restricted
 * data, which USER.md would carry into the person's next, unrestricted,
 * chats.
 */
export const saveUserMemory = async (
  env: Env,
  authority: Authority,
  work: WorkContext,
  context: unknown,
  input: unknown
): Promise<DocumentSummary> => {
  requireFeature(env, "knowledge");
  requireFeature(env, "memory");
  const { type } = knowledgeErrors.parse(
    "knowledge.invalid",
    memoryContextSchema,
    context
  );
  const { text, ifVersion, message } = knowledgeErrors.parse(
    "knowledge.invalid",
    userMemoryInputSchema,
    input
  );
  if (
    authority.subject.type !== "agent" ||
    !(type === "own" || type === "direct")
  ) {
    throw permissionErrors.create("permission.denied", { action: "write" });
  }
  if (!(await memberRole(env.DB, authority.onBehalfOf))) {
    throw permissionErrors.create("permission.person_inactive");
  }
  if (await isRestricted(env, authority, work)) {
    throw permissionErrors.create("permission.restricted");
  }
  const actor = delegateActorOf(authority);
  const collection = await personalCollection(env, authority.onBehalfOf, actor);
  return await writeVersion(
    env,
    { actor, userId: authority.onBehalfOf },
    {
      collection,
      path: "USER.md",
      text,
      ifVersion,
      message: message === undefined || message === "" ? null : message,
      restoredFrom: null,
    }
  );
};
