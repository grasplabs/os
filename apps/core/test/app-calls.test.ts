import { appCallLimits } from "@grasp-os/shared/apps";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { AppId } from "@grasp-os/shared/ids";
import { appIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callExport } from "../src/app-calls.ts";
import { callApp } from "../src/app.ts";
import { appHost } from "../src/durable-objects.ts";
import { release, requestGranted, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam, readCollection } from "./knowledge.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { finished } from "./runs.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// Calls between Apps: one App calls the methods another exports, under a
// permission an admin granted it. These tests start from the ways that
// can fail: a call without a grant, from code no admin approved, or past
// what the grant allows (a write on a read grant, an export that isn't
// one, or is gone); a chain of calls that writes from a read, comes back
// round, or never ends; input or answers that aren't what the export says,
// or too large; restricted data or provenance that doesn't follow the data
// from one App to the other; and a call either side's audit log misses.
// Every App here runs for real, in its own sandbox.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * One App's server code, for every App in these tests: exports to call,
 * and `via`, which the tests call as a screen would, to call another App
 * through the stub `binding`. Answers what a refusal's code was.
 */
const server = `import { DurableObject } from "cloudflare:workers";

type Caller = {
  userId: string;
  token: string;
  idempotencyKey?: string;
  app?: { id: string; version: number };
};

const tried = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { ok: await call() };
  } catch (error) {
    return { refused: (error as { code?: string }).code ?? "unknown" };
  }
};

export class App extends DurableObject {
  async via(caller: Caller, binding: string, method: string, input: unknown, as?: unknown): Promise<unknown> {
    const stub = (this.env as Record<string, any>)[binding];
    if (!stub) {
      return "no binding";
    }
    return await tried(async () => await stub.call(as ?? caller, method, input));
  }

  findCustomers(caller: Caller, input: { query: string }): unknown[] {
    return [{ name: "Acme " + input.query, for: caller.userId, from: caller.app ?? null, key: caller.idempotencyKey ?? null }];
  }

  addCustomer(_caller: Caller, input: { name: string }): boolean {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS customers (name TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO customers VALUES (?)", input.name);
    return true;
  }

  wrongAnswer(): string {
    return "not a list";
  }

  hugeAnswer(): string[] {
    return ["x".repeat(${appCallLimits.answerBytes})];
  }

  async relay(caller: Caller, input: { binding: string; method: string; input: unknown }): Promise<unknown> {
    return await this.via(caller, input.binding, input.method, input.input);
  }

  async relayWrite(caller: Caller, input: { binding: string; method: string; input: unknown }): Promise<unknown> {
    return await this.via(caller, input.binding, input.method, input.input);
  }

  async remember(_caller: Caller, value: unknown): Promise<boolean> {
    await this.ctx.storage.put("remembered", value);
    return true;
  }

  async remembered(): Promise<unknown> {
    return (await this.ctx.storage.get("remembered")) ?? null;
  }

  customerCount(): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS customers (name TEXT)");
    const [row] = this.ctx.storage.sql.exec("SELECT count(*) AS count FROM customers").toArray();
    return Number(row?.count ?? 0);
  }

  async failAfterPayroll(caller: Caller, input: { documentId: string }): Promise<never> {
    await this.readPayroll(caller, input);
    throw new Error("Payroll says 42");
  }

  async readPayroll(caller: Caller, input: { documentId: string }): Promise<boolean> {
    const { provenance } = await (this.env as Record<string, any>).PAYROLL.getDocument(caller, input.documentId);
    return provenance.restricted;
  }
}
`;

const anyObject = { type: "object" };
const relayInput = {
  type: "object",
  properties: {
    binding: { type: "string" },
    method: { type: "string" },
    input: {},
  },
  required: ["binding", "method"],
};

/** What every App here exports. */
const exported = {
  findCustomers: {
    access: "read",
    input: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    output: { type: "array", items: {} },
  },
  addCustomer: {
    access: "write",
    input: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    output: { type: "boolean" },
  },
  wrongAnswer: {
    access: "read",
    input: anyObject,
    output: { type: "array", items: {} },
  },
  hugeAnswer: {
    access: "read",
    input: anyObject,
    output: { type: "array", items: {} },
  },
  relay: { access: "read", input: relayInput, output: {} },
  relayWrite: { access: "write", input: relayInput, output: {} },
  readPayroll: { access: "read", input: anyObject, output: {} },
  failAfterPayroll: { access: "read", input: anyObject, output: {} },
};

