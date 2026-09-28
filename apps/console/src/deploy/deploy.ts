/**
 * Making a client's account run a release: its resources in the EU, its
 * database migrations, then its Workers (connect before core, which binds
 * it) uploaded with their secrets and deployed to all traffic. A deploy is
 * a `client_deploys` row that records how far it got, and each step it
 * finishes is audited with it.
 *
 * Every step finds what it made before and makes only what's missing, so
 * a deploy that failed part way (or whose runner stopped) is resumed by
 * running it again from the start: nothing is created twice, and a
 * Worker version it uploaded (recorded on the row) is deployed rather
 * than uploaded again. The steps run on the release's own manifest, as
 * imported, and read its blobs checked against it.
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
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { CloudflareApiError } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { act } from "../db/act.ts";
import type { Actor, ConsoleDatabase } from "../db/act.ts";
import {
  clientDeploys,
  clients,
  clientWorkers,
  settings,
} from "../db/schema.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";
import { migrateDatabases } from "./migrations.ts";
import { importedManifest } from "./release.ts";
import { ensureResources } from "./resources.ts";
import { workerSecrets, workerUpload } from "./upload.ts";
import type { DeploySecrets } from "./upload.ts";
import { deployOrder, deployWorker, uploadWorker } from "./versions.ts";

/** What a deploy works with. */
export interface DeployContext {
  /** The Cloudflare API, as the deployer (a member of every client account). */
  api: CloudflareApi;
  db: ConsoleDatabase;
  /** The releases bucket, read only. */
  store: ReleaseStore;
  /** The secrets to give the Workers, from Secrets Store. */
  secrets: DeploySecrets;
}

/** The steps a deploy runs, in order. */
export const deploySteps = [
  "resources",
  "migrations",
  "versions",
  "traffic",
] as const;
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

type Deploy = Awaited<ReturnType<typeof deployOf>>;

/** The deploy `id` and what it deploys where. */
const deployOf = async (db: ConsoleDatabase, id: string) => {
  const [row] = await db
    .select({
      clientId: clientDeploys.clientId,
      releaseId: clientDeploys.releaseId,
      status: clientDeploys.status,
      versions: clientDeploys.versions,
      startedBy: clientDeploys.startedBy,
      createdAt: clientDeploys.createdAt,
      accountId: clients.accountId,
      generation: clients.generation,
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

const versionsSchema = z.record(z.string(), z.string());

/** The Workers a deploy knows, by app: `client_workers` records these. */
const appSchema = z.enum(clientWorkers.worker.enumValues);

/** The app whose Worker gets the deployment config vars: core reads them. */
const varsApp = "core";

/**
 * Core's vars: the client's settings, each a JSON var by its key, and
 * `PLATFORM_CHANGE`, which core records as `platform.updated`.
 */
const coreVars = async (
  db: ConsoleDatabase,
  deploy: Deploy
): Promise<Record<string, unknown>> => {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.clientId, deploy.clientId));
  const change: PlatformChange = {
    by: deploy.startedBy,
    what: "release",
    release: deploy.releaseId,
    // When the deploy started: the same however often it's resumed.
    at: deploy.createdAt.toISOString(),
  };
  return {
    ...Object.fromEntries(
      rows.map(({ key, value }): [string, unknown] => [key, JSON.parse(value)])
    ),
    PLATFORM_CHANGE: change,
  };
};

/**
 * Runs the steps of `deploy` of `manifest`, calling `finished` after each,
 * and `current` as each starts: so a failure is recorded at the step it
 * happened in.
 */
const runSteps = async (
  { api, db, store, secrets }: DeployContext,
  id: string,
  deploy: Deploy,
  manifest: ReleaseManifest,
  hooks: {
    current: (step: DeployStep) => void;
    finished: (
      step: DeployStep,
      detail: Record<string, number>
    ) => Promise<void>;
  }
): Promise<void> => {
  const { accountId, clientId, releaseId } = deploy;
  hooks.current("resources");
  const resources = await ensureResources(api, accountId, manifest);
  await hooks.finished("resources", {
    databases: resources.databases.size,
    buckets: resources.buckets.length,
  });

  hooks.current("migrations");
  const applied = await migrateDatabases(
    api,
    accountId,
    resources.databases,
    manifest,
    store
  );
  await hooks.finished("migrations", {
    applied: [...applied.values()].reduce((sum, count) => sum + count, 0),
  });

  hooks.current("versions");
  // Refused before anything is uploaded: a release with another Worker
  // needs the console to know it first.
  const order = deployOrder(manifest.workers).map((app) =>
    appSchema.parse(app)
  );
  const versions = versionsSchema.parse(JSON.parse(deploy.versions ?? "{}"));
  const vars = await coreVars(db, deploy);
  for (const app of order) {
    const worker = manifest.workers[app];
    if (worker === undefined || versions[app] !== undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- in order: connect before core
    const upload = await workerUpload(
      store,
      manifest,
      worker,
      resources.databases,
      app === varsApp ? vars : {}
    );
    // oxlint-disable-next-line no-await-in-loop -- in order
    const workerSecretValues = await workerSecrets(app, worker, secrets, {
      id: clientId,
      generation: deploy.generation,
    });
    // oxlint-disable-next-line no-await-in-loop -- in order
    const versionId = await uploadWorker(
      api,
      accountId,
      worker,
      upload,
      workerSecretValues
    );
    versions[app] = versionId;
    // oxlint-disable-next-line no-await-in-loop -- recorded before the next upload
    await act(
      db,
      "system",
      [
        db
          .update(clientDeploys)
          .set({ versions: JSON.stringify(versions), updatedAt: new Date() })
          .where(eq(clientDeploys.id, id)),
      ],
      {
        action: "deploy.version",
        clientId,
        target: releaseId,
        detail: { deploy: id, worker: app, version: versionId },
      }
    );
  }
  await hooks.finished("versions", { workers: order.length });

  hooks.current("traffic");
  for (const app of order) {
    const worker = manifest.workers[app];
    const versionId = versions[app];
    if (worker === undefined || versionId === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- in order: connect before core
    await deployWorker(
      api,
      accountId,
      worker,
      versionId,
      `Release ${releaseId} (deploy ${id})`
    );
    const now = new Date();
    // oxlint-disable-next-line no-await-in-loop -- in order
    await act(
      db,
      "system",
      [
        db
          .insert(clientWorkers)
          .values({
            clientId,
            worker: app,
            scriptName: worker.name,
            releaseId,
            versionId,
            deployedAt: now,
          })
          .onConflictDoUpdate({
            target: [clientWorkers.clientId, clientWorkers.worker],
            set: {
              scriptName: worker.name,
              releaseId,
              versionId,
              deployedAt: now,
            },
          }),
      ],
      {
        action: "deploy.worker_live",
        clientId,
        target: releaseId,
        detail: { deploy: id, worker: app, version: versionId },
      }
    );
  }
  await hooks.finished("traffic", { workers: order.length });
};

/**
 * Runs deploy `id`'s steps, from the first, and marks it done; a deploy
 * already done is left as it is. Run it again to resume one that failed.
 * On a failure it records the step and the error's code, audited, and
 * throws the error.
 */
export const runDeploy = async (
  context: DeployContext,
  id: string
): Promise<void> => {
  const { db } = context;
  const deploy = await deployOf(db, id);
  if (deploy.status === "done") {
    return;
  }
  const { clientId, releaseId } = deploy;
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
    await runSteps(context, id, deploy, manifest, {
      current: (next) => {
        step = next;
      },
      finished,
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
