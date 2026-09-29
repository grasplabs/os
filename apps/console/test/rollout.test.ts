import { platformChangeSchema } from "@grasp-os/shared/platform-change";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { setFeature } from "../src/clients/settings.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import { deployVersion, deployVersions } from "../src/cloudflare/workers.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clientDeploys,
  clientRuns,
  clients,
  clientWorkers,
  rollouts,
  rolloutTargets,
  settings,
} from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { rotateClientSecrets } from "../src/deploy/rotation.ts";
import { startProvisioning } from "../src/provision/control.ts";
import { importReleases } from "../src/releases/import.ts";
import {
  approveRollout,
  cancelRollout,
  pauseRollout,
  pinClient,
  resumeRollout,
  startRollout,
} from "../src/rollout/control.ts";
import type { StartRolloutInput } from "../src/rollout/control.ts";
import { driftOf } from "../src/rollout/drift.ts";
import {
  rollbackClient,
  rollbackClientAndWait,
  rollbackRing,
  rollbackRingAndWait,
} from "../src/rollout/rollback.ts";
import { checkRevocation } from "../src/rollout/shared-secrets.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";
import {
  emptyStoreSecret,
  setStoreSecret,
  useStoreSecrets,
} from "./secrets-store.ts";

const token = "test-deployer-token-rollout-5d1e7a";
const tenantToken = "test-tenant-admin-token-rollout-9c3f20";
const cloudflare = mockCloudflareApi(token, tenantToken);
const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A release, published and imported. */
const importedRelease = async (notes: string): Promise<string> => {
  const release = await publishRelease({ notes });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/**
 * An active client in `ring` on a new account in the fake, running
 * `releaseId` as a deploy made it.
 */
const activeClient = async (
  ring: number,
  releaseId: string
): Promise<{ clientId: string; account: AccountState }> => {
  const account = cloudflare.addAccount();
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: clientId,
        accountId: account.id,
        ring,
        status: "active",
        signIn: JSON.stringify({
          domains: ["acme.test"],
          admins: ["ada@acme.test"],
          googleHostedDomain: "acme.test",
        }),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, clientId, releaseId)
  );
  return { clientId, account };
};

/**
 * The rollouts the test starts, as the test pool lets a test follow them:
 * pauses and retry delays going at once. Each wait is on the latest
 * rollout started.
 */
const followRollouts = async () => {
  const runs = await introspectWorkflow(env.ROLLOUT);
  await runs.modifyAll(async (modifier) => {
    await modifier.disableSleeps();
    await modifier.disableRetryDelays();
  });
  const latest = async () => {
    const all = await runs.get();
    const last = all.at(-1);
    if (last === undefined) {
      throw new Error("No rollout was started");
    }
    return last;
  };
  return {
    waitForStepResult: async (step: { name: string }) => {
      const run = await latest();
      return await run.waitForStepResult(step);
    },
    waitForStatus: async (status: InstanceStatus["status"]) => {
      const run = await latest();
      await run.waitForStatus(status);
    },
    [Symbol.asyncDispose]: async () => {
      await runs.dispose();
    },
  };
};

/** A Workflow instance as the test pool lets a test follow it. */
type FollowedRun = Awaited<
  ReturnType<Awaited<ReturnType<typeof introspectWorkflow>>["get"]>
>[number];

/** Waits until `run` has ended, finished or not. */
const settled = async (run: FollowedRun): Promise<void> => {
  try {
    await run.waitForStatus("complete");
  } catch {
    // It ended otherwise: an error is a finite status too.
    await run.waitForStatus("errored");
  }
};

/**
 * The rollbacks the test starts, retry delays going at once: `rollBack`
 * starts one and waits until its run has ended, `waitForAll` waits for
 * every one started.
 */
const followRollbacks = async () => {
  const runs = await introspectWorkflow(env.ROLLBACK_CLIENT);
  await runs.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  return {
    rollBack: async (rolloutId: string, clientId: string): Promise<string> => {
      const runId = await rollbackClient(env, staff, rolloutId, clientId);
      const all = await runs.get();
      const last = all.at(-1);
      if (last !== undefined) {
        await settled(last);
      }
      return runId;
    },
    /** Starts one, and waits until its run finished step `name`. */
    startUntil: async (
      rolloutId: string,
      clientId: string,
      name: string
    ): Promise<void> => {
      await rollbackClient(env, staff, rolloutId, clientId);
      const all = await runs.get();
      await all.at(-1)?.waitForStepResult({ name });
    },
    waitForAll: async (): Promise<void> => {
      const all = await runs.get();
      await Promise.all(all.map(settled));
    },
    [Symbol.asyncDispose]: async () => {
      await runs.dispose();
    },
  };
};

/** A deployment's body, as the fake reads its versions' shares. */
const deploymentBodySchema = z.object({
  versions: z.array(z.object({ percentage: z.number() })),
});

/** A deployment call for `script` sending `percent` to its first version. */
const isDeploymentAt =
  (script: string, percent: number) =>
  (call: { method: string; path: string; body: unknown }): boolean => {
    const deployment = deploymentBodySchema.safeParse(call.body);
    return (
      call.method === "POST" &&
      call.path.endsWith(`/workers/scripts/${script}/deployments`) &&
      deployment.success &&
      deployment.data.versions[0]?.percentage === percent
    );
  };

/** The rollout running now, as a hook in the fake finds it. */
const openRollout = async (): Promise<string> => {
  const [open] = await db
    .select({ id: rollouts.id })
    .from(rollouts)
    .where(eq(rollouts.status, "running"));
  return open?.id ?? "";
};

/** Waits (a little at a time, bounded) until `landed` says so. */
const until = async (landed: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 500 && !landed(); tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polled until it holds
    await scheduler.wait(10);
  }
};

/**
 * Makes the rollout's `percent` deployment of `script` land late: a
 * rollback takes the client and restores its versions while that
 * deployment is on its way, then the deployment lands, before the
 * rollback reads what runs again and releases the client.
 */
const landLateDuringRollback = (
  rollbacks: Awaited<ReturnType<typeof followRollbacks>>,
  client: { clientId: string; account: AccountState },
  script: string,
  percent: number
): void => {
  const deployments = (): number =>
    client.account.scripts.get(script)?.deployments.length ?? 0;
  cloudflare.beforeAnswering(isDeploymentAt(script, percent), async () => {
    const rolloutId = await openRollout();
    await rollbacks.startUntil(rolloutId, client.clientId, "restore");
    // The rollout's deployment is the next one to land.
    const restored = deployments();
    // The rollback's read again, right before it records: only once the
    // rollout's deployment has landed.
    cloudflare.beforeAnswering(
      (call) =>
        call.method === "GET" &&
        call.path.endsWith(`/workers/scripts/${script}/deployments`),
      async () => {
        await until(() => deployments() > restored);
      }
    );
  });
};

/** Starts a rollout of `releaseId` for `scope`, as staff. */
const rollOut = async (
  releaseId: string,
  scope: StartRolloutInput["scope"]
): Promise<string> =>
  await startRollout(env, staff, { kind: "release", releaseId, scope });

/** Starts a secrets rollout for `scope`, as staff. */
const rollOutSecrets = async (
  scope: StartRolloutInput["scope"]
): Promise<string> =>
  await startRollout(env, staff, { kind: "secrets", scope });

/** The release and version each of the client's Workers runs, as the console recorded it. */
const workersOf = async (clientId: string) =>
  await db
    .select({
      worker: clientWorkers.worker,
      scriptName: clientWorkers.scriptName,
      releaseId: clientWorkers.releaseId,
      versionId: clientWorkers.versionId,
    })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId))
    .orderBy(asc(clientWorkers.worker));

/**
 * Each deployment of `script` in `account` after the first `skip`, oldest
 * first: every version's share of the traffic, the version named by its
 * position in `versions`.
 */
const deploymentsOf = (
  account: AccountState,
  script: string,
  skip: number,
  versions: readonly string[]
): number[][] => {
  const deployments = account.scripts.get(script)?.deployments ?? [];
  return deployments
    .toReversed()
    .slice(skip)
    .map((deployment) =>
      versions.map(
        (version) =>
          deployment.versions.find(({ version_id }) => version_id === version)
            ?.percentage ?? 0
      )
    );
};

/** How many deployments each of the account's scripts has had. */
const deploymentCounts = (account: AccountState): Record<string, number> =>
  Object.fromEntries(
    [...account.scripts].map(([name, script]) => [
      name,
      script.deployments.length,
    ])
  );

const rolloutRow = async (id: string) => {
  const [row] = await db
    .select({ status: rollouts.status, ring: rollouts.ring })
    .from(rollouts)
    .where(eq(rollouts.id, id));
  return row;
};

/** The rollout's targets: each client's ring, status and error, by client. */
const targetsOf = async (rolloutId: string) => {
  const rows = await db
    .select({
      clientId: rolloutTargets.clientId,
      ring: rolloutTargets.ring,
      status: rolloutTargets.status,
      error: rolloutTargets.error,
    })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, rolloutId));
  return Object.fromEntries(
    rows.map(({ clientId, ...target }) => [clientId, target])
  );
};

/** The runner client `clientId` has, if any. */
const runnerOf = async (clientId: string) => {
  const [row] = await db
    .select({ runId: clientRuns.runId, kind: clientRuns.kind })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  return row ?? null;
};

/** The rollout's own audit actions, oldest first. */
const rolloutActions = async (rolloutId: string): Promise<string[]> => {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.target, rolloutId),
        sql`${auditEvents.action} LIKE 'rollout.%'`
      )
    )
    // Events of one millisecond in the order they were written.
    .orderBy(asc(auditEvents.at), sql`rowid`);
  return rows.map(({ action }) => action);
};

/** A Workflow instance method a test's stand-in never expects called. */
const unused = async (): Promise<never> =>
  await Promise.reject(new Error("Not expected to be called"));

/** An audit event's detail, parsed. */
const parsedDetail = (detail: string | null): unknown =>
  JSON.parse(detail ?? "null");

/** The code `promise` is refused with, or `resolved` if it isn't. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? error.code
      : "not a rollout error";
  }
  return "resolved";
};

/** The version all of `script`'s traffic goes to in `account`, if one does. */
const liveOf = (account: AccountState, script: string): string | undefined => {
  const [current] = account.scripts.get(script)?.deployments ?? [];
  const [only, ...others] = current?.versions ?? [];
  return others.length === 0 && only?.percentage === 100
    ? only.version_id
    : undefined;
};

/**
 * Before each test: the database outlives each test, and every rollout
 * reaches ring 0, so each test's rollouts reach only its own clients, and
 * start while no earlier test's rollout is open.
 */
const setAsideEarlierTests = async (): Promise<void> => {
  await db
    .update(clients)
    .set({ status: "offboarded" })
    .where(eq(clients.status, "active"));
  await db
    .update(rollouts)
    .set({ status: "cancelled" })
    .where(inArray(rollouts.status, ["running", "waiting"]));
};

