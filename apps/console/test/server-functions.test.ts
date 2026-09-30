import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq, inArray, or } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applySettingsFn,
  setRingFn,
  setSignInFn,
} from "../src/clients/functions.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clients, rollouts } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { pauseRollout, startRollout } from "../src/rollout/control.ts";
import {
  approveRolloutFn,
  cancelRolloutFn,
  pauseRolloutFn,
  pinClientFn,
  resumeRolloutFn,
  rollbackClientFn,
  rollbackRingFn,
} from "../src/rollout/functions.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { callServerFn } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-functions-6a2f90";
const tenantToken = "test-tenant-admin-token-functions-1d8b47";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = consoleDatabase(env.DB);

/** Who sets each test up, acting on the console directly. */
const setup = { email: "setup@grasp.test", sub: "sub-setup" };

/** Who makes each change, through the console's entry: the staff member Access vouches for. */
const caller = "ops@grasp.test";

const signIn = {
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  googleHostedDomain: "acme.test",
};

/** A release, published and imported. */
const importedRelease = async (notes: string): Promise<string> => {
  const release = await publishRelease({ notes });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/** An active client in `ring`, recorded on a new account in the fake. */
const recordClient = async (ring: number): Promise<string> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    setup,
    [
      db.insert(clients).values({
        id: clientId,
        name: clientId,
        accountId: cloudflare.addAccount().id,
        ring,
        status: "active",
        signIn: JSON.stringify(signIn),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return clientId;
};

/** An active client in `ring` running `releaseId`, as a deploy made it. */
const activeClient = async (
  ring: number,
  releaseId: string
): Promise<string> => {
  const clientId = await recordClient(ring);
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, setup, clientId, releaseId)
  );
  return clientId;
};

/** The runs of `workflow` a test starts, their holds and retry waits going at once. */
const follow = async (workflow: Workflow) => {
  const runs = await introspectWorkflow(workflow);
  await runs.modifyAll(async (modifier) => {
    await modifier.disableSleeps();
    await modifier.disableRetryDelays();
  });
  return runs;
};

type Runs = Awaited<ReturnType<typeof follow>>;

/** The latest run `runs` follows. */
const latestOf = async (runs: Runs) => {
  const all = await runs.get();
  const last = all.at(-1);
  if (last === undefined) {
    throw new Error("No run was started");
  }
  return last;
};

/**
 * A rollout of a new release, started by `setup`, that deployed ring 0's
 * client and waits for approval of ring 1, with its run.
 */
const waitingRollout = async (rolloutRuns: Runs) => {
  const before = await importedRelease("feat(core): the release before");
  const internal = await activeClient(0, before);
  await activeClient(1, before);
  const release = await importedRelease("feat(core): through the entry");
  const rolloutId = await startRollout(env, setup, {
    kind: "release",
    releaseId: release,
    scope: { scope: "ring", ring: 1 },
  });
  const run = await latestOf(rolloutRuns);
  await run.waitForStepResult({ name: "ring 1 approved" });
  return { rolloutId, internal, run };
};

/** What a change leaves in the audit log, besides who made it. */
interface Audited {
  action: string;
  clientId: string | null;
  target: string | null;
}

/** The audit events of `audited`'s action about its client, or else its target. */
const eventsOf = async ({ action, clientId, target }: Audited) =>
  await db
    .select({
      actor: auditEvents.actor,
      clientId: auditEvents.clientId,
      target: auditEvents.target,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, action),
        or(
          eq(auditEvents.clientId, clientId ?? target ?? ""),
          eq(auditEvents.target, target ?? clientId ?? "")
        )
      )
    );

/** A change as a test makes it, once the console is set up for it. */
interface Arranged {
  /** Makes the change through the console's entry, as `caller`. */
  make: () => Promise<{ refused: string | null }>;
  /** What it should leave in the audit log. */
  audited: Audited;
  /** Waits until the run it touched is where the change leaves it. */
  settled?: () => Promise<unknown>;
}

/** The runs a change may start or touch, followed. */
interface Followed {
  rolloutRuns: Runs;
  applyRuns: Runs;
}

/**
 * Every change staff make from the console's pages, each with what sets
 * the console up for it.
 */
