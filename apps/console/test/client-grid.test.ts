import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { clientGrid } from "../src/clients/grid.ts";
import type { GridRow } from "../src/clients/grid.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-grid-4b7d21";
const tenantToken = "test-tenant-admin-token-grid-8e1c53";
const cloudflare = mockCloudflareApi(token, tenantToken);
const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A release, published and imported. */
const importedRelease = async (notes: string): Promise<string> => {
  const release = await publishRelease({ notes });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/** A client recorded as provisioning leaves it, on a new account in the fake. */
const recordClient = async (
  status: "provisioning" | "active"
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
        name: `Acme ${clientId}`,
        accountId: account.id,
        ring: 2,
        status,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId, account };
};

/** An active client running `releaseId`, as a deploy made it live. */
const liveClient = async (releaseId: string) => {
  const client = await recordClient("active");
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, staff, client.clientId, releaseId)
  );
  return client;
};

/** Client `clientId`'s row in `grid`. */
const rowOf = (grid: GridRow[], clientId: string): GridRow | undefined =>
  grid.find(({ id }) => id === clientId);

/** How many analytics requests the fake got in this test. */
const analyticsCalls = (): number =>
  cloudflare.calls.filter(({ path }) => path === "/graphql").length;

describe("the client grid", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // Only each test's own clients are live: an earlier test's accounts are
  // gone from the fake.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("shows each client's release, ring and last deploy, and for a live one its drift, shared secrets, health and cost this month", async () => {
    const release = await importedRelease("feat(core): on the grid");
    const acme = await liveClient(release);
    acme.account.usage = {
      monthRequests: 12_000_000,
      monthCpuTimeUs: 40_000_000_000,
      monthAiCost: 1.25,
      dayRequests: 1000,
      dayErrors: 20,
    };
    const waiting = await recordClient("provisioning");

    const grid = await clientGrid(env, new Date());

    expect({
      acme: rowOf(grid, acme.clientId),
      waiting: rowOf(grid, waiting.clientId),
      analyticsCalls: analyticsCalls(),
    }).toMatchObject({
      acme: {
        status: "active",
        ring: 2,
        release,
        hostname: `${acme.clientId}.grasp.test`,
        lastDeploy: { releaseId: release, status: "done" },
        live: {
          drift: "in_sync",
          sharedSecretsCurrent: true,
          reach: "reachable",
          errorRate: 0.02,
          // $5 of Workers Paid, 2M requests past the 10M it includes at
          // $0.30 per million, 10M ms of CPU past its 30M at $0.02.
          costUsd: { workers: 5.8, ai: 1.25 },
        },
      },
      waiting: { status: "provisioning", lastDeploy: null, live: null },
      analyticsCalls: 1,
    });
  });

  it("reads every live client's usage in as few analytics requests as it can, and shows a client the analytics left out as unknown", async () => {
    // Recorded as active, never deployed: analytics read accounts, not deploys.
    const all = [];
    for (let index = 0; index < 11; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      all.push(await recordClient("active"));
    }
    for (const { account } of all.slice(1)) {
      account.usage = {
        monthRequests: 100,
        monthCpuTimeUs: 1000,
        monthAiCost: 0,
        dayRequests: 0,
        dayErrors: 0,
      };
    }

    const grid = await clientGrid(env, new Date());

    const [first, second] = all;
    expect({
      analyticsCalls: analyticsCalls(),
      unread: rowOf(grid, first?.clientId ?? "")?.live,
      idle: rowOf(grid, second?.clientId ?? "")?.live,
    }).toMatchObject({
      // 11 accounts, 10 to a request.
      analyticsCalls: 2,
      unread: { errorRate: null, costUsd: null, reach: "no_route" },
      idle: { errorRate: null, costUsd: { workers: 5, ai: 0 } },
    });
  });

  it("shows a client whose core doesn't answer as unreachable, one changed outside the console as drifted, and still shows the grid when analytics fail", async () => {
    const release = await importedRelease("feat(core): trouble");
    const down = await liveClient(release);
    const changed = await liveClient(release);
    down.account.unhealthy = 100;
    // Someone deployed another version of each Worker by hand.
    for (const script of changed.account.scripts.values()) {
      script.deployments.unshift({
        id: crypto.randomUUID(),
        created_on: new Date().toISOString(),
        versions: [{ version_id: crypto.randomUUID(), percentage: 100 }],
        annotations: {},
      });
    }
    cloudflare.failNext(({ path }) => path === "/graphql", 400);

    const grid = await clientGrid(env, new Date());

    expect({
      down: rowOf(grid, down.clientId)?.live,
      changed: rowOf(grid, changed.clientId)?.live?.drift,
    }).toMatchObject({
      down: { reach: "unreachable", drift: "in_sync", costUsd: null },
      changed: "drifted",
    });
  });
});
