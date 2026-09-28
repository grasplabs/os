/**
 * Making a client's account run a release: its resources in the EU, then
 * its database migrations. A deploy is a `client_deploys` row that records
 * how far it got, and each step it finishes is audited with it.
 *
 * Every step finds what it made before and makes only what's missing, so
 * a deploy that failed part way (or whose runner stopped) is resumed by
 * running it again from the start: nothing is created twice. The steps
 * run on the release's own manifest, as imported, and read its blobs
 * checked against it.
 *
 * A deploy expects to be its client's only runner: the provisioning
 * Workflow runs one instance per client. Databases and buckets are unique
 * by name, so two runs at once couldn't make one twice, but a D1
 * migration could be applied twice, since reading what a database has
 * applied and applying the rest aren't one step.
 *
 * The Cloudflare API token is in `api` alone: never in a row, an audit
 * event or a log line (threat model R17, CO3). A failure is recorded as a
 * code, never as a message or a response body.
 */
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";

import { CloudflareApiError } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { act } from "../db/act.ts";
import type { Actor, ConsoleDatabase } from "../db/act.ts";
import { clientDeploys, clients } from "../db/schema.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";
import { migrateDatabases } from "./migrations.ts";
import { importedManifest } from "./release.ts";
import { ensureResources } from "./resources.ts";

/** What a deploy works with. */
export interface DeployContext {
  /** The Cloudflare API, as the deployer (a member of every client account). */
  api: CloudflareApi;
  db: ConsoleDatabase;
  /** The releases bucket, read only. */
  store: ReleaseStore;
}

/** The steps a deploy runs, in order. */
export const deploySteps = ["resources", "migrations"] as const;
export type DeployStep = (typeof deploySteps)[number];

/**
 * A failure as a deploy records it: a code, never a message. A step's own
 * failure has its `DeployError` code; the API's is `cloudflare_<status>`
 * and its error codes; anything else is `unexpected`.
 */
const errorCode = (error: unknown): string => {
  if (error instanceof DeployError) {
    return error.code;
  }
  if (error instanceof CloudflareApiError) {
    return ["cloudflare", error.status, ...error.codes].join("_");
  }
  return "unexpected";
};

const actorName = (actor: Actor): string =>
  actor === "system" ? actor : actor.email;

/**
 * Starts deploying release `releaseId` to client `clientId`, and returns
 * the deploy's id for `runDeploy`.
 */
export const startDeploy = async (
  db: ConsoleDatabase,
  actor: Actor,
  clientId: string,
  releaseId: string
): Promise<string> => {
  const id = crypto.randomUUID();
  const now = new Date();
  await act(
    db,
    actor,
    [
      db.insert(clientDeploys).values({
        id,
        clientId,
        releaseId,
        status: "running",
        startedBy: actorName(actor),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    {
      action: "deploy.start",
      clientId,
      target: releaseId,
      detail: { deploy: id },
    }
  );
  return id;
};

/** The deploy `id` and what it deploys where. */
const deployOf = async (db: ConsoleDatabase, id: string) => {
  const [row] = await db
    .select({
      clientId: clientDeploys.clientId,
      releaseId: clientDeploys.releaseId,
      status: clientDeploys.status,
      accountId: clients.accountId,
    })
    .from(clientDeploys)
    .innerJoin(clients, eq(clients.id, clientDeploys.clientId))
    .where(eq(clientDeploys.id, id));
  if (row === undefined) {
    throw new Error(`No deploy ${id}`);
  }
  return row;
};

/**
 * Marks a deploy failed at `step`, audited. A failure to record it is
 * logged, not thrown, so the caller throws the deploy's own error.
 */
const recordFailure = async (
  db: ConsoleDatabase,
  failure: {
    id: string;
    clientId: string;
    releaseId: string;
    step: DeployStep;
    code: string;
  }
): Promise<void> => {
  const { id, clientId, releaseId, step, code } = failure;
  try {
    await act(
      db,
      "system",
      [
        db
          .update(clientDeploys)
          .set({ status: "failed", error: code, updatedAt: new Date() })
          .where(eq(clientDeploys.id, id)),
      ],
      {
        action: "deploy.fail",
        clientId,
        target: releaseId,
        detail: { deploy: id, step, error: code },
      }
    );
  } catch (recordError) {
    log.error("deploy.fail_unrecorded", {
      deploy: id,
      error: errorCode(recordError),
    });
  }
};

/**
 * Runs deploy `id`'s steps, from the first, and marks it done; a deploy
 * already done is left as it is. Run it again to resume one that failed.
 * On a failure it records the step and the error's code, audited, and
 * throws the error.
 */
export const runDeploy = async (
  { api, db, store }: DeployContext,
  id: string
): Promise<void> => {
  const deploy = await deployOf(db, id);
  if (deploy.status === "done") {
    return;
  }
  const { clientId, releaseId, accountId } = deploy;
  const manifest = await importedManifest(db, releaseId);
  if (manifest === null) {
    throw new DeployError(
      "release_not_imported",
      `Release ${releaseId} isn't imported`
    );
  }

  /** Records that `step` finished, with what it did. */
  const finished = async (
    step: DeployStep,
    detail: Record<string, number>
  ): Promise<void> => {
    await act(
      db,
      "system",
      [
        db
          .update(clientDeploys)
          .set({ step, status: "running", error: null, updatedAt: new Date() })
          .where(eq(clientDeploys.id, id)),
      ],
      {
        action: `deploy.${step}`,
        clientId,
        target: releaseId,
        detail: { deploy: id, ...detail },
      }
    );
  };

  let step: DeployStep = "resources";
  try {
    const resources = await ensureResources(api, accountId, manifest);
    await finished(step, {
      databases: resources.databases.size,
      buckets: resources.buckets.length,
    });

    step = "migrations";
    const applied = await migrateDatabases(
      api,
      accountId,
      resources.databases,
      manifest,
      store
    );
    await finished(step, {
      applied: [...applied.values()].reduce((sum, count) => sum + count, 0),
    });
  } catch (error) {
    const code = errorCode(error);
    log.error("deploy.failed", {
      deploy: id,
      clientId,
      releaseId,
      step,
      error: code,
    });
    await recordFailure(db, { id, clientId, releaseId, step, code });
    throw error;
  }

  await act(
    db,
    "system",
    [
      db
        .update(clientDeploys)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(clientDeploys.id, id)),
    ],
    {
      action: "deploy.done",
      clientId,
      target: releaseId,
      detail: { deploy: id },
    }
  );
};
