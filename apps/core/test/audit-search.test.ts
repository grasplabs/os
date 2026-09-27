import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type {
  AuditExportFormat,
  AuditFilter,
  AuditRecord,
} from "@grasp-os/shared/audit-log";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { chainHash } from "../src/audit-chain.ts";
import { auditLog } from "../src/audit-log.ts";
import { appendStored, exportReader, verifyAll } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  outcome,
  signedInApi,
  signedInWithRole,
  unique,
} from "./sign-in.ts";

// Reading the audit log (threat model section 13, R16): only admins read
// it, every read is itself recorded, and an export holds exactly what a
// search finds, each event with its place in the chain, so the export can
// be checked against the live chain.

const idp = mockIdp();

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

/** An event as connect would send it; the log appends it. */
const event = (entry: Partial<z.input<typeof auditEventSchema>>): AuditEvent =>
  auditEventSchema.parse({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source: "connect",
    actor: { type: "system" },
    action: "connection.call",
    ...entry,
  });

/** Appends events to the deployment's log, as draining an outbox does. */
const logged = async (...events: AuditEvent[]): Promise<AuditEvent[]> => {
  await auditLog(env).append(events);
  return events;
};

const idsOf = (records: readonly AuditRecord[]) =>
  records.map((record) => record.event?.id);

/** Every record a search finds, following its pages. */
const searchAll = async (api: Api, filter: AuditFilter) => {
  const records: AuditRecord[] = [];
  let page = await api.audit.search(filter);
  records.push(...page.records);
  while (page.next !== null) {
    // One page after another, as a client reads them.
    // oxlint-disable-next-line no-await-in-loop
    page = await api.audit.search(filter, page.next);
    records.push(...page.records);
  }
  return records;
};

/** The whole export as text, read from its stream. */
const exported = async (
  api: Api,
  filter: AuditFilter,
  format: AuditExportFormat
): Promise<string> =>
  await new Response(await api.audit.export(filter, format)).text();

const exportSchema = z.object({
  exportedAt: z.iso.datetime(),
  filter: z.record(z.string(), z.unknown()),
  chain: z.object({ seq: z.int(), hash: z.string() }),
  records: z.array(
    z.object({
      seq: z.int(),
      receivedAt: z.string(),
      type: z.string().nullable(),
      version: z.int(),
      prevHash: z.string(),
      hash: z.string(),
      verified: z.boolean(),
      eventJson: z.string(),
    })
  ),
  recordCheck: z.object({
    ok: z.boolean(),
    records: z.int(),
    unverified: z.array(z.int()),
  }),
  lastFullVerification: z.looseObject({ ok: z.boolean() }).nullable(),
});

/** The ID of an exported record's event, read from its stored bytes. */
const exportedId = ({ eventJson }: { eventJson: string }) =>
  auditEventSchema.parse(JSON.parse(eventJson)).id;

/** The live chain's hash at each position the log holds. */
const liveHashes = async (): Promise<Map<number, string>> => {
  const hashes = new Map<number, string>();
  let page = await auditLog(env).entries();
  while (page.length > 0) {
    for (const { seq, hash } of page) {
      hashes.set(seq, hash);
    }
    // oxlint-disable-next-line no-await-in-loop
    page = await auditLog(env).entries(page.at(-1)?.seq);
  }
  return hashes;
};

/** An App's calls on connections, and events around them that don't match. */
const appActivity = async () => {
  const app = `app-${unique()}`;
  const connection = `connection-${unique()}`;
  const onConnection = { type: "connection", id: connection };
  const actor = { type: "app", appId: app, part: "server" } as const;
  const [wrote, read] = await logged(
    event({ actor, target: onConnection, detail: { sideEffect: true } }),
    event({ actor, target: onConnection, detail: { sideEffect: false } })
  );
  await logged(
    // Another App on the same connection, the App on another connection,
    // and a person on the connection.
    event({
      actor: { ...actor, appId: `app-${unique()}` },
      target: onConnection,
    }),
    event({ actor, target: { type: "connection", id: `other-${unique()}` } }),
    event({
      actor: { type: "person", userId: `user-${unique()}` },
      target: onConnection,
    })
  );
  const [ran] = await logged(
    event({
      actor: {
        type: "workflow",
        appId: app,
        workflowId: "follow-up",
        runId: `run-${unique()}`,
      },
      target: onConnection,
      detail: { sideEffect: true },
    })
  );
  return { app, connection, wrote, read, ran };
};

const weekAgo = () =>
  new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

