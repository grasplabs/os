import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { consoleDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clientDeploys,
  clientRuns,
  clients,
} from "../src/db/schema.ts";
import {
  confirmWorkersPaid,
  retryProvisioning,
  startProvisioning,
} from "../src/provision/control.ts";
import type { ProvisionInput } from "../src/provision/control.ts";
import { startingMs } from "../src/provision/runs.ts";
import { accountName } from "../src/provision/workflow.ts";
import { importReleases } from "../src/releases/import.ts";
import {
  deployerEmail,
  mockCloudflareApi,
  tenantEmail,
} from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";

const token = "test-deployer-token-provision-7f3a9c";
const tenantToken = "test-tenant-admin-token-provision-2b8e41";
const cloudflare = mockCloudflareApi(token, tenantToken);
const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };
/** The console's CLIENT_DOMAIN in the test pool (vite.test.config.ts). */
const domain = "grasp.test";

/** What the local Secrets Store (Miniflare) offers tests to manage a secret. */
interface SecretsStoreAdmin {
  create: (value: string) => Promise<string>;
  delete: (id: string) => Promise<void>;
}

/** The local Secrets Store's admin API for the secret `binding` names. */
const adminOf = async (
  binding: SecretsStoreSecret
): Promise<SecretsStoreAdmin> => {
  // SAFETY: Miniflare's local Secrets Store binding answers this method with
  // its admin API, whose `create` and `delete` have these signatures.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const admin = Reflect.get(
    binding,
    "SecretsStoreSecret::admin_api"
  ) as () => Promise<SecretsStoreAdmin>;
  return await admin();
};

/** Every secret the console reads, as deploy-ops puts them in the store. */
const storeSecrets: [SecretsStoreSecret, string][] = [
  [env.TENANT_ADMIN_TOKEN, tenantToken],
  [env.DEPLOYER_API_TOKEN, token],
  [env.ROUTER_KEY, "test-router-key"],
  [env.CLIENT_KEY, "test-client-key"],
  [env.ENTRA_CLIENT_SECRET, "entra-secret"],
  [env.MICROSOFT_CLIENT_SECRET, "microsoft-secret"],
  [env.GOOGLE_CLIENT_SECRET, "google-secret"],
  [env.COMPOSIO_API_KEY, "composio-key"],
];

/** A release imported to provision with, and a new client's input. */
const setUp = async (input: Partial<ProvisionInput> = {}) => {
  const release = await publishRelease({ notes: "feat(core): onboard me" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  return {
    clientId,
    input: {
      clientId,
      name: "Acme",
      releaseId: release.id,
      ring: 2,
      ...input,
    },
  };
};

/**
 * The runs the test creates, as the test pool lets a test follow them,
 * retries going at once (the fake answers at once): each wait is on the
 * latest run created, and `count` says how many there were.
 */
const followRuns = async () => {
  const runs = await introspectWorkflow(env.PROVISION_CLIENT);
  await runs.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const latest = async () => {
    const all = await runs.get();
    const last = all.at(-1);
    if (last === undefined) {
      throw new Error("No run was created");
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
    getOutput: async () => {
      const run = await latest();
      return await run.getOutput();
    },
    count: async () => {
      const all = await runs.get();
      return all.length;
    },
    [Symbol.asyncDispose]: async () => {
      await runs.dispose();
    },
  };
};

/** Client `clientId`'s current run, as Workflows has it. */
const instanceOf = async (clientId: string) => {
  const [claim] = await db
    .select({ runId: clientRuns.runId })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  return await env.PROVISION_CLIENT.get(claim?.runId ?? "none");
};

const clientRow = async (id: string) => {
  const [row] = await db.select().from(clients).where(eq(clients.id, id));
  return row;
};

/** The client's audit actions, oldest first. */
const actions = async (clientId: string): Promise<string[]> => {
  const rows = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.clientId, clientId))
    // Events of one millisecond in the order they were written.
    .orderBy(asc(auditEvents.at), sql`rowid`);
  return rows.map(({ action }) => action);
};

/** The client's deploys, their status and error. */
const deploysOf = async (clientId: string) =>
  await db
    .select({ status: clientDeploys.status, error: clientDeploys.error })
    .from(clientDeploys)
    .where(eq(clientDeploys.clientId, clientId));

/** Every row of every table in the console's database, as text. */
const everyRow = async (): Promise<string> => {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'"
  ).all<{ name: string }>();
  const dumps = await Promise.all(
    tables.map(async ({ name }) => {
      const { results } = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
      return JSON.stringify(results);
    })
  );
  return dumps.join("\n");
};

