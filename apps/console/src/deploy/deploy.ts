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
 * `runDeploy` runs every step at once. A rollout runs the same steps in
 * phases instead (`prepareDeploy` to `finishDeploy`), each a Workflow
 * step of its own, so it can hold a Worker's traffic split between its
 * previous version and the new one for a while (src/rollout/workflow.ts).
 *
 * A deploy expects to be its client's only runner: provisioning and
 * rollouts claim the client in D1 first (src/runners.ts), and each
 * checks it still holds it before and after each change it makes
 * live, and makes every write to the client's record conditional on it
 * (`DeployContext.runner`). Databases and buckets are unique by name,
 * so two runs at once couldn't make one twice, but a D1 migration could
 * be applied twice, since reading what a database has applied and
 * applying the rest aren't one step.
 *
 * The Cloudflare API token is in `api` alone: never in a row, an audit
 * event or a log line (threat model R17, CO3). A failure is recorded as a
 * code, never as a message or a response body.
 */
import { deploymentConfigVars } from "@grasp-os/shared/deployment-config";
import { log } from "@grasp-os/shared/log";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { deriveRouterSecret, newClientIdSchema } from "@grasp-os/shared/router";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { CloudflareApiError } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { deployVersions, liveVersion } from "../cloudflare/workers.ts";
import { act, actIfChanged, audit } from "../db/act.ts";
import type { Actor, ConsoleDatabase } from "../db/act.ts";
import {
  clientDeploys,
  clients,
  clientWorkers,
  settings,
} from "../db/schema.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { holdsClient, stillHolds } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import { checkDeployedSignIn, derivedCoreConfig } from "./core-config.ts";
import type { SignInApps } from "./core-config.ts";
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
import { sharedSecretsFingerprint, workerSecrets } from "./secrets.ts";
import type { DeploySecrets } from "./secrets.ts";
import {
  checkBindingNames,
  secretsFingerprint,
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
  /**
   * Grasp's OAuth apps' client ids, for core's `SIGN_IN`
   * (src/deploy/core-config.ts); none unless given.
   */
  signInApps?: SignInApps;
  /** The time now: `new Date()` unless a test sets it. */
  now?: () => Date;
  /**
   * The runner the deploy runs as (src/runners.ts): checked to still hold
   * the client right before and after each change that goes live
   * (`assertLatest`, `runner_replaced` otherwise), and every write to the
   * client's record is conditional on it in the same statement. Without
   * one (tests of the deploy alone), neither is checked.
   */
  runner?: HeldClient;
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

/** What a deploy deploys: a release, or only new secrets on the one the client runs. */
export type DeployKind = (typeof clientDeploys.kind.enumValues)[number];

/**
 * Starts deploying release `releaseId` to client `clientId`, and returns
 * the deploy's id for `runDeploy`. The client's older deploys that hadn't
 * finished are superseded in the same batch. A client whose id can't be
 * its hostname (`newClientIdSchema`) is refused. A `secrets` deploy runs
 * the same steps; core records it as new secrets rather than a release.
 */
export const startDeploy = async (
  db: ConsoleDatabase,
  actor: Actor,
  clientId: string,
  releaseId: string,
  kind: DeployKind = "release"
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
        kind,
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
      detail: { deploy: id, kind },
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
      kind: clientDeploys.kind,
      status: clientDeploys.status,
      startedBy: clientDeploys.startedBy,
      createdAt: clientDeploys.createdAt,
      accountId: clients.accountId,
      generation: clients.generation,
      rotationLiveAt: clients.rotationLiveAt,
      signIn: clients.signIn,
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
 * everything that went into it (`uploadFingerprint`), of its secrets
 * alone (`secretsFingerprint`), and of the shared secrets among them
 * (`sharedSecretsFingerprint`).
 */
const recordedSchema = z.object({
  byApp: z.record(
    z.string(),
    z.object({
      version: z.string(),
      fingerprint: z.string(),
      secrets: z.string(),
      shared: z.string(),
    })
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
 * Core's vars: what every deploy derives for the client, its model
 * gateway and sign-in (`derivedCoreConfig`), each replaced by the
 * client's setting of the same name, if it has one; its other settings,
 * each a JSON var named by its deployment config var (and nothing else:
 * `unknown_setting`); and `PLATFORM_CHANGE`, which core records as
 * `platform.updated`: a `release`, or new `secrets` on the release it
 * runs.
 */
const coreVars = async (
  context: DeployContext,
  deploy: Deploy
): Promise<Record<string, unknown>> => {
  const { db } = context;
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
    what: deploy.kind,
    release: deploy.releaseId,
    // When the deploy started: the same however often it's resumed.
    at: deploy.createdAt.toISOString(),
  };
  const vars = {
    ...derivedCoreConfig({
      clientId: deploy.clientId,
      signIn: deploy.signIn,
      domain: context.router.domain,
      apps: context.signInApps ?? {},
    }),
    ...Object.fromEntries(
      rows.map(({ key, value }): [string, unknown] => [key, JSON.parse(value)])
    ),
    PLATFORM_CHANGE: change,
  };
  // The SIGN_IN that goes out, a setting's included: never one no admin
  // can sign in with.
  checkDeployedSignIn(deploy.clientId, vars);
  return vars;
};

/** The deploy's runner lost the client: it stops. */
const runnerReplaced = ({ clientId, runId }: HeldClient): DeployError =>
  new DeployError("runner_replaced", `${runId} no longer holds ${clientId}`);

/**
 * Throws `deploy_superseded` unless deploy `id` is still its client's
 * latest and not superseded, and `runner_replaced` unless its runner
 * still holds the client: checked right before and after each thing
 * that goes live, so a deploy superseded or taken over while it runs
 * makes nothing more live. (A deploy's single runner is still the
 * precondition: this closes the window, not the race.)
 */
const assertLatest = async (
  context: DeployContext,
  id: string,
  clientId: string
): Promise<void> => {
  const { db, runner } = context;
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
  if (
    runner !== undefined &&
    !(await holdsClient(db, runner.clientId, runner.runId))
  ) {
    throw runnerReplaced(runner);
  }
};

/**
 * The condition every write to the client's record carries: that the
 * deploy's runner still holds it (`stillHolds`); none without a runner.
 */
const whileHolding = (context: DeployContext): SQL | undefined =>
  context.runner === undefined ? undefined : stillHolds(context.runner);

/** A Worker the console deploys. */
export type DeployApp = z.infer<typeof appSchema>;

/** A deploy loaded to run: what it deploys where, and the release's manifest. */
interface LoadedDeploy {
  id: string;
  deploy: Deploy;
  manifest: ReleaseManifest;
}

/**
 * Deploy `id`, loaded to run, or null when it's done already. One that
 * isn't its client's latest is refused (`deploy_superseded`), and so is
 * one superseded before, and one whose release isn't imported.
 */
const loadDeploy = async (
  db: ConsoleDatabase,
  id: string
): Promise<LoadedDeploy | null> => {
  const deploy = await deployOf(db, id);
  if (deploy.status === "done") {
    return null;
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
  return { id, deploy, manifest };
};

/**
 * The release's Workers in the order they go live (`deployOrder`),
 * refused (`unknown_worker`) when it has one the console doesn't know,
 * before anything is uploaded.
 */
const appsOf = (manifest: ReleaseManifest): DeployApp[] =>
  deployOrder(manifest.workers).map((app) => {
    const parsed = appSchema.safeParse(app);
    if (!parsed.success) {
      throw new DeployError(
        "unknown_worker",
        `The console doesn't deploy the Worker ${app}`
      );
    }
    return parsed.data;
  });

/** The release's Worker `app`, which `appsOf` listed. */
const workerOf = (manifest: ReleaseManifest, app: DeployApp): WorkerEntry => {
  const worker = manifest.workers[app];
  if (worker === undefined) {
    throw new DeployError("unknown_worker", `The release has no ${app} Worker`);
  }
  return worker;
};

/**
 * Records that `step` of `loaded` finished, with what it did, audited;
 * throws `deploy_superseded` when the deploy was superseded meanwhile.
 */
const recordStep = async (
  db: ConsoleDatabase,
  { id, deploy }: LoadedDeploy,
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
      clientId: deploy.clientId,
      target: deploy.releaseId,
      detail: { deploy: id, ...detail },
    }
  );
  if (!recorded) {
    throw superseded(id);
  }
};

/**
 * Runs `task` on deploy `id`, from `first`, and returns what it returns
 * with the deploy it loaded; null when the deploy is done already. `task`
 * says which step it's in as it goes (`current`), so a failure is
 * recorded, audited, at the step it happened in, and thrown.
 */
const runPhase = async <T>(
  context: DeployContext,
  id: string,
  first: DeployStep,
  task: (
    loaded: LoadedDeploy,
    current: (step: DeployStep) => void
  ) => Promise<T>
): Promise<{ loaded: LoadedDeploy; result: T } | null> => {
  const { db } = context;
  const loaded = await loadDeploy(db, id);
  if (loaded === null) {
    return null;
  }
  const { clientId, releaseId } = loaded.deploy;
  let step = first;
  try {
    const result = await task(loaded, (next) => {
      step = next;
    });
    return { loaded, result };
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
};

/**
 * The first two steps: the account's resources, then the release's
 * database migrations. Returns its databases' ids, by name.
 */
const prepare = async (
  context: DeployContext,
  loaded: LoadedDeploy,
  current: (step: DeployStep) => void
): Promise<ReadonlyMap<string, string>> => {
  const { api, db, store } = context;
  const { deploy, manifest } = loaded;
  current("resources");
  const resources = await ensureResources(api, deploy.accountId, manifest);
  await recordStep(db, loaded, "resources", {
    databases: resources.databases.size,
    buckets: resources.buckets.length,
  });

  current("migrations");
  // Migrations change the client's databases: only while this deploy is
  // its latest and its runner holds it.
  await assertLatest(context, loaded.id, deploy.clientId);
  const applied = await migrateDatabases(
    api,
    deploy.accountId,
    resources.databases,
    manifest,
    store
  );
  await recordStep(db, loaded, "migrations", {
    applied: [...applied.values()].reduce((sum, count) => sum + count, 0),
  });
  return resources.databases;
};

/**
 * The versions deploy `id` recorded, read afresh: an upload records each
 * as it's made, so a later Worker's upload keeps an earlier one's.
 */
const recordedNow = async (
  db: ConsoleDatabase,
  id: string
): Promise<Recorded> => {
  const [row] = await db
    .select({ versions: clientDeploys.versions })
    .from(clientDeploys)
    .where(eq(clientDeploys.id, id));
  const recorded = recordedSchema.safeParse(
    JSON.parse(row?.versions ?? "null")
  );
  return recorded.success ? recorded.data.byApp : {};
};

/**
 * Uploads `app`'s Worker as a new version with its secrets, and returns
 * the version's id with its secrets' fingerprint. A Worker whose version
 * this deploy already uploaded isn't uploaded again, but only if
 * everything that went into that version is the same now (its
 * fingerprint): secrets, vars, bindings and code. A script upload (a
 * Worker's first, or one with Durable Object migrations) is live at once.
 */
const uploadApp = async (
  context: DeployContext,
  loaded: LoadedDeploy,
  app: DeployApp,
  databases: ReadonlyMap<string, string>
): Promise<{ version: string; secrets: string }> => {
  const { api, db, store, secrets } = context;
  const { id, deploy, manifest } = loaded;
  const { accountId, clientId, releaseId } = deploy;
  const worker = workerOf(manifest, app);
  // Read for every Worker, so a bad setting stops the deploy before the
  // first one is uploaded (`unknown_setting`).
  const vars = await coreVars(context, deploy);
  const workerSecretValues = await workerSecrets(
    app,
    worker,
    secrets,
    {
      id: clientId,
      generation: deploy.generation,
      rotationLiveAt: deploy.rotationLiveAt,
    },
    context.now?.() ?? new Date()
  );
  const workerVars = app === coreApp ? vars : {};
  checkBindingNames(worker, workerVars, workerSecretValues);
  const fingerprint = await uploadFingerprint(secrets.clientKey, {
    manifest,
    worker,
    databases,
    vars: workerVars,
    secrets: workerSecretValues,
  });
  const secretsPrint = await secretsFingerprint(
    secrets.clientKey,
    workerSecretValues
  );
  const sharedPrint = await sharedSecretsFingerprint(secrets, app);
  const versions = await recordedNow(db, id);
  const recorded = versions[app];
  if (recorded?.fingerprint === fingerprint) {
    return { version: recorded.version, secrets: secretsPrint };
  }
  const upload = await workerUpload(
    store,
    manifest,
    worker,
    databases,
    workerVars
  );
  // A script upload goes live at once.
  await assertLatest(context, id, clientId);
  const versionId = await uploadWorker(
    api,
    accountId,
    worker,
    upload,
    workerSecretValues
  );
  versions[app] = {
    version: versionId,
    fingerprint,
    secrets: secretsPrint,
    shared: sharedPrint,
  };
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
  return { version: versionId, secrets: secretsPrint };
};

/**
 * Sends all of `app`'s traffic to `versionId`, with what goes with it
 * (`deployWorker`), and records it as what the client runs.
 */
const goLive = async (
  context: DeployContext,
  loaded: LoadedDeploy,
  app: DeployApp,
  versionId: string
): Promise<void> => {
  const { api, db } = context;
  const { id, deploy, manifest } = loaded;
  const { accountId, clientId, releaseId } = deploy;
  const worker = workerOf(manifest, app);
  await assertLatest(context, id, clientId);
  await deployWorker(
    api,
    accountId,
    worker,
    versionId,
    `Release ${releaseId} (deploy ${id})`
  );
  const liveAt = new Date();
  await assertLatest(context, id, clientId);
  // Only while the runner holds the client, in the same statement: a
  // rollback that took it over keeps its own record.
  const recorded = await actIfChanged(
    db,
    "system",
    db
      .insert(clientWorkers)
      .select(
        sql`SELECT ${clientId}, ${app}, ${worker.name}, ${releaseId}, ${versionId}, ${liveAt.getTime()} WHERE ${whileHolding(context) ?? sql`1 = 1`}`
      )
      .onConflictDoUpdate({
        target: [clientWorkers.clientId, clientWorkers.worker],
        set: {
          scriptName: worker.name,
          releaseId,
          versionId,
          deployedAt: liveAt,
        },
      }),
    {
      action: "deploy.worker_live",
      clientId,
      target: releaseId,
      detail: { deploy: id, worker: app, version: versionId },
    }
  );
  if (!recorded && context.runner !== undefined) {
    throw runnerReplaced(context.runner);
  }
};

/** Records the account's workers.dev subdomain on the client, audited when it changes. */
const recordSubdomain = async (
  context: DeployContext,
  clientId: string,
  subdomain: string
): Promise<void> => {
  const { db } = context;
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
          ),
          whileHolding(context)
        )
      ),
    { action: "client.workers_subdomain", clientId, target: subdomain }
  );
};