describe("rolling a release out", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(setAsideEarlierTests);

  it("deploys ring 0 gradually, connect then core, waits for approval, then deploys the next ring, audited", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const acme = await activeClient(2, before);
    const release = await importedRelease("feat(core): roll me out");
    const [internalConnect, internalCore] = await workersOf(internal.clientId);
    const acmeCounts = deploymentCounts(acme.account);
    const skip = deploymentCounts(internal.account);
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 2 });
    await expect(
      run.waitForStepResult({ name: "ring 2 approved" })
    ).resolves.toBe("waiting");

    // Ring 0 is on the release, each Worker by stages; ring 2 isn't touched.
    const [connect, core] = await workersOf(internal.clientId);
    const stagesOf = (
      now: typeof connect,
      previous: typeof connect
    ): number[][] =>
      deploymentsOf(
        internal.account,
        now?.scriptName ?? "",
        skip[now?.scriptName ?? ""] ?? 0,
        [now?.versionId ?? "", previous?.versionId ?? ""]
      );
    const stages = [
      [10, 90],
      [50, 50],
      [100, 0],
    ];
    expect({
      releases: [connect?.releaseId, core?.releaseId],
      connect: stagesOf(connect, internalConnect),
      core: stagesOf(core, internalCore),
      acme: deploymentCounts(acme.account),
      rollout: await rolloutRow(rolloutId),
      runner: await runnerOf(internal.clientId),
      // One rollout at a time: this one still owns ring 2.
      another: await codeOf(rollOut(release, { scope: "all" })),
    }).toStrictEqual({
      releases: [release, release],
      connect: stages,
      core: stages,
      acme: acmeCounts,
      rollout: { status: "waiting", ring: 0 },
      runner: null,
      another: "rollout_running",
    });

    await approveRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    const acmeWorkers = await workersOf(acme.clientId);
    expect({
      releases: acmeWorkers.map(({ releaseId }) => releaseId),
      rollout: await rolloutRow(rolloutId),
      targets: await targetsOf(rolloutId),
      actions: await rolloutActions(rolloutId),
      // Approving again, once it's moved on, is refused.
      again: await codeOf(approveRollout(env, staff, rolloutId)),
    }).toStrictEqual({
      releases: [release, release],
      rollout: { status: "done", ring: 2 },
      targets: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
        [acme.clientId]: { ring: 2, status: "done", error: null },
      },
      actions: [
        "rollout.start",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.wait",
        "rollout.approve",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.done",
      ],
      again: "not_waiting",
    });
    // The rollout keeps core's model gateway and sign-in.
    const acmeCore = acmeWorkers.find(({ worker }) => worker === "core");
    const vars = Object.fromEntries(
      z
        .array(z.object({ name: z.string(), json: z.unknown().optional() }))
        .parse(
          acme.account.scripts
            .get(acmeCore?.scriptName ?? "")
            ?.versions.find(({ id }) => id === acmeCore?.versionId)?.metadata
            .bindings ?? []
        )
        .map(({ name, json }): [string, unknown] => [name, json])
    );
    expect({
      gateway: vars.MODEL_GATEWAY,
      origin: z.object({ origin: z.string() }).parse(vars.SIGN_IN).origin,
    }).toMatchObject({
      gateway: { gateway: "grasp-os" },
      origin: `https://${acme.clientId}.grasp.test`,
    });
  });

  it("lets a new rollout start once the waiting one's run was ended outside the console, marking that one failed", async () => {
    const before = await importedRelease("feat(core): the release before");
    await activeClient(0, before);
    await activeClient(1, before);
    const release = await importedRelease("feat(core): ended elsewhere");
    await using run = await followRollouts();
    const first = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });

    // Terminated from the dashboard: the console's row still says waiting.
    const instance = await env.ROLLOUT.get(first);
    await instance.terminate();
    await run.waitForStatus("terminated");
    const second = await rollOut(release, { scope: "ring", ring: 1 });

    expect({
      first: await rolloutRow(first),
      second: await rolloutRow(second),
      ended: await rolloutActions(first),
    }).toStrictEqual({
      first: { status: "failed", ring: 0 },
      second: { status: "running", ring: 0 },
      ended: [
        "rollout.start",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.wait",
        "rollout.fail",
      ],
    });
  });

  it("sends an approval again when its event didn't reach the run, once staff approve again", async () => {
    const before = await importedRelease("feat(core): the release before");
    await activeClient(0, before);
    const acme = await activeClient(1, before);
    const release = await importedRelease("feat(core): approved twice");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });
    // The approval is recorded, and its event is lost on its way.
    const losing: WorkflowInstance = {
      id: rolloutId,
      pause: unused,
      resume: unused,
      terminate: unused,
      restart: unused,
      delete: unused,
      status: unused,
      subscribe: unused,
      sendEvent: async () => {
        await Promise.reject(new Error("The event was lost"));
      },
    };
    const lost = vi.spyOn(env.ROLLOUT, "get").mockResolvedValueOnce(losing);
    const first = await codeOf(approveRollout(env, staff, rolloutId));
    lost.mockRestore();

    await approveRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    const workers = await workersOf(acme.clientId);
    const actions = await rolloutActions(rolloutId);
    expect({
      first,
      acme: workers.map(({ releaseId }) => releaseId),
      approvals: actions.filter((action) =>
        action.startsWith("rollout.approve")
      ),
    }).toStrictEqual({
      first: "not a rollout error",
      acme: [release, release],
      approvals: ["rollout.approve", "rollout.approve_resend"],
    });
  });

  it("makes the AI Gateway core's config names in a client's account that has none, once", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    // Deployed some other way than the console's deploys: no gateway.
    internal.account.gateways.splice(0);
    const release = await importedRelease("feat(core): needs its gateway");
    const creates = () =>
      cloudflare.calls.filter(
        ({ method, path }) =>
          method === "POST" &&
          path === `/accounts/${internal.account.id}/ai-gateway/gateways`
      ).length;
    const createdBefore = creates();
    await using run = await followRollouts();

    await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    expect({
      gateways: internal.account.gateways.map(({ id }) => id),
      created: creates() - createdBefore,
    }).toStrictEqual({ gateways: ["grasp-os"], created: 1 });
  });

  it("sends each Worker all its traffic at once, never split, while a secrets rotation is still to go live", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const skip = deploymentCounts(internal.account);
    await rotateClientSecrets(db, staff, internal.clientId, new Date());
    const release = await importedRelease("feat(core): with new secrets");
    await using run = await followRollouts();

    await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const workers = await workersOf(internal.clientId);
    expect(
      Object.fromEntries(
        workers.map(({ worker, scriptName, versionId }) => [
          worker,
          deploymentsOf(internal.account, scriptName, skip[scriptName] ?? 0, [
            versionId ?? "",
          ]),
        ])
      )
    ).toStrictEqual({ connect: [[100]], core: [[100]] });
  });

  it("skips a client on a newer release than the rollout's, unless it's pinned to the rollout's", async () => {
    const older = await importedRelease("feat(core): the older release");
    const newer = await importedRelease("feat(core): the newer release");
    const ahead = await activeClient(0, newer);
    const pinned = await activeClient(0, newer);
    await db
      .update(clients)
      .set({ pinnedReleaseId: older })
      .where(eq(clients.id, pinned.clientId));
    const aheadCounts = deploymentCounts(ahead.account);
    await using run = await followRollouts();

    const rolloutId = await rollOut(older, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const pinnedWorkers = await workersOf(pinned.clientId);
    expect({
      targets: await targetsOf(rolloutId),
      ahead: deploymentCounts(ahead.account),
      pinned: pinnedWorkers.map(({ releaseId }) => releaseId),
    }).toStrictEqual({
      targets: {
        [ahead.clientId]: { ring: 0, status: "skipped", error: "newer" },
        [pinned.clientId]: { ring: 0, status: "done", error: null },
      },
      ahead: aheadCounts,
      pinned: [older, older],
    });
  });

  it("writes nothing to a client's record once another runner took the client from it", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const [connect] = await workersOf(internal.clientId);
    const script = connect?.scriptName ?? "";
    const release = await importedRelease("feat(core): taken over");
    // Another runner takes the client once the rollout's connect is live
    // and the rollout checked it still holds it: right before the batch
    // that records it, so only the batch's own condition can refuse it.
    let takeOver = false;
    cloudflare.beforeAnswering(isDeploymentAt(script, 100), async () => {
      takeOver = true;
      await Promise.resolve();
    });
    const batch = env.DB.batch.bind(env.DB);
    const racing = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (takeOver) {
          takeOver = false;
          await env.DB.prepare(
            "UPDATE client_runs SET run_id = 'someone-else' WHERE client_id = ?"
          )
            .bind(internal.clientId)
            .run();
        }
        return await batch(statements);
      });
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("errored");
    racing.mockRestore();

    const [connectNow] = await workersOf(internal.clientId);
    expect({
      recorded: {
        release: connectNow?.releaseId,
        version: connectNow?.versionId,
      },
      targets: await targetsOf(rolloutId),
      runner: await runnerOf(internal.clientId),
    }).toStrictEqual({
      recorded: { release: before, version: connect?.versionId },
      targets: {
        [internal.clientId]: {
          ring: 0,
          status: "failed",
          error: "runner_replaced",
        },
      },
      runner: { runId: "someone-else", kind: "rollout" },
    });
  });

  it("skips a client pinned to another release, whatever it runs now", async () => {
    const older = await importedRelease("feat(core): what it runs");
    const internal = await activeClient(0, older);
    const pin = await importedRelease("feat(core): what it's pinned to");
    const release = await importedRelease(
      "feat(core): rolled out past its pin"
    );
    await db
      .update(clients)
      .set({ pinnedReleaseId: pin })
      .where(eq(clients.id, internal.clientId));
    const counts = deploymentCounts(internal.account);
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const workers = await workersOf(internal.clientId);
    expect({
      targets: await targetsOf(rolloutId),
      deployments: deploymentCounts(internal.account),
      releases: workers.map(({ releaseId }) => releaseId),
    }).toStrictEqual({
      targets: {
        [internal.clientId]: { ring: 0, status: "skipped", error: "pinned" },
      },
      deployments: counts,
      releases: [older, older],
    });
  });

  it("deploys a client on the release already while its secrets rotation waits for a deploy", async () => {
    const release = await importedRelease("feat(core): rotated on it");
    const internal = await activeClient(0, release);
    const [before] = await workersOf(internal.clientId);
    const skip = deploymentCounts(internal.account);
    await rotateClientSecrets(db, staff, internal.clientId, new Date());
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const [client] = await db
      .select({ rotationLiveAt: clients.rotationLiveAt })
      .from(clients)
      .where(eq(clients.id, internal.clientId));
    const workers = await workersOf(internal.clientId);
    expect({
      targets: await targetsOf(rolloutId),
      // All at once: versions with different secrets never share traffic.
      connect: deploymentsOf(
        internal.account,
        before?.scriptName ?? "",
        skip[before?.scriptName ?? ""] ?? 0,
        [workers[0]?.versionId ?? ""]
      ),
      newVersion: workers[0]?.versionId !== before?.versionId,
      rotationLive: client?.rotationLiveAt instanceof Date,
    }).toStrictEqual({
      targets: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
      },
      connect: [[100]],
      newVersion: true,
      rotationLive: true,
    });
  });

  it("deploys a client on the release already once staff changed a flag, so its core gets the flag, and skips it again after", async () => {
    const release = await importedRelease("feat(core): flagged on it");
    const internal = await activeClient(0, release);
    const [, before] = await workersOf(internal.clientId);
    await setFeature(env, staff, {
      clientId: internal.clientId,
      feature: "apps",
      on: true,
    });
    await using run = await followRollouts();

    const deployed = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const [, core] = await workersOf(internal.clientId);
    const again = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const features = z
      .array(z.object({ name: z.string(), json: z.unknown().optional() }))
      .parse(
        internal.account.scripts
          .get(core?.scriptName ?? "")
          ?.versions.find(({ id }) => id === core?.versionId)?.metadata
          .bindings ?? []
      )
      .find(({ name }) => name === "FEATURES");
    expect({
      deployed: await targetsOf(deployed),
      newVersion: core?.versionId !== before?.versionId,
      features: features?.json,
      again: await targetsOf(again),
    }).toStrictEqual({
      deployed: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
      },
      newVersion: true,
      features: { apps: true },
      again: {
        [internal.clientId]: {
          ring: 0,
          status: "skipped",
          error: "on_release",
        },
      },
    });
  });

  it("skips a client that runs the release already, deploying none of its Workers", async () => {
    const release = await importedRelease("feat(core): on it already");
    const internal = await activeClient(0, release);
    const counts = deploymentCounts(internal.account);
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    expect(deploymentCounts(internal.account)).toStrictEqual(counts);
    await expect(targetsOf(rolloutId)).resolves.toStrictEqual({
      [internal.clientId]: { ring: 0, status: "skipped", error: "on_release" },
    });
    await expect(rolloutRow(rolloutId)).resolves.toMatchObject({
      status: "done",
    });
  });

  it("never deploys to a client while another runner has it, and takes it once that run has ended", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const release = await importedRelease("feat(core): wait your turn");
    const counts = deploymentCounts(internal.account);
    // A provisioning run still going (waiting for Workers Paid), named as
    // the client's runner: as its own provisioning run would be.
    const provisioning = await introspectWorkflow(env.PROVISION_CLIENT);
    const held = `held-${crypto.randomUUID().slice(0, 8)}`;
    await startProvisioning(env, staff, {
      clientId: held,
      name: "Held",
      releaseId: release,
      ring: 1,
      signIn: {
        domains: ["acme.test"],
        admins: ["ada@acme.test"],
        googleHostedDomain: "acme.test",
      },
    });
    const [heldRun] = await provisioning.get();
    await heldRun?.waitForStepResult({ name: "client" });
    const [heldClaim] = await db
      .select({ runId: clientRuns.runId })
      .from(clientRuns)
      .where(eq(clientRuns.clientId, held));
    const runId = heldClaim?.runId ?? "";
    await db.insert(clientRuns).values({
      clientId: internal.clientId,
      runId,
      kind: "provision",
      claimedAt: new Date(),
    });

    {
      await using run = await followRollouts();
      const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await run.waitForStatus("errored");

      expect({
        deployments: deploymentCounts(internal.account),
        targets: await targetsOf(rolloutId),
        rollout: await rolloutRow(rolloutId),
        runner: await runnerOf(internal.clientId),
      }).toStrictEqual({
        deployments: counts,
        targets: {
          [internal.clientId]: {
            ring: 0,
            status: "failed",
            error: "client_busy",
          },
        },
        rollout: { status: "failed", ring: 0 },
        runner: { runId, kind: "provision" },
      });
    }

    const heldInstance = await env.PROVISION_CLIENT.get(runId);
    await heldInstance.terminate();
    await heldRun?.waitForStatus("terminated");
    {
      await using run = await followRollouts();
      const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await run.waitForStatus("complete");

      const workers = await workersOf(internal.clientId);
      expect({
        targets: await targetsOf(rolloutId),
        releases: workers.map(({ releaseId }) => releaseId),
        runner: await runnerOf(internal.clientId),
      }).toStrictEqual({
        targets: {
          [internal.clientId]: { ring: 0, status: "done", error: null },
        },
        releases: [release, release],
        runner: null,
      });
    }
    await provisioning.dispose();
  });

  it("refuses a rollout whose run would pass the step budget, starting nothing", async () => {
    const release = await importedRelease("feat(core): too many at once");
    // More clients than one run's steps can take, recorded only: the
    // refusal comes before anything reaches their accounts.
    const now = new Date();
    const many = Array.from({ length: 60 }, (_, index) => ({
      id: `crowd-${index}-${crypto.randomUUID().slice(0, 6)}`,
      name: "Crowd",
      accountId: crypto.randomUUID().replaceAll("-", ""),
      ring: 0,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    }));
    const [firstRow, ...rest] = many.map((row) =>
      db.insert(clients).values(row)
    );
    if (firstRow !== undefined) {
      // A row per statement: D1 takes 100 bound values at most in one.
      await db.batch([firstRow, ...rest]);
    }
    const [before] = await db
      .select({ count: sql<number>`count(*)` })
      .from(rollouts);

    const refused = await codeOf(rollOut(release, { scope: "ring", ring: 0 }));

    const [after] = await db
      .select({ count: sql<number>`count(*)` })
      .from(rollouts);
    expect({
      refused,
      created: (after?.count ?? 0) - (before?.count ?? 0),
    }).toStrictEqual({ refused: "too_large", created: 0 });
  });

  it("refuses a rollout for a ring past 0, or a client, that reaches no one past ring 0, starting nothing", async () => {
    const release = await importedRelease("feat(core): ring 0 only");
    const internal = await activeClient(0, release);
    const [before] = await db
      .select({ count: sql<number>`count(*)` })
      .from(rollouts);

    const refused = {
      emptyRing: await codeOf(rollOut(release, { scope: "ring", ring: 3 })),
      ringZeroClient: await codeOf(
        rollOut(release, { scope: "client", clientId: internal.clientId })
      ),
    };

    const [after] = await db
      .select({ count: sql<number>`count(*)` })
      .from(rollouts);
    expect({
      refused,
      created: (after?.count ?? 0) - (before?.count ?? 0),
    }).toStrictEqual({
      refused: {
        emptyRing: "ring_zero_only",
        ringZeroClient: "ring_zero_only",
      },
      created: 0,
    });
  });

  it("stops at a failure no retry fixes, the client marked failed and released, and reaches no later ring", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const acme = await activeClient(1, before);
    const release = await importedRelease("feat(core): won't make it");
    const counts = deploymentCounts(acme.account);
    // A setting core doesn't read: refused before anything is uploaded.
    await db.insert(settings).values({
      clientId: internal.clientId,
      key: "NOT_A_SETTING",
      value: "true",
      updatedBy: staff.email,
      updatedAt: new Date(),
    });
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "all" });
    await run.waitForStatus("errored");

    expect({
      targets: await targetsOf(rolloutId),
      rollout: await rolloutRow(rolloutId),
      runner: await runnerOf(internal.clientId),
      acme: deploymentCounts(acme.account),
    }).toStrictEqual({
      targets: {
        [internal.clientId]: {
          ring: 0,
          status: "failed",
          error: "unknown_setting",
        },
        [acme.clientId]: { ring: 1, status: "pending", error: null },
      },
      rollout: { status: "failed", ring: 0 },
      runner: null,
      acme: counts,
    });
  });
});

