import type { AuditActor } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { stringify } from "yaml";

import { versionFiles } from "../apps.ts";
import { apps } from "../db/core/schema.ts";
import { appEntries, documents, versions } from "../db/knowledge/schema.ts";
import { appsCollectionEnabled } from "./access.ts";
import { appEntryPath, appsCollectionId } from "./app-entries.ts";
import { ensureCollection } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { writeVersion } from "./documents.ts";
import type { Writer } from "./documents.ts";
import { appMemoryPath } from "./memory-files.ts";

// The Apps collection: one entry per App, its AGENTS.md at its current
// version, with its name and description, so people and agents find the
// App that already does what they want before they create another (same
// process, same App). Who finds which entry is app-entries.ts.
//
// Nobody saves or restores in it: the collection's source is `apps`,
// which every save and restore refuses (collections.ts
// `requireWritable`). The indexer's writes go through the save pipeline,
// as `system`, so each is a version with its audit event. A purge naming
// an entry is refused while what indexing would write now (`entryNow`:
// the App's name, description and current version's AGENTS.md) holds a
// term (purge.ts `requireSavable`): the next indexing would put it back,
// from the App itself, out of a purge's reach. Once the App no longer
// holds it, the purge rewrites the entry's history like any document's.
//
// The App registry is in the core database and the collection in
// Knowledge's, so no batch holds both. Making a version current indexes
// the App straight after (`indexAppNow`), and a cron trigger every 15
// minutes indexes every App whose entry isn't of its current version
// (`indexApps`): one whose indexing failed, one made current while
// indexing was off, and every App when it is first switched on. Indexing
// where a version is made current keeps entries current; the cron trigger
// only catches up, so every 15 minutes is enough. `app_entries` has the
// version each entry holds, written in the entry's batch.
//
// Two indexings of one App at once (a version change and the cron, say)
// never write over each other: each reads the entry before the App, and
// writes only over the entry's version it read (the save's `ifVersion`,
// or the guard on `app_entries` when only that changes), so the one that
// loses writes nothing. The one that wins may have read the App before a
// version change that the loser saw, and so leave the text of a version
// that is no longer current: `app_entries` then names that version, which
// differs from the App's, and the next cron run indexes it again. So the
// entry heals itself within 15 minutes.

/** Who indexes: Grasp itself, with no person behind it. */
const appsActor: AuditActor = { type: "system" };

/** The author and owner of the entries' versions. */
const appsWriter: Writer = { actor: appsActor, userId: "grasp" };

/** Most Apps one cron run indexes: each is a read from R2 and a batch. */
const indexedPerRun = 20;

/**
 * Knowledge's refusals of an App's AGENTS.md as it is, which the App's
 * own limits allow: its entry is then indexed without it.
 */
const refusedAsTooLarge: ReadonlySet<string> = new Set([
  "knowledge.too_large",
  "knowledge.too_many_sections",
  "knowledge.too_many_links",
]);

const appsCollectionRow = (): CollectionRow => ({
  id: appsCollectionId,
  name: "Apps",
  description:
    "Every App's AGENTS.md, as its current version has it: what it does and how. Search here before creating an App: same process, same App. You find only the Apps you may open.",
  owner: "grasp",
  access: "everyone",
  sensitive: false,
  source: "apps",
  createdAt: new Date(),
});

interface IndexedApp {
  id: string;
  name: string;
  description: string;
}

/**
 * An App's entry: its name as the title and its description, which search
 * weighs first, and its ID; then its AGENTS.md, as the App has it (its own
 * frontmatter, if any, is text of the entry).
 */
const entryText = (app: IndexedApp, body: string): string =>
  `---\n${stringify({ title: app.name, description: app.description, app: app.id })}---\n${body}`;