/**
 * The last steps, once every Worker is live: the smoke check that core
 * answers as the version this deploy uploaded, then the client's hostname
 * in the router's map.
 */
const finish = async (
  context: DeployContext,
  loaded: LoadedDeploy,
  current: (step: DeployStep) => void
): Promise<void> => {
  const { api, db, secrets, router } = context;
  const { id, deploy, manifest } = loaded;
  const { accountId, clientId } = deploy;
  current("smoke");
  await assertLatest(context, id, clientId);
  const core = manifest.workers[coreApp];
  const recorded = await recordedNow(db, id);
  const coreVersion = recorded[coreApp]?.version;
  if (core === undefined || coreVersion === undefined) {
    throw new DeployError(
      "unknown_worker",
      `Release ${deploy.releaseId} has no core Worker`
    );
  }
  const subdomain = await workersSubdomain(api, accountId, clientId);
  await recordSubdomain(context, clientId, subdomain);
  const origin = coreOrigin(core.name, subdomain);
  const attempts = await smokeCheck(
    origin,
    await deriveRouterSecret(secrets.routerKey, clientId, deploy.generation),
    coreVersion,
    router.smoke
  );
  await recordStep(db, loaded, "smoke", { attempts });

  current("router");
  await registerHostname(
    router.hosts,
    `${clientId}.${router.domain}`,
    { clientId, coreUrl: origin, generation: deploy.generation },
    // The last thing before the write: KV can't make it conditional.
    async () => {
      await assertLatest(context, id, clientId);
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
          isNull(clients.rotationLiveAt),
          whileHolding(context)
        )
      ),
    {
      action: "client.rotation_live",
      clientId,
      detail: { generation: deploy.generation },
    }
  );
  await recordStep(db, loaded, "router", { generation: deploy.generation });
};