/** Each of the client's Workers' live version in `account`, by app. */
const liveVersionsOf = async (
  clientId: string,
  account: AccountState
): Promise<Record<string, string | undefined>> => {
  const workers = await workersOf(clientId);
  return Object.fromEntries(
    workers.map(({ worker, scriptName }) => [
      worker,
      liveOf(account, scriptName),
    ])
  );
};

/** Each of the client's Workers' version, by app, as the console recorded it. */
const recordedVersionsOf = async (
  clientId: string
): Promise<Record<string, string | null>> => {
  const workers = await workersOf(clientId);
  return Object.fromEntries(
    workers.map(({ worker, versionId }) => [worker, versionId])
  );
};

/**
 * Two active clients in ring 0 running `releaseId`, in the order a
 * rollout deploys them.
 */
const twoClients = async (releaseId: string) => {
  const both = await Promise.all([
    activeClient(0, releaseId),
    activeClient(0, releaseId),
  ]);
  const [first, second] = both.toSorted((a, b) =>
    a.clientId.localeCompare(b.clientId)
  );
  if (first === undefined || second === undefined) {
    throw new Error("Two clients were set up");
  }
  return { first, second };
};

/** How many versions each of the account's scripts has had uploaded. */
const versionCounts = (account: AccountState): Record<string, number> =>
  Object.fromEntries(
    [...account.scripts].map(([name, script]) => [name, script.versions.length])
  );

/** The status and error of the deploy rollout `rolloutId` started for client `clientId`. */
const targetDeployOf = async (rolloutId: string, clientId: string) => {
  const [row] = await db
    .select({ status: clientDeploys.status, error: clientDeploys.error })
    .from(rolloutTargets)
    .innerJoin(clientDeploys, eq(clientDeploys.id, rolloutTargets.deployId))
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.clientId, clientId)
      )
    );
  return row;
};

/** A call of the fake to account `account`'s D1 API at `path` below it. */
const isD1Call =
  (account: AccountState, method: string, pathEnd: string) =>
  (call: { method: string; path: string }): boolean =>
    call.method === method &&
    call.path.startsWith(`/accounts/${account.id}/d1/database`) &&
    call.path.endsWith(pathEnd);

/**
 * Where rollout `rolloutId` left two clients it deployed, the `first`
 * rolled back while it worked on the `second`.
 */
const cancelOutcome = async (
  rolloutId: string,
  first: { clientId: string },
  second: { clientId: string }
) => ({
  targets: await targetsOf(rolloutId),
  rollout: await rolloutRow(rolloutId),
  deploy: await targetDeployOf(rolloutId, second.clientId),
  runner: await runnerOf(second.clientId),
});

/**
 * `cancelOutcome` once the rollback of the `first` cancelled the rollout:
 * the `second` stopped by the cancellation rule and released.
 */
const cancelled = (
  first: { clientId: string },
  second: { clientId: string }
) => ({
  targets: {
    [first.clientId]: { ring: 0, status: "rolled_back", error: null },
    [second.clientId]: { ring: 0, status: "stopped", error: "cancelled" },
  },
  rollout: { status: "cancelled", ring: 0 },
  deploy: { status: "failed", error: "cancelled" },
  runner: null,
});

/** The Microsoft OAuth app's secret after a rotation in 1Password. */
const rotatedMicrosoft = "microsoft-secret-rotated-4b7e1c";

/** Rotates the Microsoft OAuth app's secret in Secrets Store, as deploy-ops does. */
const rotateMicrosoftSecret = async (): Promise<void> => {
  await setStoreSecret(
    env.MICROSOFT_CLIENT_SECRET,
    "MICROSOFT_CLIENT_SECRET",
    rotatedMicrosoft
  );
};

/** The value of secret `name` on the version all of `script`'s traffic goes to. */
const liveSecretOf = (
  account: AccountState,
  script: string,
  name: string
): string | undefined => {
  const live = liveOf(account, script);
  return account.scripts
    .get(script)
    ?.versions.find(({ id }) => id === live)
    ?.secrets.get(name);
};

/**
 * Each of the client's Workers' deployments after the first `skip`, by
 * app: its live version's share of each, oldest first.
 */
const liveSharesOf = async (
  clientId: string,
  account: AccountState,
  skip: Record<string, number>
): Promise<Record<string, number[][]>> => {
  const workers = await workersOf(clientId);
  return Object.fromEntries(
    workers.map(({ worker, scriptName, versionId }) => [
      worker,
      deploymentsOf(account, scriptName, skip[scriptName] ?? 0, [
        versionId ?? "",
      ]),
    ])
  );
};

