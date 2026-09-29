import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { act, consoleDatabase } from "../src/db/act.ts";
import {
  auditEvents,
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
import { approveRollout, startRollout } from "../src/rollout/control.ts";
import type { StartRolloutInput } from "../src/rollout/control.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

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

/** Starts a rollout of `releaseId` for `scope`, as staff. */
const rollOut = async (
  releaseId: string,
  scope: StartRolloutInput["scope"]
): Promise<string> => await startRollout(env, staff, { releaseId, scope });

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

describe("rolling a release out", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // The database outlives each test, and every rollout reaches ring 0:
  // each test's rollouts reach only its own clients, and start while no
  // earlier test's rollout is open.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
    await db
      .update(rollouts)
      .set({ status: "cancelled" })
      .where(inArray(rollouts.status, ["running", "waiting"]));
  });

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
    ).resolves.toBeFalsy();

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