/** Marks `loaded` done, audited; throws `deploy_superseded` if it was superseded meanwhile. */
const markDone = async (
  db: ConsoleDatabase,
  { id, deploy }: LoadedDeploy
): Promise<void> => {
  const done = await actIfChanged(
    db,
    "system",
    db
      .update(clientDeploys)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(clientDeploys.id, id), notSuperseded)),
    {
      action: "deploy.done",
      clientId: deploy.clientId,
      target: deploy.releaseId,
      detail: { deploy: id },
    }
  );
  if (!done) {
    throw superseded(id);
  }
};

/**
 * Runs deploy `id`'s steps, from the first, and marks it done; a deploy
 * already done is left as it is. Run it again to resume one that failed.
 * Each Worker is uploaded and sent all traffic before the next is
 * uploaded. A deploy that isn't its client's latest is refused
 * (`deploy_superseded`), and so is one superseded before. On a failure it
 * records the step and the error's code, audited, and throws the error.
 */
export const runDeploy = async (
  context: DeployContext,
  id: string
): Promise<void> => {
  const ran = await runPhase(
    context,
    id,
    "resources",
    async (loaded, current) => {
      const databases = await prepare(context, loaded, current);
      current("workers");
      const apps = appsOf(loaded.manifest);
      for (const app of apps) {
        // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
        const { version } = await uploadApp(context, loaded, app, databases);
        // oxlint-disable-next-line no-await-in-loop -- live before the next Worker
        await goLive(context, loaded, app, version);
      }
      await recordStep(context.db, loaded, "workers", { workers: apps.length });
      await finish(context, loaded, current);
    }
  );
  if (ran !== null) {
    await markDone(context.db, ran.loaded);
  }
};

