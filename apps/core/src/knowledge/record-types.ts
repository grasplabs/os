import { appErrors, appRecordTypesSchema } from "@grasp-os/shared/apps";
import type { AppRecordType, AppRecordTypes } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  appVersions,
  apps,
  permissions,
  recordTypeOwners,
} from "../db/core/schema.ts";
import { featureEnabled } from "../features.ts";

// The record types Knowledge checks a collection's records against: those
// the current version of an App declares for it (`app/records.json`,
// app-records.ts), while the App holds an active permission to write the
// collection and an admin approved that version (as `authorize` requires
// of every write its code makes).
//
// A type in a collection is one App's, full stop: the App that claimed it
// (`record_type_owners`), which the claim row says. A type is claimed
// where its owner is needed, on the save or read of one of its records
// that finds no claim, or only a released one (`declaredTypes`): by the
// App that may declare it there whose permission to write was granted
// first (ties by App ID), inserted if nobody claimed it meanwhile, then
// read back. So a claim needs no grant, version or flag change to happen
// first, and a failed one is claimed again at the next save. The owner
// keeps it until it loses its permission to write there, or its current
// version, approved, no longer declares the type (`released`): a version
// nobody approved yet doesn't release it, whatever it declares, though
// meanwhile nobody declares the type, and a record of it stays of it
// (documents.ts, `requireFieldsKept`). Another App declaring the type
// there is ignored, however it declares it, a copy of the same blueprint
// too: it can neither loosen nor block the owner's records, nor set their
// kept fields. A commit of it is
// refused while it may write there (`requireOwnTypes`), and an admin sees,
// as they grant a request to write, which types it would claim and which
// another App has (`typeClaims`). Read on each save and each read of
// records.

/** A type as its owning App declares it for a collection. */
export interface RecordTypeRule {
  app: AppId;
  /** The frontmatter's schema, as Zod reads the declared JSON Schema. */
  schema: z.ZodType<Record<string, unknown>>;
  /** The fields only one method of it sets, by field: that method. */
  kept: ReadonlyMap<string, string>;
}

/** The types declared for one collection, each by its owning App. */
export type DeclaredTypes = ReadonlyMap<string, RecordTypeRule>;

/** No types declared: while `record_types` is off, and for most collections. */
export const noDeclaredTypes: DeclaredTypes = new Map();

const objectSchema = z.record(z.string(), z.unknown());

/** An App that may declare types for a collection now, and those it does. */
interface Declaring {
  app: AppId;
  version: number;
  types: ReadonlyMap<string, AppRecordType>;
}

/** Schemas already read, by App, version and type: versions never change. */
const schemas = new Map<string, z.ZodType<Record<string, unknown>>>();

/** Most schemas kept read at once. */
const schemasKept = 500;

/** The Zod schema of `declaration`, read once for its App version. */
const schemaOf = (
  key: string,
  declaration: AppRecordType
): z.ZodType<Record<string, unknown>> => {
  const known = schemas.get(key);
  if (known !== undefined) {
    return known;
  }
  // Checked when the version was committed (`jsonSchemaSchema`): Zod reads
  // it, and every keyword in it is one Zod enforces.
  const schema = z.fromJSONSchema(declaration.schema).pipe(objectSchema);
  if (schemas.size >= schemasKept) {
    const oldest = schemas.keys().next().value;
    if (oldest !== undefined) {
      schemas.delete(oldest);
    }
  }
  schemas.set(key, schema);
  return schema;
};