describe("audit log search", () => {
  it("finds every action an App took on a connection last week", async () => {
    const { api } = await signedInApi(idp, "admin");
    const { app, connection, wrote, read, ran } = await appActivity();
    const filter = {
      from: weekAgo(),
      actorId: app,
      targetType: "connection",
      targetId: connection,
    };

    const records = await searchAll(api, filter);
    // Newest first, its workflow runs included.
    expect(idsOf(records)).toStrictEqual([ran?.id, read?.id, wrote?.id]);
    expect(records.every(({ verified }) => verified)).toBeTruthy();
    // Only what changed something at the provider.
    const actions = await searchAll(api, { ...filter, type: "action" });
    expect(idsOf(actions)).toStrictEqual([ran?.id, wrote?.id]);
  });

  it("narrows by time: from included, to not", async () => {
    const { api } = await signedInApi(idp, "admin");
    const targetId = `document-${unique()}`;
    const [before] = await logged(
      event({ target: { type: "doc", id: targetId } })
    );
    // The log's clock moves on with I/O.
    await scheduler.wait(5);
    const [after] = await logged(
      event({ target: { type: "doc", id: targetId } })
    );
    // Newest first: the second event, then the first.
    const [second] = await searchAll(api, { targetId });
    const at = second?.receivedAt;

    const from = await searchAll(api, { targetId, from: at });
    expect(idsOf(from)).toStrictEqual([after?.id]);
    const to = await searchAll(api, { targetId, to: at });
    expect(idsOf(to)).toStrictEqual([before?.id]);
  });

  it("narrows by action prefix, actor type and resource", async () => {
    const { api } = await signedInApi(idp, "admin");
    const resource = `item-${unique()}`;
    const staff = { type: "staff", userId: `staff-${unique()}` } as const;
    const [call, continued, read] = await logged(
      event({ provenance: [resource] }),
      event({ action: "connection.call.provenance", provenance: [resource] }),
      event({
        actor: staff,
        action: "knowledge.document.read",
        detail: { resource },
      })
    );
    const found = async (filter: AuditFilter) =>
      new Set(idsOf(await searchAll(api, { resource, ...filter })));

    await expect(found({ action: "connection.call" })).resolves.toStrictEqual(
      new Set([call?.id, continued?.id])
    );
    // A prefix is whole segments only.
    await expect(found({ action: "connection.cal" })).resolves.toStrictEqual(
      new Set()
    );
    await expect(found({ actorType: "staff" })).resolves.toStrictEqual(
      new Set([read?.id])
    );
    await expect(found({})).resolves.toHaveProperty("size", 3);
  });

  it("pages newest first, each record once", async () => {
    const { api } = await signedInApi(idp, "admin");
    const targetId = `many-${unique()}`;
    const events = await logged(
      ...Array.from({ length: 105 }, () =>
        event({ target: { type: "thing", id: targetId } })
      )
    );
    const first = await api.audit.search({ targetId });
    expect(first.records).toHaveLength(100);
    expect(first.next).not.toBeNull();

    const all = await searchAll(api, { targetId });
    expect(idsOf(all)).toStrictEqual(events.map(({ id }) => id).toReversed());
  });

  it("refuses a filter it doesn't know", async () => {
    const { api } = await signedInApi(idp, "admin");
    const refused = await Promise.all(
      [
        { actor: "someone" },
        { from: "last week" },
        { action: "Connection" },
        { targetId: "x".repeat(257) },
      ].map(async (filter) => await outcome(api.audit.search(filter)))
    );
    expect(refused).toStrictEqual(
      Array.from({ length: 4 }, () => "audit.invalid")
    );
    await expect(outcome(api.audit.search({}, -1))).resolves.toBe(
      "audit.invalid"
    );
    await expect(
      // @ts-expect-error -- a format there is none of
      outcome(api.audit.export({}, "xml"))
    ).resolves.toBe("audit.invalid");
  });
});