/*
 * A gradual deploy, as a rollout runs it (src/rollout/workflow.ts): the
 * steps of `runDeploy` in phases a Workflow runs as steps of its own, so
 * it can hold a Worker's traffic split between versions for a while in
 * between. Each phase finds what an earlier run of it made, as
 * `runDeploy` does, and records a failure at its step.
 */

/** What `prepareDeploy` leaves for the next phases: identifiers only. */
export interface PreparedDeploy {
  /** The account's databases' ids, by name. */
  databases: Record<string, string>;
  /** The release's Workers, in the order they go live. */
  apps: DeployApp[];
  /** The secrets generation the new versions carry. */
  generation: number;
}

/**
 * The first phase of a gradual deploy: the account's resources and the
 * release's migrations. Null when the deploy is done already.
 */
export const prepareDeploy = async (
  context: DeployContext,
  id: string
): Promise<PreparedDeploy | null> => {
  const ran = await runPhase(
    context,
    id,
    "resources",
    async (loaded, current) => {
      const databases = await prepare(context, loaded, current);
      current("workers");
      return {
        databases: Object.fromEntries(databases),
        apps: appsOf(loaded.manifest),
        generation: loaded.deploy.generation,
      };
    }
  );
  return ran?.result ?? null;
};

/** A Worker's version, as `uploadDeployWorker` made or found it. */
export interface UploadedWorker {
  version: string;
  /**
   * Whether all its traffic goes to it already: a script upload (a
   * Worker's first, or one with Durable Object migrations) is live at
   * once, and so is one an earlier run of a later phase deployed.
   */
  live: boolean;
  /**
   * Whether it runs with the same secrets as the version it replaces, as
   * the client's deploys recorded them: only then may the two share
   * traffic. False when that version's secrets aren't on record.
   */
  sameSecrets: boolean;
}