/** What the Worker writes to its logs while `task` runs, kept out of the output. */
const logsOf = async (task: () => Promise<void>): Promise<string> => {
  const lines: unknown[] = [];
  const keep = (...args: unknown[]) => {
    lines.push(args);
  };
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (level) => vi.spyOn(console, level).mockImplementation(keep)
  );
  try {
    await task();
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
  return JSON.stringify(lines, (_key, value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}` : value
  );
};

/** A create call of the API at a path ending in `path`. */
const isCreate =
  (path: string) =>
  (call: { method: string; path: string }): boolean =>
    call.method === "POST" && call.path.endsWith(path);

/** The code `promise` is refused with, or `resolved` if it isn't. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? error.code
      : "not a provisioning error";
  }
  return "resolved";
};

/** The names in `items`, sorted. */
const sortedNames = (items: readonly { name: string }[] = []): string[] =>
  items.map(({ name }) => name).toSorted((a, b) => a.localeCompare(b));

/** The detail of each of the client's audit events of `action`, oldest first. */
const detailsOf = async (
  clientId: string,
  action: string
): Promise<unknown[]> => {
  const rows = await db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    )
    .orderBy(asc(auditEvents.at), sql`rowid`);
  return rows.map(({ detail }): unknown => JSON.parse(detail ?? "null"));
};

/** The client's resumes, oldest first: whether each replaced a run. */
const retriesOf = async (clientId: string) => {
  const details = await detailsOf(clientId, "client.provision_retry");
  return details.map((detail) => {
    const field = (key: string): unknown =>
      typeof detail === "object" && detail !== null
        ? Reflect.get(detail, key)
        : undefined;
    return { replaced: typeof field("replaces") === "string" };
  });
};

/** Another client's entry for `clientId`'s hostname, which holds it until cleared. */
const holdHostname = async (clientId: string): Promise<string> => {
  const hostname = `${clientId}.${domain}`;
  await env.ROUTER_HOSTS.put(
    hostname,
    JSON.stringify({
      clientId: "someone-else",
      coreUrl: "https://grasp-os-core.elsewhere.workers.dev",
      generation: 1,
    })
  );
  return hostname;
};

describe("provisioning a new client", () => {
  const stored: { admin: SecretsStoreAdmin; id: string }[] = [];

  beforeEach(async () => {
    for (const [binding, value] of storeSecrets) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      const admin = await adminOf(binding);
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      stored.push({ admin, id: await admin.create(value) });
    }
  });
  afterEach(async () => {
    for (const { admin, id } of stored.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await admin.delete(id);
    }
  });

  it("creates its account as the tenant admin, makes the deployer a member, waits for Workers Paid, then deploys the release and activates it, audited", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();

    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });
    // Waiting for staff: nothing is deployed before they confirm.
    const accounts = cloudflare.accountsNamed(accountName(clientId));
    const [account] = accounts;
    expect({
      accounts: accounts.length,
      members: Object.fromEntries(account?.members ?? []),
      databases: account?.d1.length,
      deploys: await deploysOf(clientId),
    }).toStrictEqual({
      accounts: 1,
      members: { [tenantEmail]: "accepted", [deployerEmail]: "accepted" },
      databases: 0,
      deploys: [],
    });

    await confirmWorkersPaid(env, staff, clientId);
    await run.waitForStatus("complete");

    const trail = await actions(clientId);
    expect({
      client: await clientRow(clientId),
      made: [...(account?.d1 ?? []), ...(account?.buckets ?? [])]
        .map(({ name, jurisdiction }) => `${name} in ${jurisdiction}`)
        .toSorted((a, b) => a.localeCompare(b)),
      entry: await env.ROUTER_HOSTS.get(`${clientId}.${domain}`, "json"),
      clientEvents: trail.filter((action) => action.startsWith("client.")),
      deployDone: trail.includes("deploy.done"),
    }).toMatchObject({
      client: {
        name: "Acme",
        accountId: account?.id,
        ring: 2,
        status: "active",
        createdBy: staff.email,
      },
      made: [
        "grasp-os-audit-archive in eu",
        "grasp-os-connect in eu",
        "grasp-os-core in eu",
        "grasp-os-files in eu",
        "grasp-os-knowledge in eu",
      ],
      entry: { clientId, generation: 1 },
      clientEvents: [
        "client.provision_start",
        "client.create",
        "client.workers_paid",
        "client.workers_subdomain",
        "client.activate",
      ],
      deployDone: true,
    });
    // Each Worker got the secrets every client shares that it takes.
    const secretsOf = (script: string) =>
      [
        ...(account?.scripts.get(script)?.versions.at(-1)?.secrets.keys() ??
          []),
      ].toSorted((a, b) => a.localeCompare(b));
    expect({
      core: secretsOf("grasp-os-core"),
      connect: secretsOf("grasp-os-connect"),
    }).toStrictEqual({
      core: [
        "BETTER_AUTH_SECRET",
        "CAPABILITY_SIGNING_KEY",
        "ENTRA_CLIENT_SECRET",
        "GOOGLE_CLIENT_SECRET",
        "ROUTER_SECRET",
      ],
      connect: [
        "CAPABILITY_SIGNING_KEY",
        "COMPOSIO_API_KEY",
        "GOOGLE_CLIENT_SECRET",
        "MICROSOFT_CLIENT_SECRET",
        "TOKEN_ENCRYPTION_KEY",
      ],
    });
  });

  it("adopts an account the deployer is a member of by its id, creating none", async () => {
    const account = cloudflare.addAccount("Acme's own");
    const { clientId, input } = await setUp({ accountId: account.id });
    await using run = await followRuns();

    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });
    await confirmWorkersPaid(env, staff, clientId);
    await run.waitForStatus("complete");

    expect({
      client: await clientRow(clientId),
      creates: cloudflare.calls.filter(isCreate("/accounts")).length,
    }).toMatchObject({
      client: { accountId: account.id, status: "active" },
      creates: 0,
    });
  });

  it("refuses to adopt an account that runs a Grasp Worker, or that the deployer can't reach, before a run starts", async () => {
    const staging = cloudflare.addAccount("Grasp staging");
    staging.scripts.set("grasp-os-core", {
      versions: [],
      deployments: [],
      schedules: [],
    });
    const stranger = cloudflare.addAccount("Not ours", "someone@else.test");
    const { clientId, input } = await setUp();

    const inUse = await codeOf(
      startProvisioning(env, staff, { ...input, accountId: staging.id })
    );
    const unreachable = await codeOf(
      startProvisioning(env, staff, { ...input, accountId: stranger.id })
    );
    const trail = await actions(clientId);
    expect({ inUse, unreachable, started: trail.length }).toStrictEqual({
      inUse: "account_in_use",
      unreachable: "account_unreachable",
      started: 0,
    });
  });

  it("stops at once, without a retry, when the account it would create runs a Grasp Worker already", async () => {
    const { clientId, input } = await setUp();
    // An account of the client's name that already runs Grasp: not one an
    // earlier run of this client made, since no client is recorded on it.
    const taken = cloudflare.addAccount(accountName(clientId), tenantEmail);
    taken.members.set(deployerEmail, "accepted");
    taken.scripts.set("grasp-os-connect", {
      versions: [],
      deployments: [],
      schedules: [],
    });
    await using run = await followRuns();

    await startProvisioning(env, staff, input);
    await run.waitForStatus("errored");

    expect({
      stops: await detailsOf(clientId, "client.provision_stop"),
      scriptLists: cloudflare.calls.filter(
        ({ method, path }) =>
          method === "GET" && path === `/accounts/${taken.id}/workers/scripts`
      ).length,
      client: await clientRow(clientId),
    }).toStrictEqual({
      stops: [
        {
          step: "account",
          error: `account_in_use: Account ${taken.id} already runs grasp-os-connect`,
        },
      ],
      scriptLists: 1,
      client: undefined,
    });
  });

  it("resumes steps whose creates went through with their answers lost, making each thing once, and keeps both tokens out of the database, logs, step results and status", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();
    // The account's create, the deployer's membership and a database's go
    // through, and their answers never arrive: each step fails and runs
    // run.
    cloudflare.failNext(isCreate("/accounts"), "lost");
    cloudflare.failNext(isCreate("/members"), "lost");
    cloudflare.failNext(isCreate("/d1/database"), "lost");

    const logs = await logsOf(async () => {
      await startProvisioning(env, staff, input);
      await run.waitForStepResult({ name: "client" });
      await confirmWorkersPaid(env, staff, clientId);
      await run.waitForStatus("complete");
    });

    const accounts = cloudflare.accountsNamed(accountName(clientId));
    expect({
      accounts: accounts.length,
      member: accounts[0]?.members.get(deployerEmail),
      databases: sortedNames(accounts[0]?.d1),
      // The deploy step failed once and ran again: its failure was logged.
      failureLogged: logs.includes("deploy.failed"),
    }).toStrictEqual({
      accounts: 1,
      member: "accepted",
      databases: ["grasp-os-connect", "grasp-os-core", "grasp-os-knowledge"],
      failureLogged: true,
    });
    const instance = await instanceOf(clientId);
    const texts = [
      logs,
      await everyRow(),
      JSON.stringify(await run.getOutput()),
      JSON.stringify(await run.waitForStepResult({ name: "account" })),
      JSON.stringify(await run.waitForStepResult({ name: "deploy" })),
      JSON.stringify(await instance.status()),
    ];
    expect(
      texts.map((text) => text.includes(token) || text.includes(tenantToken))
    ).toStrictEqual([false, false, false, false, false, false]);
  });

  it("stops a run at once on a failure no retry fixes, and resumes it with a new run that picks up its deploy: nothing made twice, Workers Paid not asked again", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();
    const hostname = await holdHostname(clientId);

    await logsOf(async () => {
      await startProvisioning(env, staff, input);
      await run.waitForStepResult({ name: "client" });
      await confirmWorkersPaid(env, staff, clientId);
      await run.waitForStatus("errored");
    });
    // One attempt: a retry would have recorded the failure run.
    const failures = await detailsOf(clientId, "deploy.fail");
    expect({
      deploys: await deploysOf(clientId),
      failures: failures.length,
      stops: await detailsOf(clientId, "client.provision_stop"),
      client: await clientRow(clientId),
    }).toMatchObject({
      deploys: [{ status: "failed", error: "hostname_taken" }],
      failures: 1,
      stops: [
        {
          step: "deploy",
          error: `hostname_taken: ${hostname} routes to another client`,
        },
      ],
      client: { status: "provisioning" },
    });

    await env.ROUTER_HOSTS.delete(hostname);
    await retryProvisioning(env, staff, clientId);
    await run.waitForStatus("complete");

    const [account] = cloudflare.accountsNamed(accountName(clientId));
    const trail = await actions(clientId);
    expect({
      databases: account?.d1.length,
      buckets: account?.buckets.length,
      // The resumed deploy deployed the versions it had uploaded.
      versions: [...(account?.scripts.values() ?? [])].map(
        ({ versions }) => versions.length
      ),
      deploys: await deploysOf(clientId),
      confirmations: trail.filter((action) => action === "client.workers_paid")
        .length,
      retries: await retriesOf(clientId),
      client: await clientRow(clientId),
    }).toMatchObject({
      databases: 3,
      buckets: 2,
      versions: [1, 1],
      deploys: [{ status: "done", error: null }],
      confirmations: 1,
      // A new run in place of the stopped one, without the pause.
      retries: [{ replaced: true }],
      client: { status: "active" },
    });
  });

  it("gives a client whose run is gone a new run, which doesn't ask for Workers Paid again once it got to a deploy", async () => {
    const { clientId, input } = await setUp();
    const hostname = await holdHostname(clientId);
    await using run = await followRuns();
    await logsOf(async () => {
      await startProvisioning(env, staff, input);
      await run.waitForStepResult({ name: "client" });
      await confirmWorkersPaid(env, staff, clientId);
      await run.waitForStatus("errored");
    });
    // As Workflows drops a run after its retention.
    const gone = await instanceOf(clientId);
    await gone.delete();
    await db
      .update(clientRuns)
      .set({ claimedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(clientRuns.clientId, clientId));
    await env.ROUTER_HOSTS.delete(hostname);

    // The new run stops before its own deploy: the deployer lost its
    // membership meanwhile.
    const [account] = cloudflare.accountsNamed(accountName(clientId));
    account?.members.delete(deployerEmail);
    await retryProvisioning(env, staff, clientId);
    await run.waitForStatus("errored");
    const stops = await detailsOf(clientId, "client.provision_stop");
    // Resumed once it's back, though the new run never got to its deploy
    // step: replaced by another new run, still without the pause.
    account?.members.set(deployerEmail, "accepted");
    await retryProvisioning(env, staff, clientId);
    await run.waitForStatus("complete");

    expect(stops.at(-1)).toStrictEqual({
      step: "account",
      error: `account_unreachable: The deployer isn't a member of account ${account?.id}`,
    });
    const trail = await actions(clientId);
    expect({
      client: await clientRow(clientId),
      accounts: cloudflare.accountsNamed(accountName(clientId)).length,
      confirmations: trail.filter((action) => action === "client.workers_paid")
        .length,
      retries: await retriesOf(clientId),
      deploys: await deploysOf(clientId),
    }).toMatchObject({
      client: { status: "active" },
      accounts: 1,
      confirmations: 1,
      retries: [
        // The first replaced the run that was gone, the second its
        // successor that stopped.
        { replaced: true },
        { replaced: true },
      ],
      deploys: [{ status: "done" }],
    });
  });

  it("lets staff start again with another account when the run couldn't settle the first, and records the account it left", async () => {
    const { clientId, input } = await setUp();
    // The client's account exists with the deployer's membership pending:
    // the account step can't finish.
    const stuck = cloudflare.addAccount(accountName(clientId), tenantEmail);
    stuck.members.set(deployerEmail, "pending");
    await using run = await followRuns();

    await startProvisioning(env, staff, input);
    await run.waitForStatus("errored");
    const before = await clientRow(clientId);

    const account = cloudflare.addAccount("Acme");
    await startProvisioning(env, staff, { ...input, accountId: account.id });
    await run.waitForStepResult({ name: "client" });

    expect({
      before,
      after: await clientRow(clientId),
      created: await detailsOf(clientId, "client.create"),
    }).toMatchObject({
      before: undefined,
      after: { accountId: account.id },
      created: [{ ring: 2, abandonedAccountId: stuck.id }],
    });
  });

  it("starts one run for a client however many starts race, and refuses the rest", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();

    // Both may read that the client has no run: the claim in D1 lets one
    // through, and only it creates a run.
    const starts = await Promise.all([
      codeOf(startProvisioning(env, staff, input)),
      codeOf(startProvisioning(env, staff, input)),
    ]);
    await run.waitForStepResult({ name: "client" });

    const trail = await actions(clientId);
    expect({
      starts: starts.map(String).toSorted((a, b) => a.localeCompare(b)),
      runs: await run.count(),
      accounts: cloudflare.accountsNamed(accountName(clientId)).length,
      claims: trail.filter((action) => action === "client.provision_start")
        .length,
      again: await codeOf(startProvisioning(env, staff, input)),
    }).toStrictEqual({
      starts: ["already_running", "resolved"],
      runs: 1,
      accounts: 1,
      claims: 1,
      again: "already_running",
    });
  });

  it("lets a new run go on when a Workers Paid confirmation races the resume that replaces a stopped run, whichever lands first", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();
    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });
    // The run waiting for Workers Paid ends before staff confirm (its wait
    // timed out, say).
    const waiting = await instanceOf(clientId);
    await waiting.terminate();
    await run.waitForStatus("terminated");

    // A confirmation and a resume at once: the confirmation may reach the
    // old run, the new one before it waits, or the new one waiting.
    await Promise.all([
      confirmWorkersPaid(env, staff, clientId),
      retryProvisioning(env, staff, clientId),
    ]);
    await run.waitForStatus("complete");

    const trail = await actions(clientId);
    expect({
      runs: await run.count(),
      confirmations: trail.filter((action) => action === "client.workers_paid")
        .length,
      client: await clientRow(clientId),
    }).toMatchObject({
      runs: 2,
      confirmations: 1,
      client: { status: "active" },
    });
  });

  it("lets a new run go on without asking again when staff confirmed Workers Paid on the run it replaced", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();
    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });
    const waiting = await instanceOf(clientId);
    await waiting.terminate();
    await run.waitForStatus("terminated");

    // The confirmation lands first, on the run that stopped: it takes no
    // event, and the resume's new run finds the confirmation.
    await confirmWorkersPaid(env, staff, clientId);
    await retryProvisioning(env, staff, clientId);
    await run.waitForStatus("complete");

    const confirmed = await run.waitForStepResult({
      name: "workers paid confirmed",
    });
    expect({ confirmed, client: await clientRow(clientId) }).toMatchObject({
      confirmed: true,
      client: { status: "active" },
    });
  });

  it("resumes a stopped run once however many resumes race, and refuses the rest", async () => {
    const { clientId, input } = await setUp();
    const hostname = await holdHostname(clientId);
    await using run = await followRuns();
    await logsOf(async () => {
      await startProvisioning(env, staff, input);
      await run.waitForStepResult({ name: "client" });
      await confirmWorkersPaid(env, staff, clientId);
      await run.waitForStatus("errored");
    });
    await env.ROUTER_HOSTS.delete(hostname);

    const resumes = await Promise.all([
      codeOf(retryProvisioning(env, staff, clientId)),
      codeOf(retryProvisioning(env, staff, clientId)),
    ]);
    await run.waitForStatus("complete");

    const retries = await retriesOf(clientId);
    expect({
      resumes: resumes.map(String).toSorted((a, b) => a.localeCompare(b)),
      runs: await run.count(),
      claims: retries.length,
      client: await clientRow(clientId),
    }).toMatchObject({
      resumes: ["already_running", "resolved"],
      runs: 2,
      claims: 1,
      client: { status: "active" },
    });
  });

  it("retries the account step when the account lookup times out, rather than stopping", async () => {
    const account = cloudflare.addAccount("Acme's own");
    const { clientId, input } = await setUp({ accountId: account.id });
    const lookup = `/accounts/${account.id}`;
    // The start reads the account first; the run's own read times out.
    let reads = 0;
    cloudflare.failNext((call) => {
      if (call.method !== "GET" || call.path !== lookup) {
        return false;
      }
      reads += 1;
      return reads === 2;
    }, 408);
    await using run = await followRuns();

    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });

    expect({
      reads: cloudflare.calls.filter(
        ({ method, path }) => method === "GET" && path === lookup
      ).length,
      stops: await detailsOf(clientId, "client.provision_stop"),
      client: await clientRow(clientId),
    }).toMatchObject({
      reads: 3,
      stops: [],
      client: { accountId: account.id },
    });
  });

  it("records where a run stopped once a step used up its retries on a failure a retry could have fixed", async () => {
    const { clientId, input } = await setUp();
    // The account's create answers a server error, every time.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      cloudflare.failNext(isCreate("/accounts"), 500);
    }
    await using run = await followRuns();

    await startProvisioning(env, staff, input);
    await run.waitForStatus("errored");

    expect({
      creates: cloudflare.calls.filter(isCreate("/accounts")).length,
      stops: await detailsOf(clientId, "client.provision_stop"),
    }).toStrictEqual({
      // The first attempt and three retries.
      creates: 4,
      stops: [{ step: "account", error: "cloudflare_500_10000" }],
    });
  });

  it("refuses a client that exists, an account another client has, a release not imported, a console without a domain and an id that can't be a hostname", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();
    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });
    await confirmWorkersPaid(env, staff, clientId);
    await run.waitForStatus("complete");
    const taken = await clientRow(clientId);
    const other = await setUp();

    expect({
      exists: await codeOf(startProvisioning(env, staff, input)),
      account: await codeOf(
        startProvisioning(env, staff, {
          ...other.input,
          accountId: taken?.accountId,
        })
      ),
      release: await codeOf(
        startProvisioning(env, staff, {
          ...other.input,
          releaseId: "r999999-0000000",
        })
      ),
      domain: await codeOf(
        startProvisioning({ ...env, CLIENT_DOMAIN: "" }, staff, other.input)
      ),
      // Active now: nothing to resume.
      resume: await codeOf(retryProvisioning(env, staff, clientId)),
    }).toStrictEqual({
      exists: "client_exists",
      account: "account_taken",
      release: "release_not_imported",
      domain: "domain_not_set",
      resume: "not_provisioning",
    });
    await expect(
      startProvisioning(env, staff, { ...other.input, clientId: "www" })
    ).rejects.toThrow("a reserved name");
  });

  it("counts a run claimed a moment ago that Workflows doesn't have yet as starting, and one claimed long ago as gone", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();
    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });
    // Another start claimed a run and hasn't created it yet.
    const claim = (claimedAt: Date) =>
      db
        .update(clientRuns)
        .set({ runId: `${clientId}-notcreatedyet`, claimedAt })
        .where(eq(clientRuns.clientId, clientId));
    await claim(new Date());
    const starting = await codeOf(retryProvisioning(env, staff, clientId));
    await claim(new Date(Date.now() - startingMs));
    const gone = await codeOf(retryProvisioning(env, staff, clientId));

    expect({ starting, gone }).toStrictEqual({
      starting: "already_running",
      gone: "resolved",
    });
  });

  it("refuses to confirm or resume what isn't being provisioned, or a run still going", async () => {
    const { clientId, input } = await setUp();
    await using run = await followRuns();
    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });

    expect({
      confirm: await codeOf(confirmWorkersPaid(env, staff, "nobody")),
      retry: await codeOf(retryProvisioning(env, staff, "nobody")),
      // Its run is waiting, not failed.
      retryWaiting: await codeOf(retryProvisioning(env, staff, clientId)),
    }).toStrictEqual({
      confirm: "not_provisioning",
      retry: "not_provisioning",
      retryWaiting: "already_running",
    });
  });
});