describe("rolling new secrets out", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(setAsideEarlierTests);

  it("takes a rotated shared secret to every client on the release it runs, all traffic at once, ring by ring, audited", async () => {
    const older = await importedRelease("feat(core): what ring 0 runs");
    const newer = await importedRelease("feat(core): what ring 2 runs");
    const internal = await activeClient(0, older);
    const acme = await activeClient(2, newer);
    // Pinned to another release than it runs: the secrets still reach it.
    await db
      .update(clients)
      .set({ pinnedReleaseId: older })
      .where(eq(clients.id, acme.clientId));
    const [internalConnect] = await workersOf(internal.clientId);
    const [acmeConnect] = await workersOf(acme.clientId);
    const skip = {
      internal: deploymentCounts(internal.account),
      acme: deploymentCounts(acme.account),
    };
    await rotateMicrosoftSecret();
    const logged: unknown[] = [];
    const logs = (["info", "warn", "error", "log"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      })
    );
    await using run = await followRollouts();

    const rolloutId = await rollOutSecrets({ scope: "all" });
    await expect(
      run.waitForStepResult({ name: "ring 2 approved" })
    ).resolves.toBe("waiting");
    const acmeBeforeApproval = deploymentCounts(acme.account);
    await approveRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");
    for (const spy of logs) {
      spy.mockRestore();
    }

    const connectScript = internalConnect?.scriptName ?? "";
    const internalWorkers = await workersOf(internal.clientId);
    const acmeWorkers = await workersOf(acme.clientId);
    const core = acmeWorkers.find(({ worker }) => worker === "core");
    const coreVersion = acme.account.scripts
      .get(core?.scriptName ?? "")
      ?.versions.find(({ id }) => id === core?.versionId);
    // What changed, and by whom; not when.
    const change = platformChangeSchema.omit({ at: true }).parse(
      z
        .array(z.object({ name: z.string(), json: z.unknown().optional() }))
        .parse(coreVersion?.metadata.bindings ?? [])
        .find(({ name }) => name === "PLATFORM_CHANGE")?.json
    );
    const [start] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.target, rolloutId),
          eq(auditEvents.action, "rollout.start")
        )
      );
    expect({
      acmeBeforeApproval,
      releases: {
        internal: internalWorkers.map(({ releaseId }) => releaseId),
        acme: acmeWorkers.map(({ releaseId }) => releaseId),
      },
      microsoft: {
        internal: liveSecretOf(
          internal.account,
          connectScript,
          "MICROSOFT_CLIENT_SECRET"
        ),
        acme: liveSecretOf(
          acme.account,
          acmeConnect?.scriptName ?? "",
          "MICROSOFT_CLIENT_SECRET"
        ),
      },
      shares: {
        internal: await liveSharesOf(
          internal.clientId,
          internal.account,
          skip.internal
        ),
        acme: await liveSharesOf(acme.clientId, acme.account, skip.acme),
      },
      change,
      start: parsedDetail(start?.detail ?? null),
      rollout: await rolloutRow(rolloutId),
      targets: await targetsOf(rolloutId),
      actions: await rolloutActions(rolloutId),
    }).toStrictEqual({
      // Ring 2 waits for approval, untouched.
      acmeBeforeApproval: skip.acme,
      releases: { internal: [older, older], acme: [newer, newer] },
      microsoft: { internal: rotatedMicrosoft, acme: rotatedMicrosoft },
      // Every Worker straight to its new version: never split.
      shares: {
        internal: { connect: [[100]], core: [[100]] },
        acme: { connect: [[100]], core: [[100]] },
      },
      // Core records new secrets on the release it runs, not a release.
      change: { by: staff.email, what: "secrets", release: newer },
      start: { kind: "secrets", scope: "all", targets: 2 },
      rollout: { status: "done", ring: 2 },
      targets: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
        [acme.clientId]: { ring: 2, status: "done", error: null },
      },
      actions: [
        "rollout.start",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.wait",
        "rollout.approve",
        "rollout.client_start",
        "rollout.client_done",
        "rollout.done",
      ],
    });
    // The rotation reached every active client, read live: the old
    // Microsoft secret can go, and only it. Core's secrets didn't change,
    // so nothing is said of them.
    const view = await checkRevocation(env, rolloutId);
    expect(view).toStrictEqual({
      revocable: ["MICROSOFT_CLIENT_SECRET"],
      rotated: ["MICROSOFT_CLIENT_SECRET"],
      storeChanged: [],
      behind: { MICROSOFT_CLIENT_SECRET: [] },
      unproven: [],
      skipped: [],
      outOfScope: [],
    });
    // The secret's value is in no log line, audit event, deploy record or
    // Workflow step result.
    const events = await db.select().from(auditEvents);
    const deploys = await db.select().from(clientDeploys);
    const stepNames = [
      "targets",
      "ring 2 approved",
      ...[internal.clientId, acme.clientId].flatMap((clientId) => [
        `${clientId} claim`,
        `${clientId} prepare`,
        `${clientId} connect upload`,
        `${clientId} connect live`,
        `${clientId} core upload`,
        `${clientId} core live`,
        `${clientId} finish`,
        `${clientId} done`,
      ]),
    ];
    const steps = await Promise.all(
      stepNames.map(async (name) => await run.waitForStepResult({ name }))
    );
    expect(
      JSON.stringify({ logged, events, deploys, steps, view })
    ).not.toContain(rotatedMicrosoft);
  });

  it("never says the old secrets can go after a rollout that started before deploy-ops wrote a new value, nor once the store changes after it", async () => {
    const release = await importedRelease("feat(core): what they run");
    await activeClient(0, release);
    const acme = await activeClient(2, release);
    await using run = await followRollouts();

    // Started before deploy-ops wrote the new value: every client already
    // ran what the store held, and it deploys that again.
    const rolloutId = await rollOutSecrets({ scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const unchanged = await checkRevocation(env, rolloutId);
    // Deploy-ops writes it now: nobody runs it yet.
    await rotateMicrosoftSecret();
    const changed = await checkRevocation(env, rolloutId);

    // Nothing rotated, so nothing is revocable, before or after.
    expect({ unchanged, changed }).toStrictEqual({
      unchanged: {
        revocable: [],
        rotated: [],
        storeChanged: [],
        behind: {},
        unproven: [],
        skipped: [],
        outOfScope: [acme.clientId],
      },
      changed: {
        revocable: [],
        rotated: [],
        storeChanged: ["MICROSOFT_CLIENT_SECRET"],
        behind: {},
        unproven: [],
        skipped: [],
        outOfScope: [acme.clientId],
      },
    });
  });

  it("gives a rollout's go-ahead only for the value it rolled out: once the store moves on, the next rollout's check decides", async () => {
    const release = await importedRelease("feat(core): rotated twice");
    await twoClients(release);
    await rotateMicrosoftSecret();
    await using run = await followRollouts();
    const first = await rollOutSecrets({ scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    // Rotated again, and rolled out again: every client runs the newest.
    await setStoreSecret(
      env.MICROSOFT_CLIENT_SECRET,
      "MICROSOFT_CLIENT_SECRET",
      "microsoft-secret-rotated-again-9d2f"
    );
    const second = await rollOutSecrets({ scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const [firstCheck, secondCheck] = await Promise.all([
      checkRevocation(env, first),
      checkRevocation(env, second),
    ]);
    expect({
      first: firstCheck,
      second: secondCheck,
    }).toMatchObject({
      first: {
        revocable: [],
        rotated: ["MICROSOFT_CLIENT_SECRET"],
        storeChanged: ["MICROSOFT_CLIENT_SECRET"],
        behind: { MICROSOFT_CLIENT_SECRET: [] },
      },
      second: {
        revocable: ["MICROSOFT_CLIENT_SECRET"],
        storeChanged: [],
      },
    });
  });

  it("counts a client behind, read live, when a Worker was changed outside the console, split, or has no record", async () => {
    const release = await importedRelease("feat(core): what they run");
    const { first: outside, second: split } = await twoClients(release);
    const unrecorded = await activeClient(0, release);
    await rotateMicrosoftSecret();
    await using run = await followRollouts();
    const rolloutId = await rollOutSecrets({ scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const reached = await checkRevocation(env, rolloutId);
    const connectOf = async (clientId: string) => {
      const workers = await workersOf(clientId);
      return workers.find(({ worker }) => worker === "connect");
    };
    // Connect redeployed outside the console: a version with no record.
    const outsideConnect = await connectOf(outside.clientId);
    const script = outside.account.scripts.get(
      outsideConnect?.scriptName ?? ""
    );
    const last = script?.versions.at(-1);
    if (script !== undefined && last !== undefined) {
      const version = { ...last, id: crypto.randomUUID() };
      script.versions.push(version);
      script.deployments.unshift({
        id: crypto.randomUUID(),
        created_on: new Date().toISOString(),
        versions: [{ version_id: version.id, percentage: 100 }],
        annotations: {},
      });
    }
    // Connect's traffic split between its version and the one before.
    const splitConnect = await connectOf(split.clientId);
    const splitVersions =
      split.account.scripts.get(splitConnect?.scriptName ?? "")?.versions ?? [];
    await deployVersions(
      cloudflareApi({ token, retryDelayMs: 0 }),
      split.account.id,
      splitConnect?.scriptName ?? "",
      [
        { version_id: splitVersions.at(-1)?.id ?? "", percentage: 50 },
        { version_id: splitVersions.at(-2)?.id ?? "", percentage: 50 },
      ],
      { message: "split by hand" }
    );
    // The console lost its record of connect, which holds the secret.
    await db
      .delete(clientWorkers)
      .where(
        and(
          eq(clientWorkers.clientId, unrecorded.clientId),
          eq(clientWorkers.worker, "connect")
        )
      );

    const after = await checkRevocation(env, rolloutId);

    expect({ reached, after }).toMatchObject({
      reached: { revocable: ["MICROSOFT_CLIENT_SECRET"] },
      after: {
        revocable: [],
        rotated: ["MICROSOFT_CLIENT_SECRET"],
        behind: {
          MICROSOFT_CLIENT_SECRET: [
            outside.clientId,
            split.clientId,
            unrecorded.clientId,
          ].toSorted((a, b) => a.localeCompare(b)),
        },
      },
    });
  });

  it("skips a client whose Workers don't run one release, deploying nothing to it", async () => {
    const older = await importedRelease("feat(core): what connect runs");
    const newer = await importedRelease("feat(core): what core runs");
    const internal = await activeClient(0, older);
    // A deploy of the newer release stopped after core went live.
    await db
      .update(clientWorkers)
      .set({ releaseId: newer })
      .where(
        and(
          eq(clientWorkers.clientId, internal.clientId),
          eq(clientWorkers.worker, "core")
        )
      );
    const counts = deploymentCounts(internal.account);
    await rotateMicrosoftSecret();
    await using run = await followRollouts();

    const rolloutId = await rollOutSecrets({ scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    expect({
      targets: await targetsOf(rolloutId),
      deployments: deploymentCounts(internal.account),
    }).toStrictEqual({
      targets: {
        [internal.clientId]: {
          ring: 0,
          status: "skipped",
          error: "no_release",
        },
      },
      deployments: counts,
    });
  });

  it("sends each Worker all its traffic at once when the version it replaces has no secrets on record, or is one the console never made", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first: unrecorded, second: outside } = await twoClients(before);
    // Its deploys' records carry no fingerprints.
    await db
      .update(clientDeploys)
      .set({ versions: null })
      .where(eq(clientDeploys.clientId, unrecorded.clientId));
    // Each of its Workers runs a version uploaded outside the console.
    for (const script of outside.account.scripts.values()) {
      const [last] = script.versions.toReversed();
      if (last !== undefined) {
        const version = {
          ...last,
          id: crypto.randomUUID(),
          number: last.number + 1,
        };
        script.versions.push(version);
        script.deployments.unshift({
          id: crypto.randomUUID(),
          created_on: new Date().toISOString(),
          versions: [{ version_id: version.id, percentage: 100 }],
          annotations: {},
        });
      }
    }
    const skip = {
      unrecorded: deploymentCounts(unrecorded.account),
      outside: deploymentCounts(outside.account),
    };
    const release = await importedRelease("feat(core): no record to go by");
    await using run = await followRollouts();

    await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const atOnce = { connect: [[100]], core: [[100]] };
    expect({
      unrecorded: await liveSharesOf(
        unrecorded.clientId,
        unrecorded.account,
        skip.unrecorded
      ),
      outside: await liveSharesOf(
        outside.clientId,
        outside.account,
        skip.outside
      ),
    }).toStrictEqual({ unrecorded: atOnce, outside: atOnce });
  });

  it("sends a Worker all its traffic at once in a release rollout when a shared secret it has changed since, and the others by stages", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const skip = deploymentCounts(internal.account);
    // Rotated in Secrets Store, and no secrets rollout since: only connect
    // has the Microsoft app's secret.
    await rotateMicrosoftSecret();
    const release = await importedRelease("feat(core): after a rotation");
    await using run = await followRollouts();

    await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const [connect] = await workersOf(internal.clientId);
    expect({
      shares: await liveSharesOf(internal.clientId, internal.account, skip),
      microsoft: liveSecretOf(
        internal.account,
        connect?.scriptName ?? "",
        "MICROSOFT_CLIENT_SECRET"
      ),
    }).toStrictEqual({
      shares: { connect: [[100]], core: [[10], [50], [100]] },
      microsoft: rotatedMicrosoft,
    });
  });
});

describe("controlling a rollout", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(setAsideEarlierTests);

  it("rolls a client back to the versions it ran before at once, stops its rollout, and tells its core for its Activity", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    await activeClient(1, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const release = await importedRelease("feat(core): roll me back");
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });

    await rollbacks.rollBack(rolloutId, internal.clientId);
    // Its run, waiting for approval, is ended too.
    await run.waitForStatus("terminated");

    const workers = await workersOf(internal.clientId);
    const actions = await rolloutActions(rolloutId);
    expect({
      live: await liveVersionsOf(internal.clientId, internal.account),
      recorded: await recordedVersionsOf(internal.clientId),
      releases: workers.map(({ releaseId }) => releaseId),
      targets: await targetsOf(rolloutId),
      rollout: await rolloutRow(rolloutId),
      runner: await runnerOf(internal.clientId),
      actions: actions.slice(-2),
      approve: await codeOf(approveRollout(env, staff, rolloutId)),
      // Signed with the key the rolled-back core's auth secret gives.
      notices: internal.account.notices,
    }).toMatchObject({
      live: previous,
      recorded: previous,
      releases: [before, before],
      targets: { [internal.clientId]: { status: "rolled_back" } },
      rollout: { status: "cancelled" },
      runner: null,
      actions: ["rollout.rollback", "rollout.client_rolled_back"],
      approve: "not_waiting",
      notices: [
        {
          versionId: previous.core,
          change: { by: staff.email, what: "rollback", release: before },
        },
      ],
    });
  });

  it("rolls a client back even when its core doesn't take the notice, and audits that it didn't", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const release = await importedRelease("feat(core): an older core");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    // As a core from before the endpoint answers.
    internal.account.noticeStatus = 404;
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    await using rollbacks = await followRollbacks();

    try {
      await rollbacks.rollBack(rolloutId, internal.clientId);
    } finally {
      warn.mockRestore();
    }

    const unrecorded = await db
      .select({ target: auditEvents.target, detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, internal.clientId),
          eq(auditEvents.action, "rollout.activity_unrecorded")
        )
      );
    expect({
      live: await liveVersionsOf(internal.clientId, internal.account),
      targets: await targetsOf(rolloutId),
      unrecorded: unrecorded.map(({ target, detail }) => ({
        target,
        detail: parsedDetail(detail),
      })),
    }).toStrictEqual({
      live: previous,
      targets: {
        [internal.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
      unrecorded: [
        {
          target: previous.core,
          detail: { what: "rollback", error: "core_404" },
        },
      ],
    });
  });

  it("rolls a client back even when the keys to tell its core are missing, auditing that it didn't", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const release = await importedRelease("feat(core): no keys to tell");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    await emptyStoreSecret(env.CLIENT_KEY, "CLIENT_KEY");
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    await using rollbacks = await followRollbacks();

    let runId = "";
    try {
      runId = await rollbacks.rollBack(rolloutId, internal.clientId);
    } finally {
      warn.mockRestore();
    }

    const instance = await env.ROLLBACK_CLIENT.get(runId);
    const { status } = await instance.status();
    const unrecorded = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, internal.clientId),
          eq(auditEvents.action, "rollout.activity_unrecorded")
        )
      );
    expect({
      status,
      live: await liveVersionsOf(internal.clientId, internal.account),
      targets: await targetsOf(rolloutId),
      notices: internal.account.notices,
      unrecorded: unrecorded.map(({ detail }) => parsedDetail(detail)),
    }).toStrictEqual({
      status: "complete",
      live: previous,
      targets: {
        [internal.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
      notices: [],
      unrecorded: [{ what: "rollback", error: "store_secret_missing" }],
    });
  });

  it("tells a client's core the version the rollback confirmed live right before it released the client, not the one it planned", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const release = await importedRelease("feat(core): changed at the end");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const [, core] = await workersOf(internal.clientId);
    const script = core?.scriptName ?? "";
    const released = core?.versionId ?? "";
    // Core's release version goes live again as the rollback reads what
    // core runs for the last time before it releases the client: after
    // its two checks (when asked for, and as its run's plan), its restore,
    // and its restore again.
    const api = cloudflareApi({ token, retryDelayMs: 0 });
    const lastRead = 5;
    let reads = 0;
    cloudflare.beforeAnswering(
      (call) => {
        if (
          call.method !== "GET" ||
          !call.path.endsWith(`/workers/scripts/${script}/deployments`)
        ) {
          return false;
        }
        reads += 1;
        return reads === lastRead;
      },
      async () => {
        await deployVersion(api, internal.account.id, script, released, {
          message: "late",
          force: true,
        });
      }
    );
    await using rollbacks = await followRollbacks();

    await rollbacks.rollBack(rolloutId, internal.clientId);

    const drift = await driftOf(api, db, internal.clientId);
    expect({
      notices: internal.account.notices,
      core: drift?.workers.find(({ worker }) => worker === "core")?.state,
    }).toMatchObject({
      notices: [
        {
          versionId: released,
          change: { what: "rollback", release: "unknown" },
        },
      ],
      // Recorded as rolled back, and shown as the drift it is.
      core: "drifted",
    });
  });

  it("records a rollback whose last read of what core runs keeps failing, telling core nothing and auditing it as unconfirmed", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const release = await importedRelease("feat(core): unread at the end");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const [, core] = await workersOf(internal.clientId);
    const script = core?.scriptName ?? "";
    // Every read of what core runs from the rollback's last one on, after
    // its two checks, its restore and its restore again, is refused.
    const seen = new Set<unknown>();
    const lastRead = 5;
    const isLateCoreRead = (call: {
      method: string;
      path: string;
    }): boolean => {
      if (
        call.method !== "GET" ||
        !call.path.startsWith(`/accounts/${internal.account.id}/`) ||
        !call.path.endsWith(`/workers/scripts/${script}/deployments`)
      ) {
        return false;
      }
      seen.add(call);
      return seen.size >= lastRead;
    };
    for (let refusal = 0; refusal < lastRead; refusal += 1) {
      cloudflare.failNext(isLateCoreRead, 400);
    }
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    await using rollbacks = await followRollbacks();

    let runId = "";
    try {
      runId = await rollbacks.rollBack(rolloutId, internal.clientId);
    } finally {
      warn.mockRestore();
    }

    const instance = await env.ROLLBACK_CLIENT.get(runId);
    const { status } = await instance.status();
    const audited = await db
      .select({ action: auditEvents.action, detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, internal.clientId),
          inArray(auditEvents.action, [
            "rollout.client_rolled_back",
            "rollout.activity_unrecorded",
          ])
        )
      )
      .orderBy(asc(auditEvents.at), sql`rowid`);
    expect({
      status,
      live: await liveVersionsOf(internal.clientId, internal.account),
      targets: await targetsOf(rolloutId),
      notices: internal.account.notices,
      audited: audited.map(({ action, detail }) => ({
        action,
        detail: parsedDetail(detail),
      })),
    }).toMatchObject({
      status: "complete",
      live: previous,
      targets: {
        [internal.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
      notices: [],
      audited: [
        {
          action: "rollout.client_rolled_back",
          detail: {
            confirmed_connect: previous.connect,
            confirmed_core: "unknown",
          },
        },
        {
          action: "rollout.activity_unrecorded",
          detail: { what: "rollback", error: "core_unconfirmed" },
        },
      ],
    });
  });

  it("tells core the version its record stored when the record step runs again after committing, though core changed since", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    await activeClient(1, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const release = await importedRelease("feat(core): recorded, then changed");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });
    const [, core] = await workersOf(internal.clientId);
    const script = core?.scriptName ?? "";
    const released = core?.versionId ?? "";
    const api = cloudflareApi({ token, retryDelayMs: 0 });
    // The claim's batch goes through; the record's, the next, commits,
    // then core's release version goes live again (another deploy, after
    // the client was released), and the record's answer is lost, so the
    // step runs again.
    let batches = 0;
    const batch = env.DB.batch.bind(env.DB);
    const losing = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        batches += 1;
        const results = await batch(statements);
        if (batches === 2) {
          await deployVersion(api, internal.account.id, script, released, {
            message: "after the release",
            force: true,
          });
          throw new Error("The answer was lost");
        }
        return results;
      });
    await using rollbacks = await followRollbacks();
    try {
      await rollbacks.rollBack(rolloutId, internal.clientId);
    } finally {
      losing.mockRestore();
    }

    expect({
      notices: internal.account.notices,
      core: liveOf(internal.account, script),
    }).toMatchObject({
      notices: [
        {
          versionId: previous.core,
          change: { what: "rollback", release: before },
        },
      ],
      core: released,
    });
  });

  it("puts right a rollout's traffic change that lands after its rollback took the client", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const [connect] = await workersOf(internal.clientId);
    const script = connect?.scriptName ?? "";
    const skip = deploymentCounts(internal.account)[script] ?? 0;
    const release = await importedRelease("feat(core): racing a rollback");
    // The rollout's 50% is on its way when the rollback takes the client
    // (its 10% is live, so there's something to roll back), and lands
    // after the rollback restored the client's versions.
    await using rollbacks = await followRollbacks();
    landLateDuringRollback(rollbacks, internal, script, 50);
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("errored");
    await rollbacks.waitForAll();

    const [connectNow] = await workersOf(internal.clientId);
    expect({
      live: await liveVersionsOf(internal.clientId, internal.account),
      connect: deploymentsOf(internal.account, script, skip, [
        previous.connect ?? "",
      ]),
      recorded: connectNow?.versionId,
      targets: await targetsOf(rolloutId),
      rollout: await rolloutRow(rolloutId),
      runner: await runnerOf(internal.clientId),
    }).toStrictEqual({
      live: previous,
      // The rollout's 10%, the rollback's restore, the rollout's late 50%,
      // then the rollback putting it right: nothing from the rollout after.
      connect: [[90], [100], [50], [100]],
      recorded: previous.connect,
      targets: {
        [internal.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
      rollout: { status: "cancelled", ring: 0 },
      runner: null,
    });
  });

  it("rolls back every client of a ring the rollout reached", async () => {
    const before = await importedRelease("feat(core): the release before");
    const first = await activeClient(0, before);
    const second = await activeClient(0, before);
    const release = await importedRelease("feat(core): the whole ring back");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const reached = await targetsOf(rolloutId);
    const previous = {
      first: reached[first.clientId],
      second: reached[second.clientId],
    };

    await using rollbacks = await followRollbacks();

    const results = await rollbackRing(env, staff, rolloutId, 0);
    await rollbacks.waitForAll();

    const firstWorkers = await workersOf(first.clientId);
    const secondWorkers = await workersOf(second.clientId);
    expect({
      previous,
      results: results
        .map(({ clientId, refused }) => ({ clientId, refused }))
        .toSorted((a, b) => a.clientId.localeCompare(b.clientId)),
      releases: [...firstWorkers, ...secondWorkers].map(
        ({ releaseId }) => releaseId
      ),
      targets: await targetsOf(rolloutId),
    }).toStrictEqual({
      previous: {
        first: { ring: 0, status: "done", error: null },
        second: { ring: 0, status: "done", error: null },
      },
      results: [first.clientId, second.clientId]
        .toSorted((a, b) => a.localeCompare(b))
        .map((clientId) => ({ clientId, refused: null })),
      releases: [before, before, before, before],
      targets: {
        [first.clientId]: { ring: 0, status: "rolled_back", error: null },
        [second.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
    });
  });

  it("reports a rollback whose run failed, alone or as one of its ring's", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const release = await importedRelease("feat(core): failing rollbacks");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const [, core] = await workersOf(second.clientId);
    // Every attempt to put the second client's core back is refused, so
    // its rollback's run fails.
    const isSecondRestore = (call: { method: string; path: string }) =>
      call.method === "POST" &&
      call.path.startsWith(`/accounts/${second.account.id}/`) &&
      call.path.endsWith(
        `/workers/scripts/${core?.scriptName ?? ""}/deployments`
      );
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    await using rollbacks = await followRollbacks();

    let alone: unknown = "not asked";
    let ring: { clientId: string; refused: string | null }[] = [];
    try {
      cloudflare.failNext(isSecondRestore, 400);
      alone = await codeOf(
        rollbackClientAndWait(env, staff, rolloutId, second.clientId)
      );
      cloudflare.failNext(isSecondRestore, 400);
      const results = await rollbackRingAndWait(env, staff, rolloutId, 0);
      ring = results.map(({ clientId, refused }) => ({ clientId, refused }));
      await rollbacks.waitForAll();
    } finally {
      warn.mockRestore();
    }

    expect({
      alone,
      ring: ring.toSorted((a, b) => a.clientId.localeCompare(b.clientId)),
      targets: await targetsOf(rolloutId),
    }).toStrictEqual({
      alone: "rollback_failed",
      ring: [
        { clientId: first.clientId, refused: null },
        { clientId: second.clientId, refused: "rollback_failed" },
      ],
      targets: {
        [first.clientId]: { ring: 0, status: "rolled_back", error: null },
        [second.clientId]: { ring: 0, status: "done", error: null },
      },
    });
  });

  it("refuses a rollback the client's previous versions can't take, or while another runner has it", async () => {
    const before = await importedRelease("feat(core): the release before");
    const rotated = await activeClient(0, before);
    const redeployed = await activeClient(0, before);
    const busy = await activeClient(0, before);
    const release = await importedRelease("feat(core): no way back");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    // Its secrets rotated since: its previous versions don't have the new ones.
    await rotateClientSecrets(db, staff, rotated.clientId, new Date());
    // Something newer went out to it since.
    await startDeploy(db, staff, redeployed.clientId, release);
    // A rollback of it, a moment ago, still running.
    await db.insert(clientRuns).values({
      clientId: busy.clientId,
      runId: "rollback-elsewhere",
      kind: "rollback",
      claimedAt: new Date(),
    });
    const counts = [rotated, redeployed, busy].map(({ account }) =>
      deploymentCounts(account)
    );

    const refusals = {
      rotated: await codeOf(
        rollbackClient(env, staff, rolloutId, rotated.clientId)
      ),
      redeployed: await codeOf(
        rollbackClient(env, staff, rolloutId, redeployed.clientId)
      ),
      busy: await codeOf(rollbackClient(env, staff, rolloutId, busy.clientId)),
      unreached: await codeOf(
        rollbackClient(env, staff, crypto.randomUUID(), busy.clientId)
      ),
    };

    expect({
      refusals,
      counts: [rotated, redeployed, busy].map(({ account }) =>
        deploymentCounts(account)
      ),
      runner: await runnerOf(busy.clientId),
    }).toStrictEqual({
      refusals: {
        rotated: "rotated_since",
        redeployed: "superseded",
        busy: "client_busy",
        unreached: "nothing_to_roll_back",
      },
      counts,
      runner: { runId: "rollback-elsewhere", kind: "rollback" },
    });
  });

  it("rolls a client back from a secrets rollout to the versions, and so the secrets, it ran before", async () => {
    const release = await importedRelease("feat(core): what it runs");
    const internal = await activeClient(0, release);
    await activeClient(1, release);
    const previous = await recordedVersionsOf(internal.clientId);
    const [connect] = await workersOf(internal.clientId);
    await rotateMicrosoftSecret();
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOutSecrets({ scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });

    await rollbacks.rollBack(rolloutId, internal.clientId);

    expect({
      live: await liveVersionsOf(internal.clientId, internal.account),
      microsoft: liveSecretOf(
        internal.account,
        connect?.scriptName ?? "",
        "MICROSOFT_CLIENT_SECRET"
      ),
      targets: await targetsOf(rolloutId),
      rollout: await rolloutRow(rolloutId),
    }).toMatchObject({
      live: previous,
      microsoft: "microsoft-secret",
      targets: { [internal.clientId]: { status: "rolled_back" } },
      rollout: { status: "cancelled" },
    });
  });

  it("refuses a rollback further back than the release right before the rollout's", async () => {
    const older = await importedRelease("feat(core): two releases back");
    const internal = await activeClient(0, older);
    await importedRelease("feat(core): the one it skipped");
    const release = await importedRelease("feat(core): too far ahead");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const counts = deploymentCounts(internal.account);

    const refused = await codeOf(
      rollbackClient(env, staff, rolloutId, internal.clientId)
    );

    expect({
      refused,
      counts: deploymentCounts(internal.account),
      runner: await runnerOf(internal.clientId),
    }).toStrictEqual({ refused: "too_far_back", counts, runner: null });
  });

  it("refuses a rollback while the rollout is still preparing the client, with nothing of it live", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const release = await importedRelease("feat(core): still preparing");
    // Asked for while the rollout runs the client's migrations.
    let refused: unknown = "not asked";
    cloudflare.beforeAnswering(
      (call) =>
        call.path.startsWith(`/accounts/${internal.account.id}/d1/database/`) &&
        call.path.endsWith("/query"),
      async () => {
        const [open] = await db
          .select({ id: rollouts.id })
          .from(rollouts)
          .where(eq(rollouts.status, "running"));
        refused = await codeOf(
          rollbackClient(env, staff, open?.id ?? "", internal.clientId)
        );
      }
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    expect({
      refused,
      targets: await targetsOf(rolloutId),
    }).toStrictEqual({
      refused: "client_busy",
      targets: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
      },
    });
  });

  it("changes nothing once a rollback lost its claim on the client", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const release = await importedRelease("feat(core): kept");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const workers = await workersOf(internal.clientId);
    const script = (app: string): string =>
      workers.find(({ worker }) => worker === app)?.scriptName ?? "";
    // Another runner takes the client while the rollback restores core,
    // its first Worker.
    cloudflare.beforeAnswering(
      isDeploymentAt(script("core"), 100),
      async () => {
        await db
          .update(clientRuns)
          .set({ runId: "someone-else", kind: "rollout" })
          .where(eq(clientRuns.clientId, internal.clientId));
      }
    );
    await using rollbacks = await followRollbacks();

    await rollbacks.rollBack(rolloutId, internal.clientId);

    const recorded = await workersOf(internal.clientId);
    expect({
      connect: liveOf(internal.account, script("connect")),
      recorded: recorded.map(({ releaseId, versionId }) => [
        releaseId,
        versionId,
      ]),
      targets: await targetsOf(rolloutId),
      rollout: await rolloutRow(rolloutId),
      runner: await runnerOf(internal.clientId),
    }).toStrictEqual({
      connect: workers.find(({ worker }) => worker === "connect")?.versionId,
      recorded: workers.map(({ releaseId, versionId }) => [
        releaseId,
        versionId,
      ]),
      targets: {
        [internal.clientId]: { ring: 0, status: "done", error: null },
      },
      rollout: { status: "done", ring: 0 },
      runner: { runId: "someone-else", kind: "rollout" },
    });
  });

  it("keeps a rollback's record and versions when the rollout's go-live lands after the rollback took the client", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const [connect] = await workersOf(internal.clientId);
    const script = connect?.scriptName ?? "";
    const skip = deploymentCounts(internal.account)[script] ?? 0;
    const release = await importedRelease("feat(core): going live late");
    await using rollbacks = await followRollbacks();
    landLateDuringRollback(rollbacks, internal, script, 100);
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("errored");
    await rollbacks.waitForAll();

    const workers = await workersOf(internal.clientId);
    const after = deploymentsOf(internal.account, script, skip, [
      previous.connect ?? "",
    ]);
    expect({
      live: await liveVersionsOf(internal.clientId, internal.account),
      recorded: await recordedVersionsOf(internal.clientId),
      releases: workers.map(({ releaseId }) => releaseId),
      targets: await targetsOf(rolloutId),
      // The rollback's restore, the rollout's late go-live, the rollback
      // putting it right: nothing after, from the rollout that lost it.
      lastThree: after.slice(-3),
    }).toStrictEqual({
      live: previous,
      recorded: previous,
      releases: [before, before],
      targets: {
        [internal.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
      lastThree: [[100], [0], [100]],
    });
  });

  it("rolls back a client whose upload went live but was never recorded, judging by what it runs", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const [, core] = await workersOf(internal.clientId);
    const script = core?.scriptName ?? "";
    const release = await publishRelease({
      notes: "feat(core): a Durable Object migration",
      durableObjectMigrations: ["v1", "v2"],
    });
    await importReleases(env.RELEASES, db);
    // Core's upload runs its migration and goes live at once; from then
    // on the console's database takes no write, so nothing records it and
    // the rollout stops.
    let down = false;
    cloudflare.beforeAnswering(
      (call) =>
        call.method === "PUT" &&
        call.path.endsWith(`/workers/scripts/${script}`),
      async () => {
        down = true;
        await Promise.resolve();
      }
    );
    const batch = env.DB.batch.bind(env.DB);
    const failing = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        if (down) {
          throw new Error("D1 took no write");
        }
        return await batch(statements);
      });
    const logged = vi.spyOn(console, "error").mockReturnValue();
    let rolloutId = "";
    try {
      await using run = await followRollouts();
      rolloutId = await rollOut(release.id, { scope: "ring", ring: 0 });
      await run.waitForStatus("errored");
    } finally {
      failing.mockRestore();
      logged.mockRestore();
    }
    const liveBefore = liveOf(internal.account, script);
    const [deploy] = await db
      .select({ id: rolloutTargets.deployId })
      .from(rolloutTargets)
      .where(eq(rolloutTargets.rolloutId, rolloutId));
    const coreRecords = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, internal.clientId),
          sql`json_extract(${auditEvents.detail}, '$.deploy') = ${deploy?.id ?? ""}`,
          sql`json_extract(${auditEvents.detail}, '$.worker') = 'core'`
        )
      );
    await using rollbacks = await followRollbacks();

    await rollbacks.rollBack(rolloutId, internal.clientId);

    expect({
      movedUnrecorded: liveBefore !== previous.core && coreRecords.length === 0,
      live: liveOf(internal.account, script),
      targets: await targetsOf(rolloutId),
    }).toStrictEqual({
      movedUnrecorded: true,
      live: previous.core,
      targets: {
        [internal.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
    });
  });

  it("leaves a rollout that just claimed its next client to stop by itself, releasing it, when a rollback lands in between", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const release = await importedRelease("feat(core): two in a ring");
    const secondCounts = deploymentCounts(second.account);
    await using rollbacks = await followRollbacks();
    // The rollout has claimed the second client, and reads what it runs
    // before it marks it deploying: the first client's rollback lands then.
    cloudflare.beforeAnswering(
      (call) =>
        call.method === "GET" &&
        call.path.startsWith(`/accounts/${second.account.id}/`) &&
        call.path.endsWith("/deployments"),
      async () => {
        await rollbacks.rollBack(await openRollout(), first.clientId);
      }
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const targets = await targetsOf(rolloutId);
    expect({
      targets,
      rollout: await rolloutRow(rolloutId),
      secondRunner: await runnerOf(second.clientId),
      secondDeployments: deploymentCounts(second.account),
    }).toStrictEqual({
      targets: {
        [first.clientId]: { ring: 0, status: "rolled_back", error: null },
        [second.clientId]: { ring: 0, status: "skipped", error: "cancelled" },
      },
      rollout: { status: "cancelled", ring: 0 },
      secondRunner: null,
      secondDeployments: secondCounts,
    });
  });

  it("stops a client whose rollout is cancelled while it's prepared, before any upload", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const release = await importedRelease("feat(core): cancelled mid prepare");
    const versions = versionCounts(second.account);
    const deployments = deploymentCounts(second.account);
    await using rollbacks = await followRollbacks();
    // The first client's rollback lands while the rollout migrates the
    // second's databases, the last of its prepare step: the next step,
    // the first upload, is the first to find the rollout cancelled.
    cloudflare.beforeAnswering(
      isD1Call(second.account, "POST", "/query"),
      async () => {
        await rollbacks.rollBack(await openRollout(), first.clientId);
      }
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    expect({
      targets: await targetsOf(rolloutId),
      rollout: await rolloutRow(rolloutId),
      deploy: await targetDeployOf(rolloutId, second.clientId),
      runner: await runnerOf(second.clientId),
      versions: versionCounts(second.account),
      deployments: deploymentCounts(second.account),
    }).toStrictEqual({
      targets: {
        [first.clientId]: { ring: 0, status: "rolled_back", error: null },
        [second.clientId]: { ring: 0, status: "stopped", error: "cancelled" },
      },
      rollout: { status: "cancelled", ring: 0 },
      deploy: { status: "failed", error: "cancelled" },
      runner: null,
      versions,
      deployments,
    });
  });

  it("stops a client whose rollout is cancelled between traffic stages, changing its traffic no further, and rolls it back", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const previous = await recordedVersionsOf(second.clientId);
    const [connect, core] = await workersOf(second.clientId);
    const script = connect?.scriptName ?? "";
    const counts = deploymentCounts(second.account);
    const release = await importedRelease("feat(core): cancelled at 10%");
    await using rollbacks = await followRollbacks();
    // The first client's rollback lands as the second's connect goes to
    // 10%: its 50% step is the first to find the rollout cancelled.
    cloudflare.beforeAnswering(
      (call) =>
        call.path.startsWith(`/accounts/${second.account.id}/`) &&
        isDeploymentAt(script, 10)(call),
      async () => {
        await rollbacks.rollBack(await openRollout(), first.clientId);
      }
    );
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");
    const stopped = {
      targets: await targetsOf(rolloutId),
      runner: await runnerOf(second.clientId),
      connect: deploymentsOf(second.account, script, counts[script] ?? 0, [
        previous.connect ?? "",
      ]),
      core: deploymentCounts(second.account)[core?.scriptName ?? ""],
    };

    await rollbacks.rollBack(rolloutId, second.clientId);

    expect({
      stopped,
      live: await liveVersionsOf(second.clientId, second.account),
      targets: await targetsOf(rolloutId),
    }).toStrictEqual({
      stopped: {
        targets: {
          [first.clientId]: { ring: 0, status: "rolled_back", error: null },
          [second.clientId]: { ring: 0, status: "stopped", error: "cancelled" },
        },
        runner: null,
        // Its 10%, and nothing after.
        connect: [[90]],
        core: counts[core?.scriptName ?? ""],
      },
      live: previous,
      targets: {
        [first.clientId]: { ring: 0, status: "rolled_back", error: null },
        [second.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
    });
  });

  it("stops, never skips, a client whose prepare step runs again after its rollout was cancelled, rolling it back once its traffic moved", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const previous = await recordedVersionsOf(second.clientId);
    const release = await importedRelease("feat(core): prepared again");
    await using rollbacks = await followRollbacks();
    // Part way through the second client's prepare step, the first
    // client's rollback lands, then a migration fails, so the step runs
    // again, with the rollout cancelled.
    cloudflare.beforeAnswering(
      isD1Call(second.account, "GET", "/d1/database"),
      async () => {
        await rollbacks.rollBack(await openRollout(), first.clientId);
        cloudflare.failNext(isD1Call(second.account, "POST", "/query"), 400);
      }
    );
    const logged = vi.spyOn(console, "error").mockReturnValue();
    let rolloutId = "";
    try {
      await using run = await followRollouts();
      rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await run.waitForStatus("complete");
    } finally {
      logged.mockRestore();
    }
    const stopped = {
      targets: await targetsOf(rolloutId),
      runner: await runnerOf(second.clientId),
      refused: await codeOf(
        rollbackClient(env, staff, rolloutId, second.clientId)
      ),
    };
    // Its traffic moves off what it ran before: the rollback now has
    // something to undo.
    const [connect] = await workersOf(second.clientId);
    const scriptState = second.account.scripts.get(connect?.scriptName ?? "");
    const last = scriptState?.versions.at(-1);
    if (scriptState === undefined || last === undefined) {
      throw new Error("The client's connect has a version");
    }
    const moved = { ...last, id: crypto.randomUUID(), number: last.number + 1 };
    scriptState.versions.push(moved);
    scriptState.deployments.unshift({
      id: crypto.randomUUID(),
      created_on: new Date().toISOString(),
      versions: [{ version_id: moved.id, percentage: 100 }],
      annotations: {},
    });

    await rollbacks.rollBack(rolloutId, second.clientId);

    expect({
      stopped,
      live: await liveVersionsOf(second.clientId, second.account),
      targets: await targetsOf(rolloutId),
    }).toStrictEqual({
      stopped: {
        targets: {
          [first.clientId]: { ring: 0, status: "rolled_back", error: null },
          [second.clientId]: { ring: 0, status: "stopped", error: "cancelled" },
        },
        runner: null,
        refused: "nothing_to_roll_back",
      },
      live: previous,
      targets: {
        [first.clientId]: { ring: 0, status: "rolled_back", error: null },
        [second.clientId]: { ring: 0, status: "rolled_back", error: null },
      },
    });
  });

  it("lets a new rollout take a client whose claim is held by a rollout run that ended", async () => {
    const before = await importedRelease("feat(core): the release before");
    await activeClient(0, before);
    const acme = await activeClient(1, before);
    const release = await importedRelease("feat(core): after an ended run");
    await using run = await followRollouts();
    const stale = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });
    const ended = await env.ROLLOUT.get(stale);
    await ended.terminate();
    await run.waitForStatus("terminated");
    // The ended run's claim on acme, as it would be had it ended holding it.
    await db.insert(clientRuns).values({
      clientId: acme.clientId,
      runId: stale,
      kind: "rollout",
      claimedAt: new Date(),
    });

    const rolloutId = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });
    await approveRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    const workers = await workersOf(acme.clientId);
    expect({
      targets: await targetsOf(rolloutId),
      releases: workers.map(({ releaseId }) => releaseId),
      runner: await runnerOf(acme.clientId),
    }).toMatchObject({
      targets: { [acme.clientId]: { ring: 1, status: "done", error: null } },
      releases: [release, release],
      runner: null,
    });
  });

  it("ends as a rollback when its record step runs again after it committed, and still ends the waiting rollout's run", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    await activeClient(1, before);
    const previous = await recordedVersionsOf(internal.clientId);
    const release = await importedRelease("feat(core): recorded twice");
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });
    // The claim's batch goes through; the record's, the next, commits and
    // its answer is lost, so the step runs again.
    let batches = 0;
    const batch = env.DB.batch.bind(env.DB);
    const losing = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        batches += 1;
        const results = await batch(statements);
        if (batches === 2) {
          throw new Error("The answer was lost");
        }
        return results;
      });
    await using rollbacks = await followRollbacks();
    let runId = "";
    try {
      runId = await rollbacks.rollBack(rolloutId, internal.clientId);
    } finally {
      losing.mockRestore();
    }
    await run.waitForStatus("terminated");

    const instance = await env.ROLLBACK_CLIENT.get(runId);
    const { status } = await instance.status();
    const actions = await rolloutActions(rolloutId);
    const targets = await targetsOf(rolloutId);
    expect({
      status,
      live: await liveVersionsOf(internal.clientId, internal.account),
      targets: targets[internal.clientId]?.status,
      recorded: actions.filter(
        (action) => action === "rollout.client_rolled_back"
      ).length,
      runner: await runnerOf(internal.clientId),
    }).toStrictEqual({
      status: "complete",
      live: previous,
      targets: "rolled_back",
      recorded: 1,
      runner: null,
    });
  });

  it("refuses to roll back a client whose rollout stopped before it changed any traffic", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const release = await importedRelease("feat(core): never went live");
    // A setting core doesn't read: the rollout stops before any upload.
    await db.insert(settings).values({
      clientId: internal.clientId,
      key: "NOT_A_SETTING",
      value: "true",
      updatedBy: staff.email,
      updatedAt: new Date(),
    });
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("errored");
    const counts = deploymentCounts(internal.account);

    const refused = await codeOf(
      rollbackClient(env, staff, rolloutId, internal.clientId)
    );

    const targets = await targetsOf(rolloutId);
    expect({
      target: targets[internal.clientId]?.status,
      refused,
      deployments: deploymentCounts(internal.account),
      runner: await runnerOf(internal.clientId),
    }).toStrictEqual({
      target: "failed",
      refused: "nothing_to_roll_back",
      deployments: counts,
      runner: null,
    });
  });

  it("holds a client's split traffic while its rollout is paused part way, and goes on once resumed", async () => {
    const before = await importedRelease("feat(core): the release before");
    const internal = await activeClient(0, before);
    const [connect] = await workersOf(internal.clientId);
    const script = connect?.scriptName ?? "";
    const release = await importedRelease("feat(core): paused half way");
    cloudflare.beforeAnswering(isDeploymentAt(script, 10), async () => {
      const [open] = await db
        .select({ id: rollouts.id })
        .from(rollouts)
        .where(eq(rollouts.status, "running"));
      await pauseRollout(env, staff, open?.id ?? "");
    });
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("paused");
    const whilePaused = {
      connect: liveOf(internal.account, script),
      split: internal.account.scripts
        .get(script)
        ?.deployments[0]?.versions.map(({ percentage }) => percentage),
      runner: await runnerOf(internal.clientId),
    };
    await resumeRollout(env, staff, rolloutId);
    await run.waitForStatus("complete");

    const workers = await workersOf(internal.clientId);
    expect({
      whilePaused,
      releases: workers.map(({ releaseId }) => releaseId),
    }).toStrictEqual({
      whilePaused: {
        connect: undefined,
        split: [10, 90],
        runner: { runId: rolloutId, kind: "rollout" },
      },
      releases: [release, release],
    });
  });

  it("stops a paused rollout's client once a rollback of another cancels it, releasing the client", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const [connect] = await workersOf(second.clientId);
    const script = connect?.scriptName ?? "";
    const release = await importedRelease("feat(core): paused, then cancelled");
    // Staff pause the rollout as the second client's connect goes to 10%.
    cloudflare.beforeAnswering(
      (call) =>
        call.path.startsWith(`/accounts/${second.account.id}/`) &&
        isDeploymentAt(script, 10)(call),
      async () => {
        await pauseRollout(env, staff, await openRollout());
      }
    );
    await using run = await followRollouts();
    await using rollbacks = await followRollbacks();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("paused");

    // The first client's rollback cancels the paused rollout.
    await rollbacks.rollBack(rolloutId, first.clientId);
    await run.waitForStatus("complete");

    await expect(
      cancelOutcome(rolloutId, first, second)
    ).resolves.toStrictEqual(cancelled(first, second));
  });

  it("stops a rollout's client when a rollback cancels it while its pause is still landing", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const [connect] = await workersOf(second.clientId);
    const script = connect?.scriptName ?? "";
    const release = await importedRelease("feat(core): pausing, cancelled");
    await using rollbacks = await followRollbacks();
    // Staff pause the rollout as the second client's connect goes to 10%,
    // and the first client's rollback cancels it while that step is still
    // in flight: the run is waiting to pause, not paused.
    cloudflare.beforeAnswering(
      (call) =>
        call.path.startsWith(`/accounts/${second.account.id}/`) &&
        isDeploymentAt(script, 10)(call),
      async () => {
        const rolloutId = await openRollout();
        await pauseRollout(env, staff, rolloutId);
        await rollbacks.rollBack(rolloutId, first.clientId);
      }
    );
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    await expect(
      cancelOutcome(rolloutId, first, second)
    ).resolves.toStrictEqual(cancelled(first, second));
  });

  it("stops a rollout's client when a rollback cancels it between staff's check and their pause", async () => {
    const before = await importedRelease("feat(core): the release before");
    const { first, second } = await twoClients(before);
    const [connect] = await workersOf(second.clientId);
    const script = connect?.scriptName ?? "";
    const release = await importedRelease("feat(core): cancelled, then paused");
    await using rollbacks = await followRollbacks();
    // The pause's own call to Workflows is held until the first client's
    // rollback has cancelled the rollout and found its run not paused:
    // only the pause's read of the rollout after it can see the cancel.
    const get = env.ROLLOUT.get.bind(env.ROLLOUT);
    let pausing = false;
    const holding = vi
      .spyOn(env.ROLLOUT, "get")
      .mockImplementation(async (id): Promise<WorkflowInstance> => {
        const instance = await get(id);
        if (!pausing) {
          return instance;
        }
        const held: WorkflowInstance = {
          id: instance.id,
          status: async () => await instance.status(),
          resume: async () => {
            await instance.resume();
          },
          terminate: async () => {
            await instance.terminate();
          },
          restart: async () => {
            await instance.restart();
          },
          sendEvent: async (event) => {
            await instance.sendEvent(event);
          },
          delete: unused,
          subscribe: unused,
          pause: async () => {
            pausing = false;
            await rollbacks.rollBack(id, first.clientId);
            await instance.pause();
          },
        };
        return held;
      });
    cloudflare.beforeAnswering(
      (call) =>
        call.path.startsWith(`/accounts/${second.account.id}/`) &&
        isDeploymentAt(script, 10)(call),
      async () => {
        pausing = true;
        await pauseRollout(env, staff, await openRollout());
      }
    );
    let rolloutId = "";
    try {
      await using run = await followRollouts();
      rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
      await run.waitForStatus("complete");
    } finally {
      holding.mockRestore();
    }

    await expect(
      cancelOutcome(rolloutId, first, second)
    ).resolves.toStrictEqual(cancelled(first, second));
  });

  it("skips a client pinned to another release, and deploys one pinned to this one", async () => {
    const before = await importedRelease("feat(core): the release before");
    const held = await activeClient(0, before);
    const onIt = await activeClient(0, before);
    const release = await importedRelease("feat(core): pinned or not");
    await pinClient(env, staff, { clientId: held.clientId, releaseId: before });
    await pinClient(env, staff, {
      clientId: onIt.clientId,
      releaseId: release,
    });
    const heldCounts = deploymentCounts(held.account);
    await using run = await followRollouts();

    const rolloutId = await rollOut(release, { scope: "ring", ring: 0 });
    await run.waitForStatus("complete");

    const onItWorkers = await workersOf(onIt.clientId);
    // Pinned again to the same release: nothing changes, nothing's audited.
    await pinClient(env, staff, { clientId: held.clientId, releaseId: before });
    await pinClient(env, staff, { clientId: held.clientId, releaseId: null });
    expect({
      targets: await targetsOf(rolloutId),
      held: deploymentCounts(held.account),
      onIt: onItWorkers.map(({ releaseId }) => releaseId),
      unknown: await codeOf(
        pinClient(env, staff, { clientId: "nobody", releaseId: null })
      ),
      pins: await db
        .select({ action: auditEvents.action, target: auditEvents.target })
        .from(auditEvents)
        .where(eq(auditEvents.clientId, held.clientId))
        .orderBy(asc(auditEvents.at), sql`rowid`)
        .then((rows) =>
          rows.filter(({ action }) =>
            ["client.pin", "client.unpin"].includes(action)
          )
        ),
    }).toStrictEqual({
      targets: {
        [held.clientId]: { ring: 0, status: "skipped", error: "pinned" },
        [onIt.clientId]: { ring: 0, status: "done", error: null },
      },
      held: heldCounts,
      onIt: [release, release],
      unknown: "unknown_client",
      pins: [
        { action: "client.pin", target: before },
        { action: "client.unpin", target: null },
      ],
    });
  });

  it("pauses and resumes a rollout's run, and cancels it between rings", async () => {
    const before = await importedRelease("feat(core): the release before");
    await activeClient(0, before);
    const acme = await activeClient(1, before);
    const release = await importedRelease("feat(core): hold on");
    const counts = deploymentCounts(acme.account);
    await using run = await followRollouts();
    const rolloutId = await rollOut(release, { scope: "ring", ring: 1 });
    await run.waitForStepResult({ name: "ring 1 approved" });
    const instance = await env.ROLLOUT.get(rolloutId);

    await pauseRollout(env, staff, rolloutId);
    await run.waitForStatus("paused");
    const paused = {
      again: await codeOf(pauseRollout(env, staff, rolloutId)),
    };
    await resumeRollout(env, staff, rolloutId);
    const resumed = {
      again: await codeOf(resumeRollout(env, staff, rolloutId)),
    };
    await cancelRollout(env, staff, rolloutId);
    await run.waitForStatus("terminated");

    const { status } = await instance.status();
    const actions = await rolloutActions(rolloutId);
    expect({
      paused,
      resumed,
      status,
      rollout: await rolloutRow(rolloutId),
      acme: deploymentCounts(acme.account),
      approve: await codeOf(approveRollout(env, staff, rolloutId)),
      cancelAgain: await codeOf(cancelRollout(env, staff, rolloutId)),
      actions: actions.slice(-3),
    }).toStrictEqual({
      paused: { again: "not_running" },
      resumed: { again: "not_paused" },
      status: "terminated",
      rollout: { status: "cancelled", ring: 0 },
      acme: counts,
      approve: "not_waiting",
      cancelAgain: "not_waiting",
      actions: ["rollout.pause", "rollout.resume", "rollout.cancel"],
    });
  });
});