/**
 * The fingerprint `print` (of all its secrets, or of its shared ones) the
 * latest of client `clientId`'s deploys to record `app`'s version
 * `version` recorded for it; null when none did (a version uploaded
 * outside the console, or before deploys recorded one).
 */
export const recordedPrintOf = async (
  db: ConsoleDatabase,
  clientId: string,
  app: string,
  version: string,
  print: "secrets" | "shared"
): Promise<string | null> => {
  const [row] = await db
    .select({
      secrets: sql<
        string | null
      >`json_extract(${clientDeploys.versions}, ${`$.byApp.${app}.${print}`})`,
    })
    .from(clientDeploys)
    .where(
      and(
        eq(clientDeploys.clientId, clientId),
        sql`json_extract(${clientDeploys.versions}, ${`$.byApp.${app}.version`}) = ${version}`
      )
    )
    .orderBy(desc(clientDeploys.createdAt))
    .limit(1);
  return row?.secrets ?? null;
};

/**
 * Uploads `app`'s Worker with its secrets, unless the deploy uploaded it
 * already (`uploadApp`), and says whether it has the same secrets as
 * `previous`, the version it replaces. Null when the deploy is done
 * already.
 */
export const uploadDeployWorker = async (
  context: DeployContext,
  id: string,
  app: DeployApp,
  databases: Record<string, string>,
  previous: string | undefined
): Promise<UploadedWorker | null> => {
  const ran = await runPhase(context, id, "workers", async (loaded) => {
    const { version, secrets } = await uploadApp(
      context,
      loaded,
      app,
      new Map(Object.entries(databases))
    );
    const live = await liveVersion(
      context.api,
      loaded.deploy.accountId,
      workerOf(loaded.manifest, app).name
    );
    const previousSecrets =
      previous === undefined
        ? null
        : await recordedPrintOf(
            context.db,
            loaded.deploy.clientId,
            app,
            previous,
            "secrets"
          );
    return {
      version,
      live: live === version,
      sameSecrets: previousSecrets === secrets,
    };
  });
  return ran?.result ?? null;
};