/** Whether the permission row allows `write`. */
const writes = sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = 'write')`;

/**
 * The Apps that may declare types for `collectionId` now, with the types
 * their current versions declare there, the one whose permission to write
 * was granted first first (ties by App ID). One query, by the index of
 * permissions by their object.
 */
const declaringApps = async (
  env: Env,
  collectionId: string
): Promise<Declaring[]> => {
  const rows = await drizzle(env.DB)
    .select({
      app: apps.id,
      version: appVersions.version,
      records: appVersions.records,
    })
    .from(permissions)
    .innerJoin(apps, eq(apps.id, permissions.subjectId))
    .innerJoin(
      appVersions,
      and(
        eq(appVersions.appId, apps.id),
        eq(appVersions.version, apps.currentVersion)
      )
    )
    .where(
      and(
        eq(permissions.objectType, "collection"),
        eq(permissions.objectId, collectionId),
        eq(permissions.subjectType, "app"),
        eq(permissions.status, "active"),
        writes,
        isNotNull(apps.currentVersion),
        or(isNull(appVersions.approved), ne(appVersions.approved, 0))
      )
    )
    // The App granted first comes first: it claims a type nobody has.
    .orderBy(asc(permissions.grantedAt), asc(apps.id));
  const seen = new Set<string>();
  const declaring: Declaring[] = [];
  for (const { app, version, records } of rows) {
    if (seen.has(app)) {
      continue;
    }
    seen.add(app);
    const parsed = appRecordTypesSchema.safeParse(records);
    if (!parsed.success) {
      log.warn("record_types.unreadable", { appId: app });
      continue;
    }
    declaring.push({
      app: appIdSchema.parse(app),
      version,
      types: new Map(
        Object.entries(parsed.data).filter(
          ([, declaration]) => declaration.collection === collectionId
        )
      ),
    });
  }
  return declaring;
};

/**
 * Whether the claim of `record_type_owners` (its row, in the statement
 * this runs in) is released: its App no longer holds a permission to
 * write the collection, active or asked for again, or its current version,
 * approved, no longer declares the type there. Only an approved state of
 * the owner releases it: while its current version waits for approval
 * (its permission back to requested), the claim holds whatever that
 * version declares, so an unapproved change can't hand the type over.
 */
const released = sql`NOT EXISTS (
  SELECT 1 FROM ${permissions}
  INNER JOIN ${apps} ON ${apps.id} = ${permissions.subjectId}
  INNER JOIN ${appVersions} ON ${appVersions.appId} = ${apps.id}
    AND ${appVersions.version} = ${apps.currentVersion}
  WHERE ${permissions.subjectType} = 'app'
    AND ${permissions.subjectId} = ${recordTypeOwners.appId}
    AND ${permissions.objectType} = 'collection'
    AND ${permissions.objectId} = ${recordTypeOwners.collectionId}
    AND ${permissions.status} IN ('active', 'requested')
    AND ${writes}
    AND (
      ${appVersions.approved} = 0
      OR json_extract(${appVersions.records}, '$."' || ${recordTypeOwners.type} || '".collection') = ${recordTypeOwners.collectionId}
    )
)`;

/** A type's claim in a collection: its owner, and whether it is released. */
interface Claim {
  app: AppId;
  released: boolean;
}

/** The claims of `collectionId`'s types, by type. */
const claimsOf = async (
  env: Env,
  collectionId: string
): Promise<Map<string, Claim>> => {
  const rows = await drizzle(env.DB)
    .select({
      type: recordTypeOwners.type,
      app: recordTypeOwners.appId,
      released: sql<number>`${released}`,
    })
    .from(recordTypeOwners)
    .where(eq(recordTypeOwners.collectionId, collectionId));
  return new Map(
    rows.map(({ type, app, released: gone }) => [
      type,
      { app: appIdSchema.parse(app), released: gone === 1 },
    ])
  );
};

/**
 * Claims, in one batch, each of `types` of `collectionId` for the first
 * App of `declaring` that declares it: a claim released (`released`) is
 * deleted first, and one is inserted only where none is left, so two
 * claims at once can't both win.
 */
const claimTypes = async (
  env: Env,
  collectionId: string,
  declaring: readonly Declaring[],
  types: readonly string[]
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const [first, ...rest] = types.flatMap((type) => {
    const claimer = declaring.find((candidate) => candidate.types.has(type));
    return claimer === undefined
      ? []
      : [
          db
            .delete(recordTypeOwners)
            .where(
              and(
                eq(recordTypeOwners.collectionId, collectionId),
                eq(recordTypeOwners.type, type),
                released
              )
            ),
          db
            .insert(recordTypeOwners)
            .values({ collectionId, type, appId: claimer.app, claimedAt: now })
            .onConflictDoNothing(),
        ];
  });
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};

/**
 * The Apps that may declare types for `collectionId` now, and the claims
 * of its types, each type they declare that nobody claimed, or whose claim
 * is released, claimed first (`claimTypes`), and the claims read back.
 */
const claimedNow = async (
  env: Env,
  collectionId: string
): Promise<{ declaring: Declaring[]; claims: Map<string, Claim> }> => {
  const [declaring, found] = await Promise.all([
    declaringApps(env, collectionId),
    claimsOf(env, collectionId),
  ]);
  const unclaimed = [
    ...new Set(declaring.flatMap(({ types }) => [...types.keys()])),
  ].filter((type) => found.get(type)?.released !== false);
  if (unclaimed.length === 0) {
    return { declaring, claims: found };
  }
  await claimTypes(env, collectionId, declaring, unclaimed);
  return { declaring, claims: await claimsOf(env, collectionId) };
};

/**
 * The record types declared for the collection `collectionId` now, each
 * by the App that claimed it, while that App may declare it there: none
 * while `record_types` is off. A type an App may declare there that nobody
 * claimed, or whose claim is released, is claimed first (`claimTypes`),
 * and the claims read back. A type whose owner may not declare it now (a
 * version nobody approved yet) is declared by nobody meanwhile.
 */
export const declaredTypes = async (
  env: Env,
  collectionId: string
): Promise<DeclaredTypes> => {
  if (!featureEnabled(env, "record_types")) {
    return noDeclaredTypes;
  }
  const { declaring, claims } = await claimedNow(env, collectionId);
  const declared = new Map<string, RecordTypeRule>();
  for (const [type, claim] of claims) {
    const owner = declaring.find(({ app }) => app === claim.app);
    const declaration = owner?.types.get(type);
    if (owner === undefined || declaration === undefined) {
      continue;
    }
    declared.set(type, {
      app: owner.app,
      schema: schemaOf(`${owner.app}@${owner.version}:${type}`, declaration),
      kept: new Map(
        declaration.kept.flatMap(({ method, fields }) =>
          fields.map((field) => [field, method] as const)
        )
      ),
    });
  }
  return declared;
};

/**
 * The kept fields of a `type` record, by field: the method of the type's
 * owner that sets each. None for a type nobody declares.
 */
export const keptSetters = (
  declared: DeclaredTypes,
  type: string
): Map<string, { app: AppId; method: string }> => {
  const setters = new Map<string, { app: AppId; method: string }>();
  const rule = declared.get(type);
  for (const [field, method] of rule?.kept ?? []) {
    setters.set(field, { app: rule?.app ?? appIdSchema.parse("none"), method });
  }
  return setters;
};

/** What App `app`'s types in a collection would be, as it may write there. */
export interface TypeClaims {
  /** The types it has there, or would claim: nobody else has them. */
  claims: string[];
  /** The types another App has there already, and which App. */
  taken: { type: string; owner: AppId }[];
}

/**
 * Of the types App `app` declares for `collectionId` (`types`), those it
 * has there or would claim, and those another App has there already: its
 * claim holds, and it isn't released.
 */
export const typeClaims = async (
  env: Env,
  app: string,
  collectionId: string,
  types: readonly string[]
): Promise<TypeClaims> => {
  if (types.length === 0) {
    return { claims: [], taken: [] };
  }
  // As a save there now would find them.
  const { claims } = featureEnabled(env, "record_types")
    ? await claimedNow(env, collectionId)
    : { claims: await claimsOf(env, collectionId) };
  const taken = types.flatMap((type) => {
    const claim = claims.get(type);
    return claim === undefined || claim.released || claim.app === app
      ? []
      : [{ type, owner: claim.app }];
  });
  const other = new Set(taken.map(({ type }) => type));
  return { claims: types.filter((type) => !other.has(type)), taken };
};

/** The collections App `app` holds an active permission to write. */
const writableBy = async (env: Env, app: string): Promise<Set<string>> => {
  const rows = await drizzle(env.DB)
    .select({ collectionId: permissions.objectId })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        eq(permissions.status, "active"),
        eq(permissions.objectType, "collection"),
        writes
      )
    );
  return new Set(rows.map(({ collectionId }) => collectionId));
};

/** `records` by collection: the types each declares there. */
export const byCollection = (
  records: AppRecordTypes
): Map<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const [type, { collection }] of Object.entries(records)) {
    grouped.set(collection, [...(grouped.get(collection) ?? []), type]);
  }
  return grouped;
};

/**
 * Refuses with `app.records_invalid` record types `records` of App `app`
 * would declare in a collection it may write where another App has them
 * already: they would be ignored there. The refusal doesn't name that App.
 */
export const requireOwnTypes = async (
  env: Env,
  app: string,
  records: AppRecordTypes
): Promise<void> => {
  const grouped = byCollection(records);
  if (grouped.size === 0) {
    return;
  }
  const writable = await writableBy(env, app);
  const issues: string[] = [];
  for (const [collectionId, types] of grouped) {
    if (writable.has(collectionId)) {
      // oxlint-disable-next-line no-await-in-loop -- a few collections, one at a time
      const { taken } = await typeClaims(env, app, collectionId, types);
      issues.push(
        ...taken.map(
          ({ type }) =>
            `${type}: another App already keeps ${type} records in collection ${collectionId}`
        )
      );
    }
  }
  if (issues.length > 0) {
    throw appErrors.create("app.records_invalid", { issues });
  }
};