const changes: {
  name: string;
  arrange: (followed: Followed) => Promise<Arranged>;
}[] = [
  {
    name: "approving a rollout's next ring",
    arrange: async ({ rolloutRuns }) => {
      const { rolloutId, run } = await waitingRollout(rolloutRuns);
      return {
        make: async () =>
          await callServerFn(
            approveRolloutFn,
            { rolloutId },
            { email: caller }
          ),
        audited: {
          action: "rollout.approve",
          clientId: null,
          target: rolloutId,
        },
        settled: async () => {
          await run.waitForStatus("complete");
        },
      };
    },
  },
  {
    name: "pausing a rollout",
    arrange: async ({ rolloutRuns }) => {
      const { rolloutId, run } = await waitingRollout(rolloutRuns);
      return {
        make: async () =>
          await callServerFn(pauseRolloutFn, { rolloutId }, { email: caller }),
        audited: { action: "rollout.pause", clientId: null, target: rolloutId },
        settled: async () => {
          await run.waitForStatus("paused");
        },
      };
    },
  },
  {
    name: "resuming a paused rollout",
    arrange: async ({ rolloutRuns }) => {
      const { rolloutId, run } = await waitingRollout(rolloutRuns);
      await pauseRollout(env, setup, rolloutId);
      await run.waitForStatus("paused");
      return {
        make: async () =>
          await callServerFn(resumeRolloutFn, { rolloutId }, { email: caller }),
        audited: {
          action: "rollout.resume",
          clientId: null,
          target: rolloutId,
        },
      };
    },
  },
  {
    name: "cancelling a rollout between rings",
    arrange: async ({ rolloutRuns }) => {
      const { rolloutId, run } = await waitingRollout(rolloutRuns);
      return {
        make: async () =>
          await callServerFn(cancelRolloutFn, { rolloutId }, { email: caller }),
        audited: {
          action: "rollout.cancel",
          clientId: null,
          target: rolloutId,
        },
        settled: async () => {
          await run.waitForStatus("terminated");
        },
      };
    },
  },
  {
    name: "rolling a client back",
    arrange: async ({ rolloutRuns }) => {
      const { rolloutId, internal, run } = await waitingRollout(rolloutRuns);
      return {
        make: async () =>
          await callServerFn(
            rollbackClientFn,
            { rolloutId, clientId: internal },
            { email: caller }
          ),
        audited: {
          action: "rollout.rollback",
          clientId: internal,
          target: rolloutId,
        },
        // The rollback ends the waiting rollout's run too.
        settled: async () => {
          await run.waitForStatus("terminated");
        },
      };
    },
  },
  {
    name: "rolling a ring back",
    arrange: async ({ rolloutRuns }) => {
      const { rolloutId, internal, run } = await waitingRollout(rolloutRuns);
      return {
        make: async () =>
          await callServerFn(
            rollbackRingFn,
            { rolloutId, ring: 0 },
            { email: caller }
          ),
        audited: {
          action: "rollout.rollback",
          clientId: internal,
          target: rolloutId,
        },
        settled: async () => {
          await run.waitForStatus("terminated");
        },
      };
    },
  },
  {
    name: "pinning a client to a release",
    arrange: async () => {
      const releaseId = await importedRelease("feat(core): pinned to");
      const clientId = await recordClient(1);
      return {
        make: async () =>
          await callServerFn(
            pinClientFn,
            { clientId, releaseId },
            { email: caller }
          ),
        audited: { action: "client.pin", clientId, target: releaseId },
      };
    },
  },
  {
    name: "moving a client to another ring",
    arrange: async () => {
      const clientId = await recordClient(1);
      return {
        make: async () =>
          await callServerFn(
            setRingFn,
            { clientId, ring: 4 },
            { email: caller }
          ),
        audited: { action: "client.ring", clientId, target: null },
      };
    },
  },
  {
    name: "changing a client's sign-in",
    arrange: async () => {
      const clientId = await recordClient(1);
      return {
        make: async () =>
          await callServerFn(
            setSignInFn,
            {
              clientId,
              signIn: { ...signIn, admins: ["bo@acme.test"] },
            },
            { email: caller }
          ),
        audited: { action: "client.sign_in", clientId, target: null },
      };
    },
  },
  {
    name: "applying a client's settings now",
    arrange: async ({ applyRuns }) => {
      const release = await importedRelease("feat(core): applied to");
      const clientId = await activeClient(1, release);
      return {
        make: async () =>
          await callServerFn(applySettingsFn, { clientId }, { email: caller }),
        audited: { action: "client.apply_settings", clientId, target: null },
        settled: async () => {
          const run = await latestOf(applyRuns);
          await run.waitForStatus("complete");
        },
      };
    },
  },
];

describe("the console's changes, through its entry", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // The database outlives each test, and every rollout reaches ring 0:
  // each test's rollout reaches only its own clients, and starts while no
  // earlier test's is open.
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

  it.each(changes.map(({ name, arrange }) => [name, arrange] as const))(
    "%s is audited as the staff member Access vouches for, about its client and target",
    async (_name, arrange) => {
      await using rolloutRuns = await follow(env.ROLLOUT);
      await using applyRuns = await follow(env.APPLY_CLIENT);
      const { make, audited, settled } = await arrange({
        rolloutRuns,
        applyRuns,
      });

      const { refused } = await make();
      await settled?.();

      expect({ refused, events: await eventsOf(audited) }).toStrictEqual({
        refused: null,
        events: [
          {
            actor: caller,
            clientId: audited.clientId,
            target: audited.target,
          },
        ],
      });
    }
  );

  it("refuses a change sent from another site's page, or by no one Access vouches for, changing and auditing nothing", async () => {
    const clientId = await recordClient(1);
    const change = { clientId, ring: 4 };

    await expect(
      callServerFn(setRingFn, change, {
        email: caller,
        from: "https://elsewhere.test",
      })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(setRingFn, change, { email: null })
    ).rejects.toThrow("The server function answered 403");

    const [client] = await db
      .select({ ring: clients.ring })
      .from(clients)
      .where(eq(clients.id, clientId));
    expect({
      ring: client?.ring,
      events: await eventsOf({
        action: "client.ring",
        clientId,
        target: null,
      }),
    }).toStrictEqual({ ring: 1, events: [] });
  });
});
