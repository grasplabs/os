import { describe, expect, it, vi } from "vite-plus/test";

import {
  ensureAccount,
  ensureAiGateway,
  ensureD1Database,
  ensureMember,
  ensureR2Bucket,
  ensureWorkersSubdomain,
  getAccount,
  listAccounts,
} from "../src/cloudflare/accounts.ts";
import { CloudflareApiError, cloudflareApi } from "../src/cloudflare/api.ts";
import {
  deployerEmail,
  mockCloudflareApi,
  tenantEmail,
} from "./cloudflare-api.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
/** No waiting between retries: the fake answers at once. */
const api = cloudflareApi({ token, retryDelayMs: 0 });
/** A tenant admin's: it alone creates accounts. */
const tenant = cloudflareApi({
  token: `${token}-tenant-admin`,
  retryDelayMs: 0,
});

/** What `promise` fails with, or undefined if it doesn't. */
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("accounts", () => {
  it("reads an account the token is a member of", async () => {
    const account = cloudflare.addAccount("Acme");
    await expect(getAccount(api, account.id)).resolves.toStrictEqual({
      id: account.id,
      name: "Acme",
    });
  });

  it("lists every account, page by page", async () => {
    const added = Array.from({ length: 57 }, (_, index) =>
      cloudflare.addAccount(`Client ${index}`)
    );
    const accounts = await listAccounts(api);
    expect(accounts.map(({ id }) => id)).toStrictEqual(
      added.map(({ id }) => id)
    );
    expect(
      cloudflare.calls.map(({ query }) => query.get("page"))
    ).toStrictEqual(["1", "2"]);
  });

  it("fails a list longer than it walks, rather than return part of it", async () => {
    for (let index = 0; index <= 1000; index += 1) {
      cloudflare.addAccount(`Client ${index}`);
    }
    await expect(listAccounts(api)).rejects.toThrow(
      "Listing /accounts passed 20 pages"
    );
  });

  it("creates an account by name once, as a tenant admin, matching the name exactly", async () => {
    cloudflare.addAccount("grasp-os-acme-old", tenantEmail);
    const created = await ensureAccount(tenant, "grasp-os-acme");
    const again = await ensureAccount(tenant, "grasp-os-acme");
    expect({
      again,
      named: cloudflare.accountsNamed("grasp-os-acme").length,
      asDeployer: await errorOf(ensureAccount(api, "grasp-os-other")),
    }).toMatchObject({ again: created, named: 1, asDeployer: { status: 403 } });
  });

  it("refuses to pick between two accounts of one name", async () => {
    cloudflare.addAccount("grasp-os-twin", tenantEmail);
    cloudflare.addAccount("grasp-os-twin", tenantEmail);
    await expect(ensureAccount(tenant, "grasp-os-twin")).rejects.toThrow(
      "2 accounts are named grasp-os-twin"
    );
  });

  it("makes the deployer a member as an Administrator once, at once, and refuses a pending one or a role the account lacks", async () => {
    const account = cloudflare.addAccount("grasp-os-member", tenantEmail);
    await ensureMember(tenant, account.id, deployerEmail, "Administrator");
    await ensureMember(tenant, account.id, deployerEmail, "Administrator");
    const posts = cloudflare.calls.filter(
      ({ method, path }) => method === "POST" && path.endsWith("/members")
    );
    const pending = cloudflare.addAccount("grasp-os-pending", tenantEmail);
    pending.members.set(deployerEmail, "pending");

    const messageOf = async (promise: Promise<unknown>) => {
      const error = await errorOf(promise);
      return error instanceof Error ? error.message : error;
    };
    expect({
      member: account.members.get(deployerEmail),
      posts: posts.map(({ body }) => body),
      pending: await messageOf(
        ensureMember(tenant, pending.id, deployerEmail, "Administrator")
      ),
      role: await messageOf(
        ensureMember(tenant, pending.id, "someone@grasp.test", "No such role")
      ),
    }).toStrictEqual({
      member: "accepted",
      posts: [
        { email: deployerEmail, roles: ["role-admin"], status: "accepted" },
      ],
      pending: `${deployerEmail}'s membership of ${pending.id} is pending`,
      role: `Account ${pending.id} has no role named No such role`,
    });
  });

  it("refuses an account the token isn't a member of", async () => {
    await expect(
      getAccount(api, "someone-elses-account")
    ).rejects.toMatchObject({
      status: 403,
      codes: [9109],
    });
  });
});