/** The files of an App here, exporting `exports`. */
const appFiles = (exports: object = exported): Record<string, string> => ({
  "app/server.ts": server,
  "app/exports.json": JSON.stringify(exports),
});

/** A new App of `owner`'s, released and built. */
const newApp = async (
  owner: Person,
  name: string,
  files = appFiles()
): Promise<AppId> => {
  const { id } = await owner.api.apps.create({ name: `${name} ${unique()}` });
  await serverBuilt(id, await release(owner, id, files));
  return appIdSchema.parse(id);
};

/** Grants `caller` `actions` on `called`'s exports, under `binding`. */
const grantCalls = async (
  admin: Person,
  caller: AppId,
  called: AppId,
  actions: string[],
  binding: string
): Promise<string> =>
  await requestGranted(idp, admin, {
    subject: { type: "app", appId: caller },
    object: { type: "app", appId: called },
    actions,
    binding,
  });

/** Calls `app`'s `via` for `userId`, as a screen would. */
const via = async (
  app: AppId,
  userId: string,
  binding: string,
  method: string,
  input: unknown
): Promise<unknown> =>
  await callApp(env, app, { userId, mode: "interactive" }, "via", [
    binding,
    method,
    input,
  ]);

/** A relay's input: through `hops` more Apps, each by NEXT, then `last`. */
const relayed = (
  hops: number,
  last: { binding: string; method: string; input: unknown }
): unknown =>
  hops === 0
    ? last
    : { binding: "NEXT", method: "relay", input: relayed(hops - 1, last) };

/** The query that reads an App's current exports (app-calls.ts). */
const exportsRead = /"app_versions"\."exports"/u;

/**
 * Core's database, with `then` run once, just after the first read of an
 * App's exports answered: another change landing between a call's check
 * and its call.
 */
