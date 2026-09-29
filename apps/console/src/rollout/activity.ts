/**
 * Every platform update in the client's own Activity (its audit log). A
 * release a rollout deploys is a new version of core, which records it
 * itself from the `PLATFORM_CHANGE` var the deploy sets (core's
 * src/platform-updates.ts). A rollback makes no new version, so the
 * console tells core of it: a notice to core's `platformUpdatePath`, on
 * the account's workers.dev origin as the router reaches it (with the
 * client's router secret), signed with a key derived from core's auth
 * secret, which the console derives from its client key
 * (@grasp-os/shared/platform-change).
 *
 * The rollback is done by the time core is told: a notice that doesn't
 * land (the keys to sign it missing from Secrets Store, a core version
 * from before the endpoint, core not answering) is audited in the console
 * (`rollout.activity_unrecorded`) and logged, and doesn't fail the
 * rollback.
 *
 * What a notice claims is what the rollback confirmed live, read right
 * before it released the client and stored with its record (never read
 * again after), not what it planned; a Worker it couldn't confirm (split,
 * or unread after a few tries) is told of by no notice. A change of the
 * rollout's that lands only after that release isn't in it: it runs
 * outside any runner, and drift shows it (src/rollout/drift.ts).
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import {
  platformUpdatePath,
  platformUpdatePurpose,
  platformUpdateSignatureHeader,
} from "@grasp-os/shared/platform-change";
import type {
  PlatformChange,
  PlatformUpdateNotice,
} from "@grasp-os/shared/platform-change";
import {
  deriveRouterSecret,
  routerSecretHeader,
} from "@grasp-os/shared/router";
import { and, eq } from "drizzle-orm";

import { audit } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients, clientWorkers } from "../db/schema.ts";
import { MissingStoreSecretError } from "../deploy/context.ts";
import { errorCode } from "../deploy/deploy.ts";
import { coreOrigin } from "../deploy/router.ts";
import { clientAuthSecret } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";

/** How long core may take to take a notice. */
const noticeTimeoutMs = 10_000;

const encoder = new TextEncoder();

/**
 * What telling core needs: the database, and how to read the keys secrets
 * derive from, read only once it's telling core, so a failure to is the
 * notice's.
 */
export interface ActivityContext {
  db: ConsoleDatabase;
  secrets: () => Promise<Pick<DeploySecrets, "routerKey" | "clientKey">>;
}

/**
 * Where client `clientId`'s core answers, and the generation of the
 * secrets it runs with; null before its first deploy recorded them.
 */
const coreOf = async (db: ConsoleDatabase, clientId: string) => {
  const [row] = await db
    .select({
      subdomain: clients.workersSubdomain,
      generation: clients.generation,
      scriptName: clientWorkers.scriptName,
    })
    .from(clients)
    .innerJoin(
      clientWorkers,
      and(
        eq(clientWorkers.clientId, clients.id),
        eq(clientWorkers.worker, "core")
      )
    )
    .where(eq(clients.id, clientId));
  return row?.subdomain === null || row === undefined
    ? null
    : { ...row, subdomain: row.subdomain };
};

/** Whether `error` is `fetch` getting no answer: refused, cut off, or timed out. */
const isNoAnswer = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof Error && error.name === "TimeoutError");

/** Why a notice failed with `error`, as a code. */
const failureOf = (error: unknown): string => {
  if (error instanceof MissingStoreSecretError) {
    return "store_secret_missing";
  }
  // No answer in time, or none at all: fetch's own failures.
  return isNoAnswer(error) ? "core_unreachable" : errorCode(error);
};

/** Sends `notice` to client `clientId`'s core: null once core took it, else why not. */
const send = async (
  context: ActivityContext,
  clientId: string,
  notice: PlatformUpdateNotice
): Promise<string | null> => {
  const { db } = context;
  const core = await coreOf(db, clientId);
  if (core === null) {
    return "core_unknown";
  }
  const secrets = await context.secrets();
  const body = JSON.stringify(notice);
  const key = await hkdfHmacKey(
    await clientAuthSecret(secrets, clientId, core.generation),
    platformUpdatePurpose,
    ["sign"]
  );
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const response = await fetch(
    `${coreOrigin(core.scriptName, core.subdomain)}${platformUpdatePath}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [routerSecretHeader]: await deriveRouterSecret(
          secrets.routerKey,
          clientId,
          core.generation
        ),
        [platformUpdateSignatureHeader]: signature,
      },
      body,
      signal: AbortSignal.timeout(noticeTimeoutMs),
    }
  );
  await response.body?.cancel();
  return response.status === 204 ? null : `core_${response.status}`;
};

/**
 * Tells client `clientId`'s core that `change` put it on core version
 * `versionId`, as confirmed live, and returns whether core took it. With
 * no version confirmed (null: core's traffic split, or not read) there's
 * nothing true to tell (`core_unconfirmed`). A notice core didn't take is
 * audited as `rollout.activity_unrecorded`, with why (`core_<status>`,
 * `core_unreachable`, `core_unknown`, `store_secret_missing`, or
 * another code), and logged. Never throws: what it tells of is done.
 */
export const tellCore = async (
  context: ActivityContext,
  clientId: string,
  versionId: string | null,
  change: PlatformChange
): Promise<boolean> => {
  let failure: string | null = "core_unconfirmed";
  try {
    if (versionId !== null) {
      failure = await send(context, clientId, {
        versionId,
        change,
        sentAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    failure = failureOf(error);
  }
  if (failure === null) {
    return true;
  }
  log.warn("rollout.activity_unrecorded", { clientId, error: failure });
  try {
    await audit(context.db, "system", {
      action: "rollout.activity_unrecorded",
      clientId,
      ...(versionId === null ? {} : { target: versionId }),
      detail: { what: change.what, error: failure },
    });
  } catch (auditError) {
    log.error("rollout.activity_unaudited", {
      clientId,
      error: errorCode(auditError),
    });
  }
  return false;
};