describe("EU resources", () => {
  it("creates each resource once, in the EU, however often it runs", async () => {
    const account = cloudflare.addAccount();
    const provision = async () =>
      await Promise.all([
        ensureWorkersSubdomain(api, account.id, "grasp-acme"),
        ensureD1Database(api, account.id, "grasp-os-core"),
        ensureR2Bucket(api, account.id, "grasp-os-files"),
        ensureAiGateway(api, account.id, "grasp-os"),
      ]);

    const first = await provision();
    const again = await provision();

    expect(again).toStrictEqual(first);
    expect(account).toMatchObject({
      subdomain: "grasp-acme",
      d1: [{ name: "grasp-os-core", jurisdiction: "eu" }],
      buckets: [{ name: "grasp-os-files", jurisdiction: "eu" }],
      gateways: [
        {
          id: "grasp-os",
          authentication: true,
          collect_logs: true,
          cache_ttl: 0,
        },
      ],
    });
  });

  it("keeps the workers.dev subdomain an account already has", async () => {
    const account = cloudflare.addAccount();
    account.subdomain = "chosen-earlier";
    await expect(
      ensureWorkersSubdomain(api, account.id, "grasp-acme")
    ).resolves.toBe("chosen-earlier");
  });

  it("switches authentication on for a gateway that has it off, keeping its settings", async () => {
    const account = cloudflare.addAccount();
    const settings = {
      cache_invalidate_on_update: true,
      cache_ttl: 60,
      collect_logs: true,
      rate_limiting_interval: 60,
      rate_limiting_limit: 100,
      rate_limiting_technique: "sliding",
      // BYOK's key store and a log export: an update that dropped them would
      // cut the client off its own provider keys.
      store_id: "byok-store-1",
      logpush: true,
      logpush_public_key: "public-key",
    };
    account.gateways.push({
      id: "grasp-os",
      authentication: false,
      created_at: "2026-09-01T00:00:00Z",
      modified_at: "2026-09-01T00:00:00Z",
      ...settings,
    });

    await expect(
      ensureAiGateway(api, account.id, "grasp-os")
    ).resolves.toStrictEqual({
      id: "grasp-os",
      authentication: true,
      ...settings,
    });
    // The update sent every setting back, and no read-only field.
    const update = cloudflare.calls.find(({ method }) => method === "PUT");
    expect(update?.body).toStrictEqual({ ...settings, authentication: true });
    expect(account.gateways).toStrictEqual([
      { id: "grasp-os", authentication: true, ...settings },
    ]);

    // Once on, it's left alone.
    await ensureAiGateway(api, account.id, "grasp-os");
    expect(cloudflare.calls.map(({ method }) => method)).toStrictEqual([
      "GET",
      "PUT",
      "GET",
    ]);
  });

  it("finds a D1 database by its exact name", async () => {
    const account = cloudflare.addAccount();
    account.d1.push({
      uuid: "other",
      name: "grasp-os-core-old",
      jurisdiction: "eu",
    });
    const database = await ensureD1Database(api, account.id, "grasp-os-core");
    expect(database.uuid).not.toBe("other");
    expect(account.d1).toHaveLength(2);
  });

  it("stops at a D1 database outside the EU, creating nothing", async () => {
    const account = cloudflare.addAccount();
    account.d1.push({ uuid: "us", name: "grasp-os-core" });
    await expect(
      ensureD1Database(api, account.id, "grasp-os-core")
    ).rejects.toThrow(
      "D1 database grasp-os-core exists outside the EU jurisdiction (none)"
    );
    expect(account.d1).toHaveLength(1);
  });

  it("refuses a D1 database created outside the EU", async () => {
    const account = cloudflare.addAccount();
    account.d1Reports = "fedramp";

    await expect(
      ensureD1Database(api, account.id, "grasp-os-core")
    ).rejects.toThrow(
      "D1 database grasp-os-core exists outside the EU jurisdiction (fedramp)"
    );
  });

  it("never uses a bucket of the same name outside the EU", async () => {
    const account = cloudflare.addAccount();
    account.buckets.push({ name: "grasp-os-files", jurisdiction: "default" });
    await ensureR2Bucket(api, account.id, "grasp-os-files");
    expect(account.buckets).toStrictEqual([
      { name: "grasp-os-files", jurisdiction: "default" },
      { name: "grasp-os-files", jurisdiction: "eu" },
    ]);
  });

  it("refuses a bucket R2 reports outside the EU, found or created", async () => {
    const account = cloudflare.addAccount();
    account.r2Reports = "default";
    // Created: the create answers with the wrong jurisdiction.
    await expect(
      ensureR2Bucket(api, account.id, "grasp-os-files")
    ).rejects.toThrow(
      "R2 bucket grasp-os-files exists outside the EU jurisdiction (default)"
    );
    // Found: the lookup does too.
    await expect(
      ensureR2Bucket(api, account.id, "grasp-os-files")
    ).rejects.toThrow(
      "R2 bucket grasp-os-files exists outside the EU jurisdiction (default)"
    );
    expect(cloudflare.calls.map(({ method }) => method)).toStrictEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });
});

