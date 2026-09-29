import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clientGrid,
  defaultLiveOptions,
  gridLive,
} from "../src/clients/grid.ts";
import type { GridRow, LiveOptions } from "../src/clients/grid.ts";
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

/** How many calls the fake got for `account`'s Workers in this test. */
const callsFor = (account: AccountState): number =>
  cloudflare.calls.filter(({ path }) =>
    path.startsWith(`/accounts/${account.id}/workers`)
  ).length;

/** Reading live columns as the grid does, answers not kept between tests. */
const uncached: LiveOptions = { ...defaultLiveOptions, cache: false };

/** Some usage, for an account the analytics report. */
const someUsage = {
  monthRequests: 100,
  monthCpuTimeUs: 1000,
  monthAiCost: 0,
  dayRequests: 0,
  dayErrors: 0,
};

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

  it("shows each client's release, ring and last deploy from what the console recorded, reading no account", async () => {
    const release = await importedRelease("feat(core): on the grid");
    const acme = await liveClient(release);
    const waiting = await recordClient("provisioning");
    const calls = cloudflare.calls.length;

    const grid = await clientGrid(env);

    expect({
      acme: rowOf(grid, acme.clientId),
      waiting: rowOf(grid, waiting.clientId),
      calls: cloudflare.calls.length - calls,
    }).toMatchObject({
      acme: {
        status: "active",
        ring: 2,
        release,
        hostname: `${acme.clientId}.grasp.test`,
        lastDeploy: { releaseId: release, status: "done" },
      },
      waiting: { status: "provisioning", lastDeploy: null },
      calls: 0,
    });
  });

  it("reads a live client's drift, shared secrets, health, errors and cost this month, and nothing for one that isn't live", async () => {
    const release = await importedRelease("feat(core): live on the grid");
    const acme = await liveClient(release);
    acme.account.usage = {
      monthRequests: 12_000_000,
      monthCpuTimeUs: 40_000_000_000,
      monthAiCost: 1.25,
      dayRequests: 1000,
      dayErrors: 20,
    };
    const waiting = await recordClient("provisioning");

    const live = await gridLive(env, new Date(), uncached);

    expect({
      acme: live[acme.clientId],
      waiting: live[waiting.clientId],
      analyticsCalls: analyticsCalls(),
    }).toStrictEqual({
      acme: {
        drift: "in_sync",
        sharedSecretsCurrent: true,
        reach: "reachable",
        day: { requests: 1000, errors: 20 },
        // $5 of Workers Paid, 2M requests past the 10M it includes at
        // $0.30 per million, 10M ms of CPU past its 30M at $0.02.
        costUsd: { workers: 5.8, ai: 1.25 },
      },
      waiting: undefined,
      analyticsCalls: 1,
    });
  });

  it("reads every live client's usage in as few analytics requests as it can, and keeps an account left out, or a failed request, to its own clients", async () => {
    // Recorded as active, never deployed: analytics read accounts, not deploys.
    const recorded = [];
    for (let index = 0; index < 21; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      recorded.push(await recordClient("active"));
    }
    // The grid reads clients by id: 10 accounts to a request, then 10, then 1.
    const byId = recorded.toSorted((a, b) =>
      a.clientId.localeCompare(b.clientId)
    );
    const [unreported, idle] = byId;
    const alone = byId.at(-1);
    for (const { account } of byId.slice(1)) {
      account.usage = someUsage;
    }
    // The request for the last account alone fails outright.
    cloudflare.failNext(
      ({ path, body }) =>
        path === "/graphql" &&
        JSON.stringify(body).includes(alone?.account.id ?? "none"),
      400
    );

    const live = await gridLive(env, new Date(), uncached);

    expect({
      analyticsCalls: analyticsCalls(),
      unreported: live[unreported?.clientId ?? ""]?.costUsd,
      idle: live[idle?.clientId ?? ""],
      alone: live[alone?.clientId ?? ""]?.costUsd,
      others: byId
        .slice(1, -1)
        .every(({ clientId }) => live[clientId]?.costUsd !== null),
    }).toMatchObject({
      analyticsCalls: 3,
      unreported: null,
      // Asked of, answered none: no requests, which isn't unknown.
      idle: { day: { requests: 0, errors: 0 }, costUsd: { workers: 5, ai: 0 } },
      alone: null,
      others: true,
    });
  });

  it("reads a few clients at a time, stops one that takes too long, aborting its requests, and keeps each answer a minute", async () => {
    const release = await importedRelease("feat(core): many live");
    const all = [];
    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one deploy at a time
      all.push(await liveClient(release));
    }
    const [slow] = all;
    // The slow client's account doesn't answer until the test lets it.
    const held = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      ({ path }) =>
        path.startsWith(`/accounts/${slow?.account.id ?? ""}/workers`),
      async () => {
        await held.promise;
      }
    );
    const options: LiveOptions = {
      ...defaultLiveOptions,
      concurrency: 2,
      rowDeadlineMs: 200,
      cache: true,
    };

    const first = await gridLive(env, new Date(), options);
    const peak = cloudflare.peakAccounts();
    const aborted = cloudflare.abortedCalls();
    const callsBefore = all.map(({ account }) => callsFor(account));
    const again = await gridLive(env, new Date(), options);
    const callsAfter = all.map(({ account }) => callsFor(account));
    held.resolve(true);

    expect({
      peak,
      // Its stalled request was aborted, not left running past the deadline.
      aborted: aborted > 0,
      slow: first[slow?.clientId ?? ""],
      others: all.slice(1).map(({ clientId }) => first[clientId]?.reach),
      // Kept: the second read asked no account anything.
      again: again[all[1]?.clientId ?? ""]?.reach,
      calls: callsAfter.map(
        (count, index) => count - (callsBefore[index] ?? 0)
      ),
    }).toStrictEqual({
      peak: 2,
      aborted: true,
      slow: {
        drift: "unknown",
        sharedSecretsCurrent: null,
        reach: "unknown",
        day: null,
        costUsd: null,
      },
      others: all.slice(1).map(() => "reachable"),
      again: "reachable",
      calls: all.map(() => 0),
    });
  });

  it("keeps the usage of analytics requests that answered when another stalls past the deadline, aborting only that one", async () => {
    // Recorded as active, never deployed: analytics read accounts, not deploys.
    const recorded = [];
    for (let index = 0; index < 11; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      recorded.push(await recordClient("active"));
    }
    for (const { account } of recorded) {
      account.usage = someUsage;
    }
    // By id, 10 accounts to the first request and the last one alone to
    // the second, which never answers.
    const byId = recorded.toSorted((a, b) =>
      a.clientId.localeCompare(b.clientId)
    );
    const alone = byId.at(-1);
    const held = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      ({ path, body }) =>
        path === "/graphql" &&
        JSON.stringify(body).includes(alone?.account.id ?? "none"),
      async () => {
        await held.promise;
      }
    );

    const live = await gridLive(env, new Date(), {
      ...uncached,
      rowDeadlineMs: 200,
    });
    const aborted = cloudflare.abortedCalls();
    held.resolve(true);

    expect({
      answered: byId
        .slice(0, -1)
        .map(({ clientId }) => live[clientId]?.costUsd),
      stalled: live[alone?.clientId ?? ""]?.costUsd,
      aborted,
    }).toStrictEqual({
      answered: byId.slice(0, -1).map(() => ({ workers: 5, ai: 0 })),
      stalled: null,
      aborted: 1,
    });
  });

  it("still answers when the cache can't keep what it read, or read it back", async () => {
    const release = await importedRelease("feat(core): no cache");
    const acme = await liveClient(release);
    const broken = await caches.open("broken-in-this-test");
    vi.spyOn(broken, "match").mockRejectedValue(new Error("cache down"));
    vi.spyOn(broken, "put").mockRejectedValue(new Error("cache down"));
    vi.spyOn(caches, "open").mockResolvedValue(broken);

    const live = await gridLive(env, new Date(), defaultLiveOptions);

    expect(live[acme.clientId]).toMatchObject({
      drift: "in_sync",
      reach: "reachable",
    });
  });

  it("shows a client whose core doesn't answer as unreachable, one changed outside the console as drifted, and shared secrets as unknown, never behind, when its deployments can't be read", async () => {
    const release = await importedRelease("feat(core): trouble");
    const down = await liveClient(release);
    const changed = await liveClient(release);
    const unread = await liveClient(release);
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
    // Its account refuses one Worker's deployments listing.
    cloudflare.failNext(
      ({ path }) =>
        path.startsWith(`/accounts/${unread.account.id}/workers/scripts/`) &&
        path.endsWith("/deployments"),
      400
    );

    const live = await gridLive(env, new Date(), uncached);

    expect({
      down: live[down.clientId],
      changed: live[changed.clientId],
      unread: live[unread.clientId],
    }).toMatchObject({
      down: { reach: "unreachable", drift: "in_sync" },
      changed: { drift: "drifted" },
      unread: { drift: "unknown", sharedSecretsCurrent: null },
    });
  });
});
