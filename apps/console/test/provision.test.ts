import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { asc, eq, sql } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clientDeploys, clients } from "../src/db/schema.ts";
import {
  confirmWorkersPaid,
  retryProvisioning,
  startProvisioning,
} from "../src/provision/control.ts";
import type { ProvisionInput } from "../src/provision/control.ts";
import { accountName } from "../src/provision/workflow.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";

const token = "test-deployer-token-provision-7f3a9c";
const cloudflare = mockCloudflareApi(token);
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

/** The run of `clientId`, as the test pool lets a test follow it. */
const follow = async (clientId: string) => {
  const run = await introspectWorkflowInstance(env.PROVISION_CLIENT, clientId);
  // Retries go at once: the fake answers at once.
  await run.modify(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  return run;
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

  it("creates its account, waits for Workers Paid, then deploys the release and activates it, audited", async () => {
    const { clientId, input } = await setUp();
    await using run = await follow(clientId);

    await startProvisioning(env, staff, input);
    await run.waitForStepResult({ name: "client" });
    // Waiting for staff: nothing is deployed before they confirm.
    const accounts = cloudflare.accountsNamed(accountName(clientId));
    const [account] = accounts;
    expect({
      accounts: accounts.length,
      databases: account?.d1.length,
      deploys: await deploysOf(clientId),
    }).toStrictEqual({ accounts: 1, databases: 0, deploys: [] });

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

  it("adopts an account by its id, creating none", async () => {
    const account = cloudflare.addAccount("Acme's own");
    const { clientId, input } = await setUp({ accountId: account.id });
    await using run = await follow(clientId);

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

  it("resumes steps whose creates went through with their answers lost, making each thing once, and keeps the token out of the database and logs", async () => {
    const { clientId, input } = await setUp();
    await using run = await follow(clientId);
    // The account's create and a database's go through, and their answers
    // never arrive: each step fails and runs again.
    cloudflare.failNext(isCreate("/accounts"), "lost");
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
      databases: sortedNames(accounts[0]?.d1),
      // The deploy step failed once and ran again: its failure was logged.
      failureLogged: logs.includes("deploy.failed"),
    }).toStrictEqual({
      accounts: 1,
      databases: ["grasp-os-connect", "grasp-os-core", "grasp-os-knowledge"],
      failureLogged: true,
    });
    const rows = await everyRow();
    expect({
      logs: logs.includes(token),
      rows: rows.includes(token),
      output: JSON.stringify(await run.getOutput()).includes(token),
    }).toStrictEqual({ logs: false, rows: false, output: false });
  });

  it("resumes a run that failed at its last step from its deploy: nothing made twice, Workers Paid not asked again", async () => {
    const { clientId, input } = await setUp();
    await using run = await follow(clientId);
    // Another client's entry holds the hostname until staff clear it.
    const hostname = `${clientId}.${domain}`;
    await env.ROUTER_HOSTS.put(
      hostname,
      JSON.stringify({
        clientId: "someone-else",
        coreUrl: "https://grasp-os-core.elsewhere.workers.dev",
        generation: 1,
      })
    );

    await logsOf(async () => {
      await startProvisioning(env, staff, input);
      await run.waitForStepResult({ name: "client" });
      await confirmWorkersPaid(env, staff, clientId);
      await run.waitForStatus("errored");
    });
    expect({
      deploys: await deploysOf(clientId),
      client: await clientRow(clientId),
    }).toMatchObject({
      deploys: [{ status: "failed", error: "hostname_taken" }],
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
      retried: trail.includes("client.provision_retry"),
      client: await clientRow(clientId),
    }).toMatchObject({
      databases: 3,
      buckets: 2,
      versions: [1, 1],
      deploys: [{ status: "done", error: null }],
      confirmations: 1,
      retried: true,
      client: { status: "active" },
    });
  });

  it("lets staff start again with another account when the run couldn't read the first", async () => {
    const { clientId, input } = await setUp({
      // An account the deployer isn't a member of.
      accountId: "0".repeat(32),
    });
    await using run = await follow(clientId);

    await startProvisioning(env, staff, input);
    await run.waitForStatus("errored");
    const before = await clientRow(clientId);

    const account = cloudflare.addAccount("Acme");
    await using again = await follow(clientId);
    await startProvisioning(env, staff, { ...input, accountId: account.id });
    await again.waitForStepResult({ name: "client" });

    expect({ before, after: await clientRow(clientId) }).toMatchObject({
      before: undefined,
      after: { accountId: account.id },
    });
  });

  it("starts one run for a client however many starts race, and refuses another while it goes on", async () => {
    const { clientId, input } = await setUp();
    await using run = await follow(clientId);

    // Both may pass the checks; the instance id is the client's, so there's
    // one run whichever creates it (Workflows refuses the second create,
    // the test pool ignores it).
    await Promise.allSettled([
      startProvisioning(env, staff, input),
      startProvisioning(env, staff, input),
    ]);
    await run.waitForStepResult({ name: "client" });

    const trail = await actions(clientId);
    expect({
      accounts: cloudflare.accountsNamed(accountName(clientId)).length,
      records: trail.filter((action) => action === "client.create").length,
      again: await codeOf(startProvisioning(env, staff, input)),
    }).toStrictEqual({ accounts: 1, records: 1, again: "already_running" });
  });

  it("refuses a client that exists, an account another client has, a release not imported, a console without a domain and an id that can't be a hostname", async () => {
    const { clientId, input } = await setUp();
    await using run = await follow(clientId);
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
    }).toStrictEqual({
      exists: "client_exists",
      account: "account_taken",
      release: "release_not_imported",
      domain: "domain_not_set",
    });
    await expect(
      startProvisioning(env, staff, { ...other.input, clientId: "www" })
    ).rejects.toThrow("a reserved name");
  });

  it("refuses to confirm or resume what isn't being provisioned", async () => {
    const { clientId, input } = await setUp();
    await using run = await follow(clientId);
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
      retryWaiting: "not_provisioning",
    });
  });
});
