/**
 * Making a client's account run a release: its resources in the EU, its
 * database migrations, its Workers (each uploaded with its secrets and
 * sent all traffic before the next: connect before core, which binds it),
 * a smoke check that core answers as the new version, as the router
 * reaches it, and the client's hostname in the router's map. A deploy is a `client_deploys` row that records how far it got, and
 * each step it finishes is audited with it.
 *
 * Every step finds what it made before and makes only what's missing, so
 * a deploy that failed part way (or whose runner stopped) is resumed by
 * running it again from the start: nothing is created twice, and a
 * Worker version it uploaded (recorded on the row, with the secrets
 * generation it carries) is deployed rather than uploaded again. The
 * steps run on the release's own manifest, as imported, and read its
 * blobs checked against it.
 *
 * Only a client's latest deploy runs: starting one supersedes the older
 * ones that hadn't finished, and running one that isn't the latest is
 * refused (`deploy_superseded`), so a stale deploy can't put an older
 * release or older secrets back live.
 *
 * A deploy expects to be its client's only runner: provisioning claims
 * one run per client in D1 (src/provision/runs.ts). Databases and buckets are unique
 * by name, so two runs at once couldn't make one twice, but a D1
 * migration could be applied twice, since reading what a database has
 * applied and applying the rest aren't one step.
 *
 * The Cloudflare API token is in `api` alone: never in a row, an audit
 * event or a log line (threat model R17, CO3). A failure is recorded as a
 * code, never as a message or a response body.
 */
import { deploymentConfigVars } from "@grasp-os/shared/deployment-config";
import { log } from "@grasp-os/shared/log";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { deriveRouterSecret, newClientIdSchema } from "@grasp-os/shared/router";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { CloudflareApiError } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { act, actIfChanged } from "../db/act.ts";
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
import {
  coreOrigin,
  registerHostname,
  smokeCheck,
  workersSubdomain,
} from "./router.ts";
import type { RouterHosts, SmokeOptions } from "./router.ts";
import { workerSecrets } from "./secrets.ts";
import type { DeploySecrets } from "./secrets.ts";
import {
  checkBindingNames,
  uploadFingerprint,
  workerUpload,
} from "./upload.ts";
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
  /** The time now: `new Date()` unless a test sets it. */
  now?: () => Date;
  router: {
    /** The router's hostname map. */
    hosts: RouterHosts;
    /** The domain clients are served under: a client is `<id>.<domain>`. */
    domain: string;
    /** How the smoke check reaches core. */
    smoke?: SmokeOptions;
  };
}

/** The steps a deploy runs, in order. */
export const deploySteps = [
  "resources",
  "migrations",
  "workers",
  "smoke",
  "router",
] as const;
export type DeployStep = (typeof deploySteps)[number];

/**
 * A failure as a deploy records it: a code, never a message. A step's own
 * failure has its `DeployError` code; the API's is `cloudflare_<status>`
 * and its error codes; anything else is `unexpected`.
 */