/** The App `appId`, if it exists. */
const appInUse = async (env: Env, appId: string) =>
  await drizzle(env.DB)
    .select({
      id: apps.id,
      name: apps.name,
      description: apps.description,
      currentVersion: apps.currentVersion,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .get();

/** The AGENTS.md of version `version` of the App `appId`, as indexed. */
const agentsOf = async (
  env: Env,
  appId: string,
  version: number
): Promise<string> => {
  const files = await versionFiles(env, appIdSchema.parse(appId), version);
  return files[appMemoryPath] ?? "This App has no AGENTS.md.";
};

/**
 * What indexing would write for the App `appId` now: its entry's text,
 * as `entryText` makes it from the App's name and description and its
 * current version's AGENTS.md, and those parts. `undefined` when the App
 * isn't in use or has no current version. Throws what failed to read.
 */
export const entryNow = async (
  env: Env,
  appId: string
): Promise<
  | { text: string; name: string; description: string; agents: string }
  | undefined
> => {
  const app = await appInUse(env, appId);
  if (app === undefined || app.currentVersion === null) {
    return undefined;
  }
  const agents = await agentsOf(env, appId, app.currentVersion);
  return {
    text: entryText(app, agents),
    name: app.name,
    description: app.description,
    agents,
  };
};

/** Sets the version the App's entry holds, in the entry's batch. */
const noteVersion = (
  db: DrizzleD1Database,
  appId: string,
  version: number,
  onlyIf = sql`1`
) =>
  db
    .insert(appEntries)
    .select(sql`SELECT ${appId}, ${version}, ${Date.now()} WHERE ${onlyIf}`)
    .onConflictDoUpdate({
      target: appEntries.appId,
      set: {
        version: sql`excluded.version`,
        indexedAt: sql`excluded.indexed_at`,
      },
    });

/**
 * Indexes the App `appId` at its current version, unless its entry holds
 * that version already, or it has none.
 * Throws what failed, `knowledge.conflict` when another indexing wrote
 * first. Does nothing while indexing is off.
 */
const indexApp = async (env: Env, appId: string): Promise<void> => {
  if (!appsCollectionEnabled(env)) {
    return;
  }
  const knowledge = drizzle(env.KNOWLEDGE);
  const path = appEntryPath(appId);
  // The entry first, then the App (see above).
  const [[noted], [stored]] = await knowledge.batch([
    knowledge
      .select({ version: appEntries.version })
      .from(appEntries)
      .where(eq(appEntries.appId, appId)),
    knowledge
      .select({ version: documents.currentVersion, text: versions.text })
      .from(documents)
      .innerJoin(
        versions,
        and(
          eq(versions.documentId, documents.id),
          eq(versions.number, documents.currentVersion)
        )
      )
      .where(
        and(
          eq(documents.collectionId, appsCollectionId),
          eq(documents.path, path)
        )
      ),
  ]);
  const app = await appInUse(env, appId);
  const version = app?.currentVersion ?? null;
  if (app === undefined || version === null || noted?.version === version) {
    return;
  }
  const text = entryText(app, await agentsOf(env, appId, version));
  const ifVersion = stored?.version ?? 0;
  if (stored?.text === text) {
    // The same text: only the version it holds, while it is as read.
    await noteVersion(
      knowledge,
      appId,
      version,
      sql`(SELECT ${documents.currentVersion} FROM ${documents} WHERE ${documents.collectionId} = ${appsCollectionId} AND ${documents.path} = ${path}) = ${ifVersion}`
    );
    return;
  }
  const collection = await ensureCollection(
    env,
    appsCollectionRow(),
    appsActor
  );
  const write = async (entry: string) =>
    await writeVersion(env, appsWriter, {
      collection,
      path,
      text: entry,
      ifVersion,
      message: `Version ${version} of the App`,
      restoredFrom: null,
      also: [noteVersion(knowledge, appId, version)],
    });
  try {
    await write(text);
  } catch (error) {
    const code = knowledgeErrors.codeOf(error);
    if (code === undefined || !refusedAsTooLarge.has(code)) {
      throw error;
    }
    await write(entryText(app, "This App's AGENTS.md is too large to search."));
  }
};

/**
 * `indexApp`, whose failure is logged and left to the cron trigger (see
 * `indexApps`): a conflict, another indexing that wrote first, is left to
 * it silently.
 */
export const indexAppNow = async (env: Env, appId: string): Promise<void> => {
  try {
    await indexApp(env, appId);
  } catch (error) {
    if (knowledgeErrors.codeOf(error) !== "knowledge.conflict") {
      log.error("apps.index_failed", { appId, ...errorFields(error) });
    }
  }
};

/**
 * Indexes the Apps in use whose entries aren't of their current version,
 * at most `indexedPerRun`, one at a time, from a random one on (by ID,
 * wrapping around): Apps whose indexing fails every time can't keep the
 * others waiting run after run. Does nothing while indexing is off. The
 * cron trigger calls it every 15 minutes.
 */
export const indexApps = async (env: Env): Promise<void> => {
  if (!appsCollectionEnabled(env)) {
    return;
  }
  const [noted, inUse] = await Promise.all([
    drizzle(env.KNOWLEDGE)
      .select({ appId: appEntries.appId, version: appEntries.version })
      .from(appEntries),
    drizzle(env.DB)
      .select({ id: apps.id, currentVersion: apps.currentVersion })
      .from(apps)
      .where(isNotNull(apps.currentVersion)),
  ]);
  const held = new Map(noted.map(({ appId, version }) => [appId, version]));
  const stale = inUse
    .filter(({ id, currentVersion }) => held.get(id) !== currentVersion)
    .map(({ id }) => id)
    .toSorted();
  const [start = 0] = crypto.getRandomValues(new Uint32Array(1));
  const turn = [...stale.slice(start % stale.length), ...stale].slice(
    0,
    Math.min(stale.length, indexedPerRun)
  );
  for (const id of turn) {
    // oxlint-disable-next-line no-await-in-loop -- one App at a time
    await indexAppNow(env, id);
  }
};
