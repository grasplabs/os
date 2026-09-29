import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { deploymentConfig } from "@grasp-os/shared/config";
import { requestErrors } from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  platformChangeSchema,
  platformUpdateMaxBytes,
  platformUpdateMaxSkewMs,
  platformUpdateNoticeSchema,
  platformUpdatePurpose,
  platformUpdateSignatureHeader,
} from "@grasp-os/shared/platform-change";
import type { PlatformUpdateNotice } from "@grasp-os/shared/platform-change";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import { platformVersions } from "./db/core/schema.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import { errorResponse } from "./errors.ts";

// Platform updates in the client's Activity: every version the console
// deploys carries a `PLATFORM_CHANGE` var (@grasp-os/shared/platform-change)
// saying who changed what. The every-minute cron inserts the version
// running now (the `CF_VERSION_METADATA` binding) into `platform_versions`,
// one row per version ever recorded, and stores `platform.updated` in the
// same batch only if that insert added the row. So each version is
// recorded at most once, however many cron runs see it at the same time,
// and however often isolates of two versions alternate on the cron during
// a gradual rollout. A rollback to a version already recorded is not
// recorded again here: the console tells core of it (`platformUpdatePath`,
// below). The event waits in core's outbox for the cron's drain, this
// run's or the next.
//
// `platform_version`, the one row the first release of this job kept, is
// no longer written; a later release drops it. The migration that added
// `platform_versions` copied that row in, so the version running then
// isn't recorded twice.
//
// A version made outside the console (a `wrangler deploy`, which keeps the
// vars) carries the previous version's `PLATFORM_CHANGE`; the event names
// the version's own ID and creation time, so a reader can tell. Without
// the var, or with one that doesn't parse, the change is `unknown`.
// Where there is no version metadata (plain workerd, on-prem), nothing is
// recorded. Nor is anything while `platform_versions` doesn't exist yet
// (a version deployed before its migration ran): that is logged once per
// isolate as a warning, and the first run after the migration records the
// version then running.

/** What recording platform updates needs. */
export type PlatformUpdateEnv = Pick<Env, "DB" | "PLATFORM_CHANGE"> &
  Partial<Pick<Env, "CF_VERSION_METADATA">>;

/** Who, what and which release, when `PLATFORM_CHANGE` doesn't say. */
const unknown = "unknown";

/** Whether this isolate has warned that `platform_versions` is missing. */
let warnedMissingTable = false;

/** Whether `error`, or what it wraps, says `platform_versions` is missing. */
const isMissingTable = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("no such table: platform_versions") ||
    isMissingTable(error.cause));

/** The insert of the running version, if new, and its event. */
const record = async (
  db: DrizzleD1Database,
  version: WorkerVersionMetadata,
  detail: Record<string, AuditDetailValue>
): Promise<void> => {
  await db.batch([
    db
      .insert(platformVersions)
      .values({ versionId: version.id, recordedAt: new Date() })
      .onConflictDoNothing(),
    // `changes()` is the insert's: core's database has no FTS index, whose
    // flush would set it (see `outboxedIfChanged`).
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "platform.updated",
      target: { type: "version", id: version.id },
      detail,
    }),
  ]);
};

/**
 * Records the running version as `platform.updated` if it has never been
 * recorded. The cron trigger calls it every minute.
 */
export const recordPlatformUpdate = async (
  env: PlatformUpdateEnv
): Promise<void> => {
  const version = env.CF_VERSION_METADATA;
  if (version === undefined || version.id === "") {
    return;
  }
  const change = deploymentConfig(
    platformChangeSchema,
    "PLATFORM_CHANGE",
    env.PLATFORM_CHANGE
  );
  const detail: Record<string, AuditDetailValue> = {
    versionId: version.id,
    versionCreatedAt: version.timestamp === "" ? null : version.timestamp,
    by: change?.by ?? unknown,
    what: change?.what ?? unknown,
    release: change?.release ?? unknown,
    changedAt: change?.at ?? null,
  };
  const db = drizzle(env.DB);
  try {
    await record(db, version, detail);
  } catch (error) {
    if (!isMissingTable(error)) {
      throw error;
    }
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      log.warn("platform.update.table_missing", errorFields(error));
    }
  }
};

// A platform update that made no new version, a rollback to a version
// core has run before, never reaches the cron above: the console tells
// core of it instead, at `platformUpdatePath`. The notice is signed with a
// key derived from core's auth secret, which the console derives from its
// client key, so only the console can make one; the router secret it
// passes first only says it came through the router, as everyone's
// request does. A notice is taken within `platformUpdateMaxSkewMs` of
// when it was sent, so one caught on its way can't be sent again later,
// and read up to `platformUpdateMaxBytes` of its actual body, whatever its
// headers say. It's recorded as `platform.updated`, the way the cron
// records a new version, with the version the rollback went back to.

/** Why a notice was refused, as logged: never its body or signature. */
type NoticeRefusal =
  | "too_large"
  | "unsigned"
  | "bad_signature"
  | "invalid"
  | "stale";

/** Signatures: 32 bytes as lowercase hex. */
const signaturePattern = /^[0-9a-f]{64}$/u;

/** Two hex characters at a time. */
const hexPair = /../gu;

/** `hex`, lowercase hex characters, as bytes. */
const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(hexPair) ?? [], (pair) =>
    Number.parseInt(pair, 16)
  );

/** The notice `request` carries, checked, or why it's refused. */
const noticeOf = async (
  request: Request,
  env: Pick<Env, "BETTER_AUTH_SECRET">
): Promise<PlatformUpdateNotice | NoticeRefusal> => {
  // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
  // chunks; its type says `any` only for streams in general.
  const stream = request.body as ReadableStream<Uint8Array> | null;
  const body =
    stream === null
      ? new Uint8Array()
      : await readAtMost(stream, platformUpdateMaxBytes);
  if (body === undefined) {
    return "too_large";
  }
  const signature = request.headers.get(platformUpdateSignatureHeader) ?? "";
  if (!signaturePattern.test(signature)) {
    return "unsigned";
  }
  const key = await derivedHmacKey(env, platformUpdatePurpose, ["verify"]);
  // `verify` compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", key, hexBytes(signature), body))) {
    return "bad_signature";
  }
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return "invalid";
  }
  const notice = platformUpdateNoticeSchema.safeParse(parsed);
  if (!notice.success) {
    return "invalid";
  }
  const skew = Math.abs(Date.now() - Date.parse(notice.data.sentAt));
  return skew > platformUpdateMaxSkewMs ? "stale" : notice.data;
};

/**
 * Takes the console's notice of a platform update that made no new
 * version, and records it as `platform.updated`: 204. Anything but a
 * `POST` is a path core doesn't serve; a notice that's too large,
 * unsigned, signed otherwise, malformed or stale is refused (403) and
 * logged, recording nothing.
 */
export const platformUpdateResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const notice = await noticeOf(request, env);
  if (typeof notice === "string") {
    log.info("platform.update.refused", { reason: notice });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const { versionId, change } = notice;
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, {
      actor: { type: "system" },
      action: "platform.updated",
      target: { type: "version", id: versionId },
      detail: {
        versionId,
        versionCreatedAt: null,
        by: change.by,
        what: change.what,
        release: change.release,
        changedAt: change.at,
      },
    }),
  ]);
  return new Response(null, { status: 204 });
};