export const errorCode = (error: unknown): string => {
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
 * the deploy's id for `runDeploy`. The client's older deploys that hadn't
 * finished are superseded in the same batch. A client whose id can't be
 * its hostname (`newClientIdSchema`) is refused.
 */
export const startDeploy = async (
  db: ConsoleDatabase,
  actor: Actor,
  clientId: string,
  releaseId: string
): Promise<string> => {
  if (!newClientIdSchema.safeParse(clientId).success) {
    throw new DeployError(
      "invalid_client_id",
      `${clientId} can't be a client's hostname`
    );
  }
  const id = crypto.randomUUID();
  const now = new Date();
  await act(
    db,
    actor,
    [
      db
        .update(clientDeploys)
        .set({ status: "superseded", updatedAt: now })
        .where(
          and(
            eq(clientDeploys.clientId, clientId),
            inArray(clientDeploys.status, ["running", "failed"])
          )
        ),
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
      rotationLiveAt: clients.rotationLiveAt,
    })
    .from(clientDeploys)
    .innerJoin(clients, eq(clients.id, clientDeploys.clientId))
    .where(eq(clientDeploys.id, id));
  if (row === undefined) {
    throw new Error(`No deploy ${id}`);
  }
  return row;
};

/** Client `clientId`'s latest deploy: what it deploys, and how far it got. */
export const latestDeployOf = async (db: ConsoleDatabase, clientId: string) => {
  const [latest] = await db
    .select({
      id: clientDeploys.id,
      releaseId: clientDeploys.releaseId,
      status: clientDeploys.status,
      step: clientDeploys.step,
      error: clientDeploys.error,
      createdAt: clientDeploys.createdAt,
    })
    .from(clientDeploys)
    .where(eq(clientDeploys.clientId, clientId))
    // Two deploys of one millisecond in the order they started.
    .orderBy(desc(clientDeploys.createdAt), desc(sql`rowid`))
    .limit(1);
  return latest;
};

/** The id of client `clientId`'s latest deploy. */
const latestDeployId = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<string | undefined> => {
  const latest = await latestDeployOf(db, clientId);
  return latest?.id;
};

/** A deploy a newer one hasn't superseded. */
const notSuperseded = ne(clientDeploys.status, "superseded");

/** The deploy was superseded while it ran: it stops. */
const superseded = (id: string): DeployError =>
  new DeployError(
    "deploy_superseded",
    `A newer deploy superseded ${id} while it ran`
  );

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
    // A deploy superseded meanwhile stays superseded.
    await actIfChanged(
      db,
      "system",
      db
        .update(clientDeploys)
        .set({ status: "failed", error: code, updatedAt: new Date() })
        .where(and(eq(clientDeploys.id, id), notSuperseded)),
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
 * The versions a deploy uploaded, by app, each with the fingerprint of
 * everything that went into it (`uploadFingerprint`).
 */
const recordedSchema = z.object({
  byApp: z.record(
    z.string(),
    z.object({ version: z.string(), fingerprint: z.string() })
  ),
});
type Recorded = z.infer<typeof recordedSchema>["byApp"];

/** The Workers a deploy knows, by app: `client_workers` records these. */
const appSchema = z.enum(clientWorkers.worker.enumValues);

/**
 * The app whose Worker gets the deployment config vars (core reads them),
 * and which the router reaches.
 */
const coreApp = "core";

const configVarNames: ReadonlySet<string> = new Set(deploymentConfigVars);

/**
 * Core's vars: the client's settings, each a JSON var named by its
 * deployment config var (and nothing else: `unknown_setting`), and
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
  const unknown = rows.find(({ key }) => !configVarNames.has(key));
  if (unknown !== undefined) {
    throw new DeployError(
      "unknown_setting",
      `The setting ${unknown.key} isn't a deployment config var`
    );
  }
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

/** The versions `deploy` uploaded before, with their fingerprints. */
const recordedVersions = (deploy: Deploy): Recorded => {
  const recorded = recordedSchema.safeParse(
    JSON.parse(deploy.versions ?? "null")
  );
  return recorded.success ? recorded.data.byApp : {};
};

/**
 * Throws `deploy_superseded` unless deploy `id` is still its client's
 * latest and not superseded: checked right before each thing that goes
 * live, so a deploy superseded while it runs makes nothing more live. (A
 * deploy's single runner is still the precondition: this closes the
 * window, not the race.)
 */
const assertLatest = async (
  db: ConsoleDatabase,
  id: string,
  clientId: string
): Promise<void> => {
  const [row] = await db
    .select({ status: clientDeploys.status })
    .from(clientDeploys)
    .where(eq(clientDeploys.id, id));
  if (
    row === undefined ||
    row.status === "superseded" ||
    (await latestDeployId(db, clientId)) !== id
  ) {
    throw superseded(id);
  }
};

/**
 * Uploads and deploys each of the release's Workers in turn, each live
 * before the next is uploaded. A Worker whose version this deploy already
 * uploaded is deployed, not uploaded again, but only if everything that
 * went into that version is the same now (its fingerprint): secrets,
 * vars, bindings and code.
 */
const deployWorkers = async (
  context: DeployContext,
  id: string,
  deploy: Deploy,
  manifest: ReleaseManifest,
  databases: ReadonlyMap<string, string>
): Promise<Record<string, string>> => {
  const { api, db, store, secrets } = context;
  const { accountId, clientId, releaseId } = deploy;
  const now = context.now?.() ?? new Date();
  // Refused before anything is uploaded: a release with another Worker
  // needs the console to know it first.
  const order = deployOrder(manifest.workers).map((app) => {
    const parsed = appSchema.safeParse(app);
    if (!parsed.success) {
      throw new DeployError(
        "unknown_worker",
        `The console doesn't deploy the Worker ${app}`
      );
    }
    return parsed.data;
  });
  const versions = recordedVersions(deploy);
  const vars = await coreVars(db, deploy);
  for (const app of order) {
    const worker = manifest.workers[app];
    if (worker === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const workerSecretValues = await workerSecrets(
      app,
      worker,
      secrets,
      {
        id: clientId,
        generation: deploy.generation,
        rotationLiveAt: deploy.rotationLiveAt,
      },
      now
    );
    const workerVars = app === coreApp ? vars : {};
    checkBindingNames(worker, workerVars, workerSecretValues);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const fingerprint = await uploadFingerprint(secrets.clientKey, {
      manifest,
      worker,
      databases,
      vars: workerVars,
      secrets: workerSecretValues,
    });
    const recorded = versions[app];
    let versionId =
      recorded?.fingerprint === fingerprint ? recorded.version : undefined;
    if (versionId === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
      const upload = await workerUpload(
        store,
        manifest,
        worker,
        databases,
        workerVars
      );
      // A script upload goes live at once.
      // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
      await assertLatest(db, id, clientId);
      // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
      versionId = await uploadWorker(
        api,
        accountId,
        worker,
        upload,
        workerSecretValues
      );
      versions[app] = { version: versionId, fingerprint };
      // oxlint-disable-next-line no-await-in-loop -- recorded before it's deployed
      await act(
        db,
        "system",
        [
          db
            .update(clientDeploys)
            .set({
              versions: JSON.stringify({ byApp: versions }),
              updatedAt: new Date(),
            })
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
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    await assertLatest(db, id, clientId);
    // oxlint-disable-next-line no-await-in-loop -- live before the next Worker
    await deployWorker(
      api,
      accountId,
      worker,
      versionId,
      `Release ${releaseId} (deploy ${id})`
    );
    const liveAt = new Date();
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    await assertLatest(db, id, clientId);
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
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
            deployedAt: liveAt,
          })
          .onConflictDoUpdate({
            target: [clientWorkers.clientId, clientWorkers.worker],
            set: {
              scriptName: worker.name,
              releaseId,
              versionId,
              deployedAt: liveAt,
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
  return Object.fromEntries(
    Object.entries(versions).map(([app, { version }]) => [app, version])
  );
};

/** Records the account's workers.dev subdomain on the client, audited when it changes. */
const recordSubdomain = async (
  db: ConsoleDatabase,
  clientId: string,
  subdomain: string
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(clients)
      .set({ workersSubdomain: subdomain, updatedAt: new Date() })
      .where(
        and(
          eq(clients.id, clientId),
          or(
            isNull(clients.workersSubdomain),
            ne(clients.workersSubdomain, subdomain)
          )
        )
      ),
    { action: "client.workers_subdomain", clientId, target: subdomain }
  );
};

/**
 * Runs the steps of `deploy` of `manifest`, calling `finished` after each,
 * and `current` as each starts: so a failure is recorded at the step it
 * happened in.
 */
const runSteps = async (
  context: DeployContext,
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
  const { api, db, store, secrets, router } = context;
  const { accountId, clientId } = deploy;
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

  hooks.current("workers");
  const versions = await deployWorkers(
    context,
    id,
    deploy,
    manifest,
    resources.databases
  );
  await hooks.finished("workers", { workers: Object.keys(versions).length });

  hooks.current("smoke");
  const core = manifest.workers[coreApp];
  const coreVersion = versions[coreApp];
  if (core === undefined || coreVersion === undefined) {
    throw new DeployError(
      "unknown_worker",
      `Release ${deploy.releaseId} has no core Worker`
    );
  }
  const subdomain = await workersSubdomain(api, accountId, clientId);
  await recordSubdomain(db, clientId, subdomain);
  const origin = coreOrigin(core.name, subdomain);
  const attempts = await smokeCheck(
    origin,
    await deriveRouterSecret(secrets.routerKey, clientId, deploy.generation),
    coreVersion,
    router.smoke
  );
  await hooks.finished("smoke", { attempts });

  hooks.current("router");
  await registerHostname(
    router.hosts,
    `${clientId}.${router.domain}`,
    { clientId, coreUrl: origin, generation: deploy.generation },
    // The last thing before the write: KV can't make it conditional.
    async () => {
      await assertLatest(db, id, clientId);
    }
  );
  // The map now has the new generation, so the router sends the new
  // secret: a raised generation is live from here, and its previous keys
  // are kept for a window from now (src/deploy/secrets.ts).
  const liveAt = context.now?.() ?? new Date();
  await actIfChanged(
    db,
    "system",
    db
      .update(clients)
      .set({ rotationLiveAt: liveAt, updatedAt: liveAt })
      .where(
        and(
          eq(clients.id, clientId),
          eq(clients.generation, deploy.generation),
          gt(clients.generation, 1),
          isNull(clients.rotationLiveAt)
        )
      ),
    {
      action: "client.rotation_live",
      clientId,
      detail: { generation: deploy.generation },
    }
  );
  await hooks.finished("router", { generation: deploy.generation });
};

/**
 * Runs deploy `id`'s steps, from the first, and marks it done; a deploy
 * already done is left as it is. Run it again to resume one that failed.
 * A deploy that isn't its client's latest is refused
 * (`deploy_superseded`), and so is one superseded before. On a failure it
 * records the step and the error's code, audited, and throws the error.
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
  if (
    deploy.status === "superseded" ||
    (await latestDeployId(db, clientId)) !== id
  ) {
    throw new DeployError(
      "deploy_superseded",
      `A newer deploy of ${clientId} started after ${id}`
    );
  }
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
    const recorded = await actIfChanged(
      db,
      "system",
      db
        .update(clientDeploys)
        .set({ step, status: "running", error: null, updatedAt: new Date() })
        .where(and(eq(clientDeploys.id, id), notSuperseded)),
      {
        action: `deploy.${step}`,
        clientId,
        target: releaseId,
        detail: { deploy: id, ...detail },
      }
    );
    if (!recorded) {
      throw superseded(id);
    }
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

  const done = await actIfChanged(
    db,
    "system",
    db
      .update(clientDeploys)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(clientDeploys.id, id), notSuperseded)),
    {
      action: "deploy.done",
      clientId,
      target: releaseId,
      detail: { deploy: id },
    }
  );
  if (!done) {
    throw superseded(id);
  }
};