describe("retries", () => {
  it("retries a rate-limited call, creating once", async () => {
    const account = cloudflare.addAccount();
    // The list finds nothing; the create is refused twice, then goes through.
    cloudflare.failCall(2, 429);
    cloudflare.failCall(3, 429);
    await ensureD1Database(api, account.id, "grasp-os-core");
    expect(account.d1).toHaveLength(1);
    expect(cloudflare.calls.map(({ method }) => method)).toStrictEqual([
      "GET",
      "POST",
      "POST",
      "POST",
    ]);
  });

  it("retries a read after a server error or no answer", async () => {
    const account = cloudflare.addAccount("Acme");
    cloudflare.failCall(1, 502);
    cloudflare.failCall(2, 503);
    cloudflare.failCall(3, "network");
    await expect(getAccount(api, account.id)).resolves.toMatchObject({
      name: "Acme",
    });
    expect(cloudflare.calls).toHaveLength(4);
  });

  it("doesn't retry a create that may have gone through", async () => {
    const account = cloudflare.addAccount();
    cloudflare.failCall(2, 500);
    await expect(
      ensureD1Database(api, account.id, "grasp-os-core")
    ).rejects.toMatchObject({ status: 500, codes: [10_000] });
    cloudflare.failCall(1, "network");
    await expect(
      ensureR2Bucket(api, account.id, "grasp-os-files")
    ).resolves.toMatchObject({ name: "grasp-os-files" });
    cloudflare.failCall(2, "network");
    await expect(
      ensureAiGateway(api, account.id, "grasp-os")
    ).rejects.toMatchObject({ status: 0 });
    expect(cloudflare.calls.map(({ method }) => method)).toStrictEqual([
      "GET",
      "POST",
      "GET",
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
  });

  it("adopts what a create made when its answer was lost", async () => {
    const account = cloudflare.addAccount();
    // The lookup, then the create, which runs but never answers.
    cloudflare.failCall(2, "lost");
    await expect(
      ensureD1Database(api, account.id, "grasp-os-core")
    ).rejects.toMatchObject({ status: 0 });
    cloudflare.failCall(2, "lost");
    await expect(
      ensureR2Bucket(api, account.id, "grasp-os-files")
    ).rejects.toMatchObject({ status: 0 });

    // The step runs again and finds both, creating nothing more.
    const database = await ensureD1Database(api, account.id, "grasp-os-core");
    await ensureR2Bucket(api, account.id, "grasp-os-files");
    expect(account.d1).toStrictEqual([database]);
    expect(account.buckets).toStrictEqual([
      { name: "grasp-os-files", jurisdiction: "eu" },
    ]);
  });

  it("waits as long as a 429's Retry-After asks, up to a minute", async () => {
    const account = cloudflare.addAccount();
    const wait = vi.spyOn(scheduler, "wait").mockResolvedValue();
    cloudflare.failCall(1, { retryAfter: "7" });
    cloudflare.failCall(2, { retryAfter: "3600" });
    cloudflare.failCall(3, { retryAfter: "soon" });
    await getAccount(api, account.id);
    // Seven seconds; capped at a minute; no number, so the usual backoff.
    expect(wait.mock.calls).toStrictEqual([[7000], [60_000], [0]]);
  });

  it("gives up after four attempts, waiting twice as long each time", async () => {
    const account = cloudflare.addAccount();
    // Waits are counted, not waited.
    const wait = vi.spyOn(scheduler, "wait").mockResolvedValue();
    const slow = cloudflareApi({ token, retryDelayMs: 100 });
    for (const n of [1, 2, 3, 4]) {
      cloudflare.failCall(n, 429);
    }
    await expect(getAccount(slow, account.id)).rejects.toMatchObject({
      status: 429,
      codes: [971],
    });
    expect(cloudflare.calls).toHaveLength(4);
    expect(wait.mock.calls).toStrictEqual([[100], [200], [400]]);
  });

  it("reports an answer without the API's envelope by its status", async () => {
    const account = cloudflare.addAccount();
    for (const n of [1, 2, 3, 4]) {
      cloudflare.failCall(n, 502);
    }
    await expect(getAccount(api, account.id)).rejects.toThrow(
      `Cloudflare API GET /accounts/${account.id} failed (502)`
    );
  });
});

describe("the token", () => {
  it("goes only into the Authorization header", async () => {
    const account = cloudflare.addAccount();
    await ensureD1Database(api, account.id, "grasp-os-core");
    for (const { headers, path, query } of cloudflare.calls) {
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(`${path}?${query.toString()}`).not.toContain(token);
    }
  });

  it("never shows in an error", async () => {
    const wrong = cloudflareApi({
      token: "wrong-token-9876543210",
      retryDelayMs: 0,
    });
    const account = cloudflare.addAccount();
    const error = await errorOf(getAccount(wrong, account.id));
    expect(error).toBeInstanceOf(CloudflareApiError);
    const shown = `${String(error)} ${JSON.stringify(error)} ${error instanceof Error ? error.stack : ""}`;
    expect(shown).not.toContain("wrong-token-9876543210");
    expect(shown).toContain("10000 Authentication error");
  });
});
