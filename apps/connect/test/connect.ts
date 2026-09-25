/**
 * Calls connect the way core does: with a capability core signed for
 * exactly that call. Connections are set up in connect's registry directly,
 * as the flows that create them (OAuth, Composio) would leave them.
 */
import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { capabilityErrors, signCapability } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectResult,
  connectCallSchema,
} from "@grasp-os/shared/connect";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { env, exports } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import type { z } from "zod";

import { connections } from "../src/db/schema.ts";

type ConnectionRow = typeof connections.$inferInsert;

/** The URL of the MCP server behind the test connections. */
export const serverUrl = "https://mcp.composio.test/toolkits/mail";

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

/** An agent acting for `person`. */
export const agentFor = (person: string, agentId = "agent-chat"): Authority =>
  authoritySchema.parse({
    subject: { type: "agent", agentId },
    onBehalfOf: person,
    mode: "interactive",
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
      String(error)
    );
  }
};

/** The audit events connect sends in each test of the file. */
export const auditEvents = (): AuditEvent[] => {
  const events: AuditEvent[] = [];
  beforeEach(() => {
    events.length = 0;
    vi.spyOn(env.AUDIT_QUEUE, "send").mockImplementation(async (event) => {
      events.push(auditEventSchema.parse(event));
      return await Promise.resolve({
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return events;
};
