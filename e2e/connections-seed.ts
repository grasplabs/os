/**
 * Connections for end-to-end tests. Connecting one goes to Microsoft or
 * Composio, which a local stack can't reach, and its dev server can't point
 * connect's calls out at a fake, so this writes what a finished connection
 * leaves behind straight into connect's local database: the connection
 * rows only, with no tokens, which nothing here uses. The flows themselves,
 * through a fake Entra and Composio, are core's tests
 * (apps/core/test/connections.test.ts). Written up front in one write, once
 * for each attempt a test may get, before any test runs; tests only look
 * theirs up.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { test } from "@playwright/test";

import type { Cast } from "./people.ts";

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * How often `execute` tries a write the database was too busy for (the dev
 * server shares the file), waiting 200 ms first and twice as long each time
 * after: 3 s at most in all.
 */
const busyAttempts = 5;
const firstBusyWaitMs = 200;

/**
 * What wrangler prints when another connection held the file: SQLite's
 * SQLITE_BUSY, or workerd's opaque "internal error; reference = …" when
 * the batch fails under the same contention. Any other error, a constraint
 * failing say, fails the run.
 */
const busyErrors = ["SQLITE_BUSY", "internal error; reference ="];

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  "stderr" in error &&
  busyErrors.some((text) => String(error.stderr).includes(text));

/**
 * Runs SQL on connect's local database, which the dev server keeps next to
 * core's (apps/core/package.json), as one batch in one transaction, which
 * SQLite undoes whole when it can't finish: so a busy batch is tried again.
 */
const execute = async (sql: string): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync(
        path.join(import.meta.dirname, "../node_modules/.bin/wrangler"),
        [
          "d1",
          "execute",
          "DB",
          "--local",
          "-c",
          "../connect/wrangler.jsonc",
          "--persist-to",
          ".wrangler/state",
          "--command",
          sql,
        ],
        {
          cwd: path.join(import.meta.dirname, "../apps/core"),
          stdio: "pipe",
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        }
      );
      return;
    } catch (error) {
      if (attempt >= busyAttempts || !isBusy(error)) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- one try at a time
    await sleep(firstBusyWaitMs * 2 ** (attempt - 1));
  }
};

export interface SeededConnection {
  id: string;
  /** Its account at the provider, unique to the attempt. */
  account: string;
}

/** The connections scene's connections (e2e/people.ts), for one attempt. */
export interface SeededConnections {
  /** The user's own Microsoft 365 account, active. */
  mine: SeededConnection;
  /** Another account of theirs, whose access ran out (`needs_reauth`). */
  expired: SeededConnection;
  /** A shared Microsoft 365 mailbox, which the admin connected. */
  mailbox: SeededConnection;
  /** A Composio toolkit, HubSpot, which the admin connected with consent. */
  toolkit: SeededConnection;
}

/** The tools the admin allowed on the seeded toolkit. */
export const seededTools = ["HUBSPOT_LIST_CONTACTS"];

/** How `seedConnections` hands the connections to the test workers. */
const seededVariable = "E2E_CONNECTIONS";

/** A value for SQL: quoted, or NULL. */
const value = (text: string | null): string =>
  text === null ? "NULL" : quoted(text);

interface Row {
  connection: SeededConnection;
  provider: string;
  scope: "personal" | "shared";
  owner: string | null;
  status: "active" | "needs_reauth";
  connectedBy: string;
}

/** A finished connection's row, as connect writes it. */
const insert = (
  { connection, provider, scope, owner, status, connectedBy }: Row,
  now: number
): string => {
  const composio = provider === "hubspot";
  const server = composio
    ? `https://backend.composio.dev/v3/mcp/${connection.id}?user_id=e2e`
    : "microsoft-365";
  return `INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, account_id, account_name, connected_by, tools, created_at, updated_at) VALUES (${[
    quoted(connection.id),
    quoted(provider),
    quoted(scope),
    value(owner),
    quoted(status),
    quoted(composio ? "composio" : "native"),
    quoted(server),
    quoted(`account-${connection.id}`),
    quoted(connection.account),
    quoted(connectedBy),
    value(composio ? JSON.stringify(seededTools) : null),
    String(now),
    String(now),
  ].join(", ")})`;
};

/** A new connection's ID, with its account. */
const newConnection = (account: string): SeededConnection => ({
  id: crypto.randomUUID(),
  account,
});

/**
 * Writes the connections scene's connections for every attempt in `cast`,
 * in one write. The global setup (e2e/setup.ts) runs it right after it
 * signs everyone in.
 */
export const seedConnections = async (cast: Cast): Promise<void> => {
  const now = Date.now();
  const written = cast.map((scenes) => {
    const admin = scenes.connections?.admin;
    const user = scenes.connections?.user;
    if (admin === undefined || user === undefined) {
      throw new Error("Nobody is signed in for the connections scene");
    }
    // Accounts are unique to an attempt, so each finds its own.
    const tag = crypto.randomUUID().slice(0, 8);
    const connections: SeededConnections = {
      mine: newConnection(`mine-${tag}@acme.test`),
      expired: newConnection(`expired-${tag}@acme.test`),
      mailbox: newConnection(`mailbox-${tag}@acme.test`),
      toolkit: newConnection(`hubspot-${tag}`),
    };
    const personal = {
      provider: "microsoft",
      scope: "personal",
      owner: user.userId,
      connectedBy: user.userId,
    } as const;
    const shared = {
      scope: "shared",
      owner: null,
      status: "active",
      connectedBy: admin.userId,
    } as const;
    const rows: Row[] = [
      { ...personal, connection: connections.mine, status: "active" },
      { ...personal, connection: connections.expired, status: "needs_reauth" },
      { ...shared, connection: connections.mailbox, provider: "microsoft" },
      { ...shared, connection: connections.toolkit, provider: "hubspot" },
    ];
    return { connections, rows };
  });
  await execute(
    written
      .flatMap(({ rows }) => rows.map((row) => insert(row, now)))
      .join("; ")
  );
  // Playwright hands the global setup's environment to the test workers.
  process.env[seededVariable] = JSON.stringify(
    written.map(({ connections }) => connections)
  );
};

/** The connections scene's connections, for this attempt at the test. */
export const seededConnections = (): SeededConnections => {
  const json = process.env[seededVariable];
  if (json === undefined) {
    throw new Error(
      `${seededVariable} is unset: the global setup in playwright.config.ts writes the connections`
    );
  }
  // SAFETY: seedConnections wrote it, one for each attempt.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const seeded = (JSON.parse(json) as SeededConnections[])[test.info().retry];
  if (seeded === undefined) {
    throw new Error(`No connections for attempt ${test.info().retry + 1}`);
  }
  return seeded;
};