describe("audit log export", () => {
  it("exports what the search found, and verifies against the live chain", async () => {
    const { api } = await signedInApi(idp, "admin");
    const { app, connection, wrote, read, ran } = await appActivity();
    const filter = { actorId: app, targetId: connection, from: weekAgo() };

    const document = exportSchema.parse(
      JSON.parse(await exported(api, filter, "json"))
    );
    expect(document.records.map(exportedId)).toStrictEqual([
      wrote?.id,
      read?.id,
      ran?.id,
    ]);
    expect(document.recordCheck).toStrictEqual({
      ok: true,
      records: 3,
      unverified: [],
    });
    // Each record's hash is what its own fields hash to, its event taken
    // byte for byte as exported, and what the live chain holds there.
    const live = await liveHashes();
    for (const { eventJson, ...record } of document.records) {
      // oxlint-disable-next-line no-await-in-loop
      const hash = await chainHash({ ...record, event: eventJson });
      expect(hash).toBe(record.hash);
      expect(live.get(record.seq)).toBe(record.hash);
    }
  });

  it("exports events as they were stored, whatever today's schema adds", async () => {
    const { api } = await signedInApi(idp, "admin");
    const targetId = `older-${unique()}`;
    // As a release before `provenance` and `detail` had defaults stored it.
    const {
      provenance: _p,
      detail: _d,
      ...older
    } = event({
      target: { type: "doc", id: targetId },
    });
    const stored = canonicalJson(older);
    await appendStored(auditLog(env), stored, older.id);

    const document = exportSchema.parse(
      JSON.parse(await exported(api, { targetId }, "json"))
    );
    expect(document.records).toMatchObject([
      { eventJson: stored, verified: true },
    ]);
  });

  it("reports the last full verification with the export", async () => {
    const { api } = await signedInApi(idp, "admin");
    await expect(verifyAll(api)).resolves.toMatchObject({ ok: true });
    const document = exportSchema.parse(
      JSON.parse(await exported(api, { targetId: `none-${unique()}` }, "json"))
    );
    expect(document.lastFullVerification).toMatchObject({ ok: true });
  });

  it("exports an empty result as a document with no records", async () => {
    const { api } = await signedInApi(idp, "admin");
    const document = exportSchema.parse(
      JSON.parse(await exported(api, { targetId: `none-${unique()}` }, "json"))
    );
    expect(document.records).toStrictEqual([]);
    expect(document.recordCheck.ok).toBeTruthy();
  });

  it("stops an export once its reader is no longer an admin", async () => {
    const { session, userId } = await signedInWithRole(idp, "admin");
    const targetId = `demoted-${unique()}`;
    await logged(event({ target: { type: "doc", id: targetId } }));
    const reader = await exportReader(session, { targetId });
    // The header: the export has begun.
    await reader.read();

    await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
      .bind(userId)
      .run();
    await expect(outcome(reader.read())).resolves.toBe("role.forbidden");
  });

  it("exports CSV that a spreadsheet opens as data", async () => {
    const { api } = await signedInApi(idp, "admin");
    const targetId = `=HYPERLINK("x",${unique()})`;
    const sent = event({
      // An ID can start with a space, which a spreadsheet skips.
      actor: { type: "person", userId: ` =HYPERLINK("y")` },
      target: { type: "doc", id: targetId },
    });
    await logged(sent);

    const csv = await exported(api, { targetId }, "csv");
    const [header, row, rest] = csv.split("\r\n");
    expect(header).toBe(
      "seq,received_at,at,type,action,actor_type,actor_id,target_type,target_id,source,request_id,verified,version,prev_hash,hash,event"
    );
    expect(rest).toBe("");
    // A formula becomes text, also after a space, and its comma and quotes
    // stay in one cell.
    expect(row).toContain(
      `,person,"' =HYPERLINK(""y"")",doc,"'=HYPERLINK(""x"",`
    );
    expect(row).toContain(",true,1,");
    // The last cell is the event as it was hashed.
    expect(
      row?.endsWith(`"${canonicalJson(sent).replaceAll('"', '""')}"`)
    ).toBeTruthy();
  });
});

describe("audit log access", () => {
  it("is for admins only", async () => {
    const refusals = async (role: Role) => {
      const { api } = await signedInApi(idp, role);
      return await Promise.all([
        outcome(api.audit.search()),
        outcome(api.audit.export({}, "json")),
        outcome(api.audit.verify()),
      ]);
    };
    for (const role of ["builder", "user"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await expect(refusals(role)).resolves.toStrictEqual([
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
      ]);
    }
  });

  it("records every read in the log itself", async () => {
    const { api, userId } = await signedInApi(idp, "admin");
    const targetId = `watched-${unique()}`;
    const actor = { type: "person", userId };

    await expect(
      auditedDuring(async () => await api.audit.search({ targetId }))
    ).resolves.toMatchObject([
      {
        actor,
        action: "audit.searched",
        detail: { "filter.targetId": targetId, records: 0 },
      },
    ]);
    // A later page that finds nothing isn't recorded again.
    await expect(
      auditedDuring(async () => await api.audit.search({ targetId }, 1))
    ).resolves.toStrictEqual([]);
    await expect(
      auditedDuring(async () => await exported(api, { targetId }, "csv"))
    ).resolves.toMatchObject([
      {
        actor,
        action: "audit.exported",
        detail: { "filter.targetId": targetId, format: "csv" },
      },
    ]);
    await expect(
      auditedDuring(async () => await api.audit.verify())
    ).resolves.toMatchObject([
      { actor, action: "audit.verified", detail: { after: 0, ok: true } },
    ]);
  });
});