/**
 * Sends `percent` of `app`'s traffic to `version` and the rest to
 * `previous`, the version it ran before: a gradual deployment's step,
 * audited as `deploy.traffic`. The versions go as uploaded, with their
 * own secrets.
 */
export const shiftDeployTraffic = async (
  context: DeployContext,
  id: string,
  app: DeployApp,
  traffic: { version: string; previous: string; percent: number }
): Promise<void> => {
  await runPhase(context, id, "workers", async (loaded) => {
    const { api, db } = context;
    const { accountId, clientId, releaseId } = loaded.deploy;
    const { version, previous, percent } = traffic;
    await assertLatest(context, id, clientId);
    await deployVersions(
      api,
      accountId,
      workerOf(loaded.manifest, app).name,
      [
        { version_id: version, percentage: percent },
        { version_id: previous, percentage: 100 - percent },
      ],
      { message: `Release ${releaseId} (deploy ${id}) at ${percent}%` }
    );
    await assertLatest(context, id, clientId);
    await audit(db, "system", {
      action: "deploy.traffic",
      clientId,
      target: releaseId,
      detail: { deploy: id, worker: app, version, percent },
    });
  });
};

/**
 * Sends all of `app`'s traffic to `version`, with what goes with it, and
 * records it as what the client runs (`goLive`).
 */
export const makeDeployWorkerLive = async (
  context: DeployContext,
  id: string,
  app: DeployApp,
  version: string
): Promise<void> => {
  await runPhase(context, id, "workers", async (loaded) => {
    await goLive(context, loaded, app, version);
  });
};

/**
 * The last phase, once every Worker is live: the smoke check and the
 * router (`finish`), then the deploy marked done.
 */
export const finishDeploy = async (
  context: DeployContext,
  id: string
): Promise<void> => {
  const ran = await runPhase(
    context,
    id,
    "workers",
    async (loaded, current) => {
      await recordStep(context.db, loaded, "workers", {
        workers: appsOf(loaded.manifest).length,
      });
      await finish(context, loaded, current);
    }
  );
  if (ran !== null) {
    await markDone(context.db, ran.loaded);
  }
};
