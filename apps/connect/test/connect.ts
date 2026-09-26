/**
 * Calls connect the way core does: with a capability core signed for
 * exactly that call. Connections are set up in connect's registry directly,
 * as the flows that create them (OAuth, Composio) would leave them.
 */
import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { capabilityErrors, signCapability } from "@grasp-os/shared/capability";
import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  ConnectResult,
  StartConnection,
  connectCallSchema,
} from "@grasp-os/shared/connect";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import { env, exports } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import type { z } from "zod";

import { connections } from "../src/db/schema.ts";
import { acmeDomain, acmeTenant } from "./oauth-provider.ts";
import type { Account, fakeProviders } from "./oauth-provider.ts";

type ConnectionRow = typeof connections.$inferInsert;

/** The URL of the MCP server behind the test connections. */
export const serverUrl =
  "https://backend.composio.dev/v3/mcp/server-mail?user_id=grasp";

/** A shared connection to `serverUrl`, unless `fields` say otherwise. */
export const addConnection = async (
  fields: Partial<ConnectionRow> = {}
): Promise<string> => {
  const id = fields.id ?? `connection-${crypto.randomUUID()}`;
  const now = new Date();
  await drizzle(env.DB)
    .insert(connections)
    .values({
      provider: "mail",
      scope: "shared",
      status: "active",
      serverKind: "composio",
      server: serverUrl,
      createdAt: now,
      updatedAt: now,
      ...fields,
      id,
    });
  return id;
};

/**
 * An agent acting for `person`: in a workflow run unless `mode` says chat
 * (`interactive`), where connect holds no writes yet.
 */
export const agentFor = (
  person: string,
  agentId = "agent-chat",
  mode: Authority["mode"] = "workflow"
): Authority =>
  authoritySchema.parse({
    subject: { type: "agent", agentId },
    onBehalfOf: person,
    mode,
  });

/** An App's workflow acting for `person`. */
export const appFor = (person: string, appId = "app-crm"): Authority =>
  authoritySchema.parse({
    subject: { type: "app", appId },
    onBehalfOf: person,
    mode: "workflow",
  });

/** A call as core states it, with plain string IDs. */
export type Call = Omit<z.input<typeof connectCallSchema>, "capability">;

/** The capability core would sign for `call` by `authority`. */
export const capabilityFor = async (
  authority: Authority,
  call: Call,
  key: string = env.CAPABILITY_SIGNING_KEY,
  now?: number
): Promise<string> => await signCapability(key, authority, call, now);

/** Makes `call` for `authority`, as core does. */
export const callAs = async (
  authority: Authority,
  call: Call
): Promise<ConnectResult> =>
  await exports.default.call({
    ...call,
    capability: await capabilityFor(authority, call),
  });

/** The code connect refused or failed with, or "ok" if it didn't. */
export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (
      capabilityErrors.codeOf(error) ??
      connectErrors.codeOf(error) ??
      connectionErrors.codeOf(error) ??
      roleErrors.codeOf(error) ??
      String(error)
    );
  }
};

/**
 * A new person, as core names them to connect, signed in with Entra: tests
 * share the database, so each one has people, and accounts, of its own.
 */
export const someone = (
  role: ConnectionPerson["role"] = "user"
): ConnectionPerson => {
  const id = crypto.randomUUID();
  return {
    userId: `user-${id}`,
    role,
    staff: false,
    email: `person-${id}@acme.test`,
    accounts: [{ provider: "microsoft", subject: `oid-${id}` }],
  };
};

/**
 * The person's own account at `provider`: the one they sign in with, or,
 * where they sign in elsewhere, the one with their email.
 */
export const ownAccount = (
  person: ConnectionPerson,
  provider: Account["provider"] = "microsoft"
): Account => {
  const signIn = person.accounts.find((each) => each.provider === provider);
  return provider === "microsoft"
    ? {
        provider,
        tenant: acmeTenant,
        subject: signIn?.subject ?? `oid-${person.userId}`,
        email: person.email,
      }
    : {
        provider,
        tenant: acmeDomain,
        subject: signIn?.subject ?? `g-${person.userId}`,
        email: person.email,
      };
};

/** An account nobody signs in with, such as a shared mailbox. */
export const mailboxAccount = (
  provider: Account["provider"] = "microsoft"
): Account => {
  const id = crypto.randomUUID();
  return {
    provider,
    tenant: provider === "microsoft" ? acmeTenant : acmeDomain,
    subject: `mailbox-${id}`,
    email: `mailbox-${id}@acme.test`,
  };
};

/** The client's origin, where the provider sends the browser back. */
export const clientOrigin = "https://acme.grasp.test";

type StartOptions = Partial<Omit<StartConnection, "person">>;

/** Starts connecting, as core does for `person`: the provider URL. */
export const startAs = async (
  person: ConnectionPerson,
  options: StartOptions = {}
): Promise<URL> => {
  const provider = options.provider ?? "microsoft";
  const { url } = await exports.default.startConnection({
    person,
    provider,
    scope: "personal",
    origin: clientOrigin,
    tenant: provider === "microsoft" ? acmeTenant : acmeDomain,
    returnTo: "/connections",
    ...options,
  });
  return new URL(url);
};

/** The state a started flow carries through the browser. */
export const stateOf = (url: URL): string =>
  url.searchParams.get("state") ?? "";

/**
 * Connects an account end to end, as `person`'s browser and core would:
 * start, consent at the provider as `account`, come back with the code.
 */
export const connectAccount = async (
  providers: ReturnType<typeof fakeProviders>,
  person: ConnectionPerson,
  account: Account,
  options: StartOptions = {}
): Promise<string> => {
  const url = await startAs(person, { provider: account.provider, ...options });
  const { connectionId } = await exports.default.finishConnection({
    person,
    state: stateOf(url),
    code: providers.authorize(url.href, account),
  });
  return connectionId;
};

/**
 * The audit queue, as far as connect reaches it: the events it takes in
 * each test of the file, and `refuseNext` to make it refuse the next send.
 */
export const auditEvents = () => {
  const events: AuditEvent[] = [];
  let refuse = false;
  beforeEach(() => {
    events.length = 0;
    refuse = false;
    vi.spyOn(env.AUDIT_QUEUE, "send").mockImplementation(async (event) => {
      if (refuse) {
        refuse = false;
        throw new Error("Queue unavailable");
      }
      events.push(auditEventSchema.parse(event));
      return await Promise.resolve({
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return {
    events,
    refuseNext: () => {
      refuse = true;
    },
  };
};