describe("drift", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  beforeEach(setAsideEarlierTests);

  const api = cloudflareApi({ token, retryDelayMs: 0 });

  /** Client `clientId`'s drift, and each Worker's. */
  const driftStates = async (clientId: string) => {
    const drift = await driftOf(api, db, clientId);
    return {
      state: drift?.state,
      workers: Object.fromEntries(
        (drift?.workers ?? []).map(({ worker, state }) => [worker, state])
      ),
    };
  };

  it("shows when a client is changed outside the console, split, or can't be read", async () => {
    const first = await importedRelease("feat(core): the first release");
    const internal = await activeClient(0, first);
    const [connect] = await workersOf(internal.clientId);
    const script = connect?.scriptName ?? "";
    const firstConnect = connect?.versionId ?? "";
    const second = await importedRelease("feat(core): the second release");
    await runDeploy(
      await deployContext(env),
      await startDeploy(db, staff, internal.clientId, second)
    );
    const [connectNow] = await workersOf(internal.clientId);
    const secondConnect = connectNow?.versionId ?? "";
    await pinClient(env, staff, {
      clientId: internal.clientId,
      releaseId: second,
    });

    const inSync = await driftStates(internal.clientId);
    const pinned = await driftOf(api, db, internal.clientId);
    // Pinned to a release it doesn't run.
    await pinClient(env, staff, {
      clientId: internal.clientId,
      releaseId: first,
    });
    const offPin = await driftStates(internal.clientId);
    await pinClient(env, staff, {
      clientId: internal.clientId,
      releaseId: second,
    });
    // A client the console has made nothing live on yet.
    const fresh = `client-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(clients).values({
      id: fresh,
      name: fresh,
      accountId: crypto.randomUUID().replaceAll("-", ""),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const nothingYet = await driftStates(fresh);
    // Rolled back in the dashboard, outside the console.
    await deployVersion(api, internal.account.id, script, firstConnect, {
      message: "by hand",
      force: true,
    });
    const drifted = await driftStates(internal.clientId);
    await deployVersions(
      api,
      internal.account.id,
      script,
      [
        { version_id: secondConnect, percentage: 50 },
        { version_id: firstConnect, percentage: 50 },
      ],
      { message: "by hand", force: true }
    );
    const split = await driftStates(internal.clientId);
    // The deployer lost its membership.
    internal.account.members.clear();
    const warn = vi.spyOn(console, "warn").mockReturnValue();
    let unknown: Awaited<ReturnType<typeof driftStates>> | null = null;
    try {
      unknown = await driftStates(internal.clientId);
    } finally {
      warn.mockRestore();
    }

    expect({
      inSync,
      intended: pinned?.intendedRelease,
      drifted,
      split,
      unknown,
      nobody: await driftOf(api, db, "nobody"),
      offPin,
      nothingYet,
    }).toStrictEqual({
      inSync: {
        state: "in_sync",
        workers: { connect: "in_sync", core: "in_sync" },
      },
      offPin: {
        state: "off_pin",
        workers: { connect: "in_sync", core: "in_sync" },
      },
      nothingYet: { state: "unknown", workers: {} },
      intended: second,
      drifted: {
        state: "drifted",
        workers: { connect: "drifted", core: "in_sync" },
      },
      split: {
        state: "split",
        workers: { connect: "split", core: "in_sync" },
      },
      unknown: {
        state: "unknown",
        workers: { connect: "unknown", core: "unknown" },
      },
      nobody: null,
    });
  });

  it("shows a Worker of the release the console has no record of as drifted, never in sync", async () => {
    const release = await importedRelease("feat(core): recorded in part");
    const internal = await activeClient(0, release);
    // A deploy that stopped part way: core was never recorded.
    await db
      .delete(clientWorkers)
      .where(
        and(
          eq(clientWorkers.clientId, internal.clientId),
          eq(clientWorkers.worker, "core")
        )
      );

    const drift = await driftOf(api, db, internal.clientId);

    expect({
      state: drift?.state,
      workers: (drift?.workers ?? []).map(({ worker, recorded, state }) => ({
        worker,
        recorded: recorded === null ? null : "recorded",
        state,
      })),
    }).toStrictEqual({
      state: "drifted",
      workers: [
        { worker: "connect", recorded: "recorded", state: "in_sync" },
        { worker: "core", recorded: null, state: "drifted" },
      ],
    });
  });
});