const afterExportsRead = (then: () => Promise<unknown>): D1Database => {
  let ran = false;
  const once = async (): Promise<void> => {
    if (!ran) {
      ran = true;
      await then();
    }
  };
  /** A bound statement whose answers run `once` after they come. */
  const answering = (bound: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(bound, {
      get: (target, key): unknown => {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        const answers = key === "raw" || key === "all" || key === "first";
        return async (...args: unknown[]): Promise<unknown> => {
          const answer: unknown = await Reflect.apply(value, target, args);
          if (answers) {
            await once();
          }
          return answer;
        };
      },
    });
  return new Proxy(env.DB, {
    get: (target, key): unknown => {
      if (key !== "prepare") {
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (query: string): D1PreparedStatement => {
        const statement = target.prepare(query);
        if (!exportsRead.test(query)) {
          return statement;
        }
        return new Proxy(statement, {
          get: (inner, innerKey): unknown => {
            if (innerKey === "bind") {
              return (...values: unknown[]) => answering(inner.bind(...values));
            }
            const value: unknown = Reflect.get(inner, innerKey);
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      };
    },
  });
};

/** Whether `app` has read restricted data, or been sent it. */
const restricted = async (app: AppId): Promise<boolean> =>
  await appHost(env, app).isRestricted();

/**
 * A query of calls between Apps: an App's exports, or permissions by
 * their object's type (on an App's exports, from either end).
 */
const callQuery =
  /"app_versions"\."exports"|"permissions"\."object_type" = \?/u;

/** The calls between Apps an audit batch recorded. */
const callsIn = (events: AuditEvent[]) =>
  events
    .filter(({ action }) => action === "app.call" || action === "app.called")
    .map(({ actor, action, target, detail }) => ({
      actor,
      action,
      target,
      detail,
    }));

/**
 * An admin, the invoicing App that calls, the CRM it calls, and someone
 * who uses the invoicing App and has no role in the CRM.
 */
const setUp = async () => {
  const admin = await personApi("admin");
  const clerk = await personApi("user");
  const [invoicing, crm] = await Promise.all([
    newApp(admin, "Invoicing"),
    newApp(admin, "CRM"),
  ]);
  await admin.api.apps.members.add(invoicing, {
    type: "person",
    id: clerk.userId,
    role: "user",
  });
  return { admin, clerk, invoicing, crm };
};

describe("calls between Apps", { timeout: 60_000 }, () => {
  it("reach another App's export once an admin grants it, as the calling App, for its person", async () => {
    const { admin, clerk, invoicing, crm } = await setUp();
    const find = async () =>
      await via(invoicing, clerk.userId, "CRM", "findCustomers", {
        query: "BV",
      });

    const before = await find();
    const { id } = await admin.api.permissions.request({
      subject: { type: "app", appId: invoicing },
      object: { type: "app", appId: crm },
      actions: ["read"],
      binding: "CRM",
    });
    const requested = await find();
    await admin.api.permissions.grant(id, { version: 1 });
    const events = await auditedDuring(async () => {
      await expect(find()).resolves.toStrictEqual({
        ok: [
          {
            name: "Acme BV",
            // For the clerk, who has no role in the CRM, from the
            // invoicing App's version 1.
            for: clerk.userId,
            from: { id: invoicing, version: 1 },
            key: null,
          },
        ],
      });
    });

    const detail = {
      method: "findCustomers",
      person: clerk.userId,
      depth: 1,
      access: "read",
    };
    expect({ before, requested, calls: callsIn(events) }).toStrictEqual({
      before: "no binding",
      requested: "no binding",
      calls: [
        {
          actor: { type: "app", appId: invoicing, part: "server" },
          action: "app.call",
          target: { type: "app", id: crm },
          detail: {
            ...detail,
            version: 1,
            calledVersion: 1,
            outcome: "called",
          },
        },
        {
          actor: { type: "app", appId: crm, part: "server" },
          action: "app.called",
          target: { type: "app", id: invoicing },
          detail: { ...detail, version: 1, callerVersion: 1 },
        },
      ],
    });
  });

  it("allow only what the grant allows, and say why they refuse", async () => {
    const { admin, clerk, invoicing, crm } = await setUp();
    const permission = await grantCalls(admin, invoicing, crm, ["read"], "CRM");
    const call = async (method: string, input: unknown = {}) =>
      await via(invoicing, clerk.userId, "CRM", method, input);

    const events = await auditedDuring(async () => {
      await expect(
        Promise.all([
          // A write on a read grant.
          call("addCustomer", { name: "Globex" }),
          // A method of the CRM's code it doesn't export, and none at all.
          call("via", {}),
          call("nothing"),
          // A name no method has, which the log names as such.
          call("find customers!"),
          // Input that isn't what the export takes, or too large.
          call("findCustomers", { query: 7 }),
          call("findCustomers", {
            query: "x".repeat(appCallLimits.inputBytes),
          }),
          // Answers that aren't what it says, or too large.
          call("wrongAnswer"),
          call("hugeAnswer"),
        ])
      ).resolves.toStrictEqual([
        { refused: "permission.denied" },
        { refused: "app.export_not_found" },
        { refused: "app.export_not_found" },
        { refused: "app.export_not_found" },
        { refused: "app.call_invalid" },
        { refused: "app.call_too_large" },
        { refused: "app.answer_invalid" },
        { refused: "app.call_too_large" },
      ]);
    });
    // Each refused before the CRM saw it is recorded by the caller alone,
    // with why; an answer refused came from a call both sides recorded.
    const refusals = callsIn(events)
      .filter(({ detail }) => detail.outcome === "refused")
      .map(({ detail }) => `${String(detail.method)} ${String(detail.reason)}`)
      .toSorted();
    expect(refusals).toStrictEqual([
      "(not a method) app.export_not_found",
      "addCustomer permission.denied",
      "findCustomers app.call_invalid",
      "findCustomers app.call_too_large",
      "nothing app.export_not_found",
      "via app.export_not_found",
    ]);

    // The calling App names nobody: a caller not of a call it runs now is
    // refused, as for its connections, and recorded by the App.
    let forged: unknown;
    const forgedEvents = await auditedDuring(async () => {
      forged = await callApp(
        env,
        invoicing,
        { userId: clerk.userId, mode: "interactive" },
        "via",
        [
          "CRM",
          "findCustomers",
          { query: "BV" },
          { userId: clerk.userId, token: crypto.randomUUID() },
        ]
      );
    });
    expect({ forged, recorded: callsIn(forgedEvents) }).toStrictEqual({
      forged: { refused: "app.caller_invalid" },
      recorded: [
        {
          actor: { type: "app", appId: invoicing, part: "server" },
          action: "app.call",
          target: { type: "app", id: crm },
          detail: {
            method: "findCustomers",
            version: null,
            person: null,
            depth: null,
            outcome: "refused",
            reason: "app.caller_invalid",
          },
        },
      ],
    });

    await admin.api.permissions.revoke(permission);
    await expect(call("findCustomers", { query: "BV" })).resolves.toBe(
      "no binding"
    );
  });

  it("allow an export by name, and a write only from code an admin approved", async () => {
    const { admin, clerk, invoicing, crm } = await setUp();
    await grantCalls(admin, invoicing, crm, ["findCustomers"], "BY_NAME");
    await grantCalls(admin, invoicing, crm, ["read", "write"], "CRM");
    const call = async (binding: string, method: string, input: unknown) =>
      await via(invoicing, clerk.userId, binding, method, input);

    const byName = await Promise.all([
      call("BY_NAME", "findCustomers", { query: "BV" }),
      call("BY_NAME", "wrongAnswer", {}),
    ]);
    const approved = await call("CRM", "addCustomer", { name: "Globex" });
    // The version runs without an admin's approval, as when someone who
    // couldn't grant made it current: its grants aren't asked for again
    // here, so only the approval stands in the way.
    await env.DB.prepare(
      "UPDATE app_versions SET approved = 0 WHERE app_id = ?"
    )
      .bind(invoicing)
      .run();
    const unapproved = await Promise.all([
      call("CRM", "addCustomer", { name: "Initech" }),
      call("CRM", "findCustomers", { query: "BV" }),
    ]);

    expect({ byName, approved, unapproved }).toMatchObject({
      byName: [{ ok: [{ name: "Acme BV" }] }, { refused: "permission.denied" }],
      approved: { ok: true },
      unapproved: [{ refused: "permission.denied" }, { ok: [{}] }],
    });
  });

  it("say an export is gone once the called App's version no longer has it", async () => {
    const { admin, clerk, invoicing, crm } = await setUp();
    await grantCalls(admin, invoicing, crm, ["read", "write"], "CRM");
    const add = async () =>
      await via(invoicing, clerk.userId, "CRM", "addCustomer", {
        name: "Globex",
      });
    const before = await add();
    const rest = Object.fromEntries(
      Object.entries(exported).filter(([name]) => name !== "addCustomer")
    );
    await serverBuilt(crm, await release(admin, crm, appFiles(rest)));
    expect({ before, after: await add() }).toStrictEqual({
      before: { ok: true },
      after: { refused: "app.export_not_found" },
    });
  });

  it("go on down a chain, reading only from a read, and never round or too deep", async () => {
    const admin = await personApi("admin");
    const [a, b, c, d, e] = await Promise.all([
      newApp(admin, "A"),
      newApp(admin, "B"),
      newApp(admin, "C"),
      newApp(admin, "D"),
      newApp(admin, "E"),
    ]);
    await grantCalls(admin, a, b, ["read", "write"], "NEXT");
    await grantCalls(admin, b, c, ["read", "write"], "NEXT");
    await grantCalls(admin, c, d, ["read"], "NEXT");
    await grantCalls(admin, d, e, ["read"], "NEXT");
    await grantCalls(admin, c, a, ["read"], "BACK");
    const find = { method: "findCustomers", input: { query: "BV" } };

    const [twoDeep, backRound, tooDeep, writeFromRead, writeFromWrite] =
      await Promise.all([
        // A, B, C: C's answer names B as its caller.
        via(a, admin.userId, "NEXT", "relay", {
          binding: "NEXT",
          ...find,
        }),
        // A, B, C, back to A.
        via(
          a,
          admin.userId,
          "NEXT",
          "relay",
          relayed(1, { binding: "BACK", ...find })
        ),
        // A, B, C, D, E: four calls deep.
        via(
          a,
          admin.userId,
          "NEXT",
          "relay",
          relayed(2, { binding: "NEXT", ...find })
        ),
        // B writes C from a call of its export marked `read`, and then
        // from one marked `write`.
        via(a, admin.userId, "NEXT", "relay", {
          binding: "NEXT",
          method: "addCustomer",
          input: { name: "Globex" },
        }),
        via(a, admin.userId, "NEXT", "relayWrite", {
          binding: "NEXT",
          method: "addCustomer",
          input: { name: "Globex" },
        }),
      ]);
    expect({
      twoDeep,
      backRound,
      tooDeep,
      writeFromRead,
      writeFromWrite,
    }).toStrictEqual({
      twoDeep: {
        ok: {
          ok: [
            {
              name: "Acme BV",
              for: admin.userId,
              from: { id: b, version: 1 },
              key: null,
            },
          ],
        },
      },
      backRound: { ok: { ok: { refused: "app.call_cycle" } } },
      tooDeep: { ok: { ok: { ok: { refused: "app.call_too_deep" } } } },
      writeFromRead: { ok: { refused: "permission.denied" } },
      writeFromWrite: { ok: { ok: true } },
    });
  });

  it("end by the time the call they came from must, and run only the version they were checked against", async () => {
    const { admin, crm } = await setUp();
    const caller = { userId: admin.userId, mode: "interactive" as const };
    const args = [{ query: "BV" }];
    const path = {
      chain: [],
      readOnly: false,
      onPinned: async () => {
        await Promise.resolve();
      },
    };
    await expect(
      Promise.all([
        outcome(
          appHost(env, crm).call(caller, "findCustomers", args, {
            ...path,
            version: 1,
            deadline: Date.now() - 1,
          })
        ),
        outcome(
          appHost(env, crm).call(caller, "findCustomers", args, {
            ...path,
            version: 2,
            deadline: Date.now() + 60_000,
          })
        ),
      ])
    ).resolves.toStrictEqual(["app.timed_out", "app.conflict"]);
  });

  it("never run a version made current and started while a call is pinned to the one it was checked against", async () => {
    const { admin, crm } = await setUp();
    const caller = { userId: admin.userId, mode: "interactive" as const };
    const withoutWrongAnswer = Object.fromEntries(
      Object.entries(exported).filter(([name]) => name !== "wrongAnswer")
    );
    let raced = false;
    const outcomeOfCall = await outcome(
      appHost(env, crm).call(caller, "addCustomer", [{ name: "Globex" }], {
        chain: [],
        readOnly: false,
        version: 1,
        deadline: Date.now() + 60_000,
        // Pinned to version 1: version 2 is made current, and another
        // call starts it in the host, before this one's method runs.
        onPinned: async () => {
          await serverBuilt(
            crm,
            await release(admin, crm, appFiles(withoutWrongAnswer))
          );
          await callApp(env, crm, caller, "customerCount");
          raced = true;
        },
      })
    );
    expect({
      raced,
      outcome: outcomeOfCall,
      // Neither version's method ran.
      customers: await callApp(env, crm, caller, "customerCount"),
    }).toStrictEqual({ raced: true, outcome: "app.conflict", customers: 0 });
  });

  it("record a call the host refuses before its method runs as refused, never called", async () => {
    const { admin, invoicing, crm } = await setUp();
    const permissionId = await grantCalls(
      admin,
      invoicing,
      crm,
      ["read", "write"],
      "CRM"
    );
    const withoutWrongAnswer = Object.fromEntries(
      Object.entries(exported).filter(([name]) => name !== "wrongAnswer")
    );
    // Version 2 made current just after the call read version 1's exports.
    const racing = afterExportsRead(async () => {
      await serverBuilt(
        crm,
        await release(admin, crm, appFiles(withoutWrongAnswer))
      );
    });
    const authority = {
      subject: { type: "app" as const, appId: invoicing },
      onBehalfOf: admin.userId,
      mode: "interactive" as const,
      appVersion: 1,
    };
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(
        callExport(
          { ...env, DB: racing },
          {
            authority,
            idempotencyKey: undefined,
            path: {
              chain: [invoicing],
              deadline: Date.now() + 60_000,
              readOnly: false,
            },
            actor: { type: "app", appId: invoicing, part: "server" },
          },
          { permissionId: permissionIdSchema.parse(permissionId), app: crm },
          "addCustomer",
          { name: "Globex" }
        )
      );
    });
    expect({
      refused,
      recorded: callsIn(events).map(({ action, detail }) => [
        action,
        detail.outcome ?? null,
        detail.reason ?? null,
      ]),
      customers: await callApp(
        env,
        crm,
        { userId: admin.userId, mode: "interactive" },
        "customerCount"
      ),
    }).toStrictEqual({
      refused: "app.conflict",
      recorded: [["app.call", "refused", "app.conflict"]],
      customers: 0,
    });
  });

  it("carry restricted mode from the App that read restricted data to the other, both ways", async () => {
    const admin = await personApi("admin");
    const knowledge: { knowledge: KnowledgeApi } = {
      knowledge: admin.api.knowledge,
    };
    const payroll = await collectionWithNote(knowledge, {
      name: "Payroll",
      access: "teams",
      teams: [await newTeam(admin, [])],
      sensitive: true,
    });
    const [invoicing, crm, other] = await Promise.all([
      newApp(admin, "Invoicing"),
      newApp(admin, "CRM"),
      newApp(admin, "Other"),
    ]);
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "app", appId: crm },
        payroll.collectionId,
        "PAYROLL"
      )
    );
    await grantCalls(admin, invoicing, crm, ["read"], "CRM");
    await grantCalls(admin, invoicing, other, ["read"], "OTHER");
    const before = await Promise.all([invoicing, crm, other].map(restricted));
    // The CRM reads restricted data for the invoicing App, and answers.
    const events = await auditedDuring(async () => {
      await expect(
        via(invoicing, admin.userId, "CRM", "readPayroll", {
          documentId: payroll.noteId,
        })
      ).resolves.toStrictEqual({ ok: true });
    });
    const afterAnswer = await Promise.all([invoicing, crm].map(restricted));
    // The invoicing App, restricted now, calls another App.
    await via(invoicing, admin.userId, "OTHER", "findCustomers", {
      query: "BV",
    });

    expect({
      before,
      afterAnswer,
      other: await restricted(other),
      recorded: events
        .filter(({ action }) => action === "context.restricted")
        .map(({ target, provenance }) => ({ target, provenance })),
    }).toStrictEqual({
      before: [false, false, false],
      afterAnswer: [true, true],
      // What it sends may carry what it holds.
      other: true,
      recorded: [
        {
          target: { type: "app", id: crm },
          provenance: [payroll.collectionId],
        },
        { target: { type: "app", id: invoicing }, provenance: [`app:${crm}`] },
      ],
    });
  });

  it("restrict the calling App when the called one fails after reading restricted data", async () => {
    const admin = await personApi("admin");
    const payroll = await collectionWithNote(
      { knowledge: admin.api.knowledge },
      {
        name: "Payroll",
        access: "teams",
        teams: [await newTeam(admin, [])],
        sensitive: true,
      }
    );
    const [invoicing, crm] = await Promise.all([
      newApp(admin, "Invoicing"),
      newApp(admin, "CRM"),
    ]);
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "app", appId: crm },
        payroll.collectionId,
        "PAYROLL"
      )
    );
    await grantCalls(admin, invoicing, crm, ["read"], "CRM");

    // Its error's message is its own, and may hold what it read.
    const failed = await via(
      invoicing,
      admin.userId,
      "CRM",
      "failAfterPayroll",
      {
        documentId: payroll.noteId,
      }
    );
    expect({ failed, restricted: await restricted(invoicing) }).toStrictEqual({
      failed: { refused: "app.failed" },
      restricted: true,
    });
  });

  it("share what the called App read with the calling App, and what a writer read with the App it writes", async () => {
    const admin = await personApi("admin");
    const [member, outsider] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const teamId = await newTeam(admin, [member]);
    const finance = await collectionWithNote(
      { knowledge: admin.api.knowledge },
      { name: "Finance", access: "teams", teams: [teamId] }
    );
    const [reader, crm, writer, bystander, quiet] = await Promise.all([
      newApp(admin, "Reader"),
      newApp(admin, "CRM"),
      newApp(admin, "Writer"),
      newApp(admin, "Bystander"),
      newApp(admin, "Quiet"),
    ]);
    // The CRM reads Finance, and the reader calls the CRM. The writer
    // reads Finance, writes into the bystander, and only reads the quiet
    // App, which a read sends nothing it keeps.
    await requestGranted(
      idp,
      admin,
      readCollection({ type: "app", appId: crm }, finance.collectionId)
    );
    await requestGranted(
      idp,
      admin,
      readCollection({ type: "app", appId: writer }, finance.collectionId)
    );
    await grantCalls(admin, reader, crm, ["read"], "CRM");
    await grantCalls(admin, writer, bystander, ["write"], "BYSTANDER");
    await grantCalls(admin, writer, quiet, ["read"], "QUIET");
    const shareWith = async (app: AppId, person: Person) =>
      await outcome(
        admin.api.apps.members.add(app, {
          type: "person",
          id: person.userId,
          role: "user",
        })
      );

    await expect(
      Promise.all([
        shareWith(reader, outsider),
        shareWith(bystander, outsider),
        shareWith(quiet, outsider),
        shareWith(reader, member),
        shareWith(bystander, member),
      ])
    ).resolves.toStrictEqual([
      "app.share_unreadable",
      "app.share_unreadable",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("read exports, grants and the Apps a call reaches by index, never a whole table", async () => {
    const { admin, clerk, invoicing, crm } = await setUp();
    await grantCalls(admin, invoicing, crm, ["read", "write"], "CRM");
    await grantCalls(admin, crm, invoicing, ["read"], "BACK");
    const queries = await recordedQueries(async () => {
      await via(invoicing, clerk.userId, "CRM", "findCustomers", {
        query: "BV",
      });
      // Sharing reads what the App reaches through calls.
      await admin.api.apps.members.add(crm, {
        type: "person",
        id: clerk.userId,
        role: "user",
      });
    });
    // What calls between Apps ask: exports by the current version, and
    // permissions on an App's exports, by either end.
    const plans = await Promise.all(
      queries
        .filter(({ query }) => callQuery.test(query))
        .map(async (recorded) => ({
          query: recorded.query,
          plan: await planOf(recorded),
        }))
    );
    expect(plans.length).toBeGreaterThanOrEqual(3);
    expect(
      plans.filter(({ plan }) =>
        plan.some((step) => fullScan.test(step) || step.includes("TEMP B-TREE"))
      )
    ).toStrictEqual([]);
  });

  it("reach another App's export from a workflow step, with the step's key", async () => {
    const admin = await personApi("admin");
    const crm = await newApp(admin, "CRM");
    const { id: invoicing } = await admin.api.apps.create({
      name: `Invoicing ${unique()}`,
    });
    const lookup = workflowFiles(
      "lookup",
      `  const found = await step.do("find", { description: "Find the customer" }, async () =>
    await appExports<{ findCustomers: (input: { query: string }) => unknown[] }>(env.CRM).findCustomers({ query: "BV" })
  );
  await step.do("remember", { description: "Remember it" }, async () =>
    await env.APP.call("remember", found)
  );`,
      { find: [], remember: true }
    );
    await release(admin, invoicing, {
      ...appFiles(),
      ...Object.fromEntries(
        Object.entries(lookup).map(([path, text]) => [
          path,
          text.replace(
            "import { workflow, z }",
            "import { appExports, workflow, z }"
          ),
        ])
      ),
    });
    await grantCalls(admin, appIdSchema.parse(invoicing), crm, ["read"], "CRM");

    let run = "";
    const events = await auditedDuring(async () => {
      ({ id: run } = await admin.api.workflows.start(invoicing, "lookup"));
      await finished(run);
    });
    const call = callsIn(events).find(({ action }) => action === "app.call");
    expect({
      actor: call?.actor,
      output: await callApp(
        env,
        appIdSchema.parse(invoicing),
        { userId: admin.userId, mode: "interactive" },
        "remembered"
      ),
    }).toStrictEqual({
      actor: {
        type: "workflow",
        appId: invoicing,
        workflowId: "lookup",
        runId: run,
      },
      output: [
        {
          name: "Acme BV",
          for: admin.userId,
          from: { id: invoicing, version: 1 },
          key: `${encodeURIComponent(run)}:find`,
        },
      ],
    });
  });
});
