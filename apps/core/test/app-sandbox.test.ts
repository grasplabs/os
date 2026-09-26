import type { AppCaller } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { appHost } from "../src/durable-objects.ts";
import { sandbox } from "../src/sandbox.ts";
import { buildServer } from "../src/screens.ts";
import { outlook, release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  collectionWithNote,
  newTeam,
  readCollection,
  storedGrant,
} from "./knowledge.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// An App's server code is written by the agent and runs for everyone who
// uses the App, so these tests take its side: code that tries to reach
// the network, the platform's bindings, another App or another person,
// and the host that has to stop it. The sample App runs for real, built
// from its committed version and loaded as a facet of its Durable Object.

const idp = mockIdp();

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => await signedInApi(idp, role);

/**
 * The sample App's server code. `LABEL` tells versions apart; module
 * state (`count`, `kept`) shows what a restart keeps, which is nothing.
 */
const serverCode = (
  label: string
) => `import { DurableObject, RpcTarget } from "cloudflare:workers";

import { outcome } from "./outcome.js";

type Caller = { userId: string; token: string };

const LABEL: string = "${label}";
let count = 0;
let kept: Caller | undefined;
let mailed = "not yet";

export class App extends DurableObject {
  label(): string {
    return LABEL;
  }

  whoami(caller: Caller): string {
    return caller.userId;
  }

  count(): number {
    count += 1;
    return count;
  }

  remember(_caller: Caller, note: string): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
    return this.notes();
  }

  notes(): string[] {
    const tables = this.tables();
    if (!tables.includes("notes")) {
      return [];
    }
    return this.ctx.storage.sql
      .exec("SELECT note FROM notes")
      .toArray()
      .map((row) => String(row.note));
  }

  tables(): string[] {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith("_cf") && !name.startsWith("sqlite"));
  }

  envNames(): string[] {
    return Object.keys(this.env as object);
  }

  async importedEnv(): Promise<string[]> {
    const workers = await import("cloudflare:workers");
    return Object.keys((workers as { env?: object }).env ?? {});
  }

  async reachOut(): Promise<Record<string, string>> {
    return {
      fetch: await outcome(fetch("https://example.com/")),
      request: await outcome(fetch(new Request("http://10.0.0.1/"))),
      cache: await outcome(caches.default.put("https://example.com/", new Response("x"))),
    };
  }

  async mail(caller: Caller, as?: unknown): Promise<string> {
    const outlook = (this.env as Record<string, any>).OUTLOOK;
    if (!outlook) {
      return "no binding";
    }
    return await outcome(outlook.call(as === undefined ? caller : as, "mail.list", {}));
  }

  async mailLater(caller: Caller, wait: (caller: Caller) => Promise<void>): Promise<string> {
    await wait(caller);
    mailed = await this.mail(caller);
    return mailed;
  }

  mailed(): string {
    return mailed;
  }

  keep(caller: Caller): string {
    kept = caller;
    return "kept";
  }

  async mailAsKept(caller: Caller): Promise<string> {
    return await this.mail(caller, kept);
  }

  async reads(caller: Caller, binding: string, documentId: string, as?: unknown): Promise<string[]> {
    const collection = (this.env as Record<string, any>)[binding];
    if (!collection) {
      return ["no binding"];
    }
    const who = as === undefined ? caller : as;
    return await Promise.all([
      outcome(collection.listDocuments(who)),
      outcome(collection.getDocument(who, documentId)),
      outcome(collection.history(who, documentId)),
      outcome(collection.backlinks(who, documentId)),
      outcome(collection.search(who, "note")),
    ]);
  }

  async readWith(caller: Caller, binding: string, method: string, args: unknown[]): Promise<string> {
    const collection = (this.env as Record<string, any>)[binding];
    return await outcome(collection[method](caller, ...args));
  }

  async readLater(
    caller: Caller,
    wait: (caller: Caller) => Promise<void>,
    binding: string,
    documentId: string
  ): Promise<string[]> {
    await wait(caller);
    return await this.reads(caller, binding, documentId);
  }

  async readAsKept(caller: Caller, binding: string, documentId: string): Promise<string[]> {
    return await this.reads(caller, binding, documentId, kept);
  }

  async provenance(caller: Caller, binding: string, documentId: string): Promise<unknown> {
    const collection = (this.env as Record<string, any>)[binding];
    const { provenance } = await collection.getDocument(caller, documentId);
    return provenance;
  }

  fail(): never {
    throw new Error("Invoice 7 has no total");
  }

  failNamed(): never {
    const error = new Error("Named");
    error.name = "Invoice 7 for Acme";
    throw error;
  }

  giveFunction(): () => string {
    return () => "called back";
  }

  giveTarget(): RpcTarget {
    return new Invoices();
  }

  giveMap(): Map<string, number> {
    return new Map([["invoices", 7]]);
  }
}

class Invoices extends RpcTarget {
  count(): number {
    return 7;
  }
}
`;

/** Runs a promise and says how it ended, by error code; for App code. */
const outcomeCode = `export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};
`;

const sampleFiles = (label: string): Record<string, string> => ({
  "app/server.ts": serverCode(label),
  "app/outcome.ts": outcomeCode,
  "screens/desk.tsx": "export default () => null;\n",
});

type Builder = Awaited<ReturnType<typeof personApi>>;

/** A new App running the sample server code. */
const sampleApp = async (builder: Builder, label = "v1"): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: "Invoice desk" });
  await release(builder, id, sampleFiles(label));
  return appIdSchema.parse(id);
};

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** The caller a workflow run's host passes when a step calls its App. */
const inRun = (userId: string): AppCallerInput => ({
  userId,
  mode: "workflow",
  idempotencyKey: `${crypto.randomUUID()}:step`,
});

/** Asks for and grants a permission; returns its ID. */
const granted = async (
  admin: Builder,
  request: PermissionRequest
): Promise<string> => {
  const { id } = await admin.api.permissions.request(request);
  await admin.api.permissions.grant(id);
  return id;
};

/**
 * Connections don't exist in connect yet, so this is a call that passed
 * every check on its way, core's and connect's.
 */
const reached = "connect.connection_not_found";

/** A Worker Loader that fails any load: proof that nothing was built. */
const noLoader: WorkerLoader = {
  get: () => {
    throw new Error("Nothing should be loaded");
  },
  load: () => {
    throw new Error("Nothing should be loaded");
  },
};

/** The module the socket test loads into the sandbox. */
interface SocketsProbe extends Rpc.WorkerEntrypointBranded {
  open: (address: string) => Promise<string>;
}

/** A promise to hold an App call at, and what the App passed while there. */
const gate = () => {
  const entered = Promise.withResolvers<AppCaller>();
  const released = Promise.withResolvers<boolean>();
  return {
    entered: entered.promise,
    release: () => {
      released.resolve(true);
    },
    wait: async (caller: AppCaller) => {
      entered.resolve(caller);
      await released.promise;
    },
  };
};

describe("App server code", { timeout: 60_000 }, () => {
  it("can't reach the network, by fetch or through a cache", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const reachOut = z
      .record(z.string(), z.string())
      .parse(await callApp(env, app, as(builder.userId), "reachOut"));
    const blocked = "not permitted to access the internet";
    expect({
      fetch: reachOut.fetch?.includes(blocked),
      request: reachOut.request?.includes(blocked),
      cache: reachOut.cache !== undefined && reachOut.cache !== "ok",
    }).toStrictEqual({ fetch: true, request: true, cache: true });
  });

  it("has only its own granted connections in its env, never core's bindings", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await granted(admin, outlook(app));
    await admin.api.permissions.request(outlook(app, "ASKED"));
    await admin.api.permissions.revoke(
      await granted(admin, outlook(app, "GONE"))
    );
    const other = await sampleApp(admin);
    await granted(admin, outlook(other, "SOMEONE_ELSES"));

    const [envNames, importedEnv] = await Promise.all([
      callApp(env, app, as(admin.userId), "envNames"),
      callApp(env, app, as(admin.userId), "importedEnv"),
    ]);
    expect({ envNames, importedEnv }).toStrictEqual({
      envNames: ["OUTLOOK"],
      importedEnv: [],
    });
  });

  it("can't read another App's data, or its host's", async () => {
    const builder = await personApi("builder");
    const [mine, theirs] = await Promise.all([
      sampleApp(builder),
      sampleApp(builder),
    ]);
    await callApp(env, theirs, as(builder.userId), "remember", ["secret"]);
    await callApp(env, mine, as(builder.userId), "remember", ["mine"]);
    await runInDurableObject(appHost(env, mine), (_host, state) => {
      state.storage.sql.exec("CREATE TABLE host_secrets (secret TEXT)");
    });

    const [notes, tables] = await Promise.all([
      callApp(env, mine, as(builder.userId), "notes"),
      callApp(env, mine, as(builder.userId), "tables"),
    ]);
    expect({ notes, tables }).toStrictEqual({
      notes: ["mine"],
      tables: ["notes"],
    });
  });

  it("shares no memory with another App running the same code", async () => {
    const builder = await personApi("builder");
    const [one, two] = await Promise.all([
      sampleApp(builder),
      sampleApp(builder),
    ]);
    const counts = [
      await callApp(env, one, as(builder.userId), "count"),
      await callApp(env, one, as(builder.userId), "count"),
      await callApp(env, two, as(builder.userId), "count"),
    ];
    expect(counts).toStrictEqual([1, 2, 1]);
  });

  it("acts for each caller of the App, when two people use it at once", async () => {
    const admin = await personApi("admin");
    const stays = await personApi("user");
    const leaves = await personApi("user");
    const app = await sampleApp(admin);
    await granted(admin, outlook(app));
    // Someone who left can't use the App's connections any more: that is
    // how these calls show whom they act for.
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(leaves.userId)
      .run();
    await callApp(env, app, as(stays.userId), "label");

    // Each waits in the App while the other one calls, in both orders.
    const first = gate();
    const staysFirst = callApp(env, app, as(stays.userId), "mailLater", [
      first.wait,
    ]);
    await first.entered;
    const leavesMeanwhile = await callApp(env, app, as(leaves.userId), "mail");
    first.release();

    const second = gate();
    const leavesFirst = callApp(env, app, as(leaves.userId), "mailLater", [
      second.wait,
    ]);
    await second.entered;
    const staysMeanwhile = await callApp(env, app, as(stays.userId), "mail");
    second.release();

    const whoami = await Promise.all([
      callApp(env, app, as(stays.userId), "whoami"),
      callApp(env, app, as(leaves.userId), "whoami"),
    ]);
    expect({
      stays: [await staysFirst, staysMeanwhile],
      leaves: [leavesMeanwhile, await leavesFirst],
      whoami,
    }).toStrictEqual({
      stays: [reached, reached],
      leaves: ["permission.person_inactive", "permission.person_inactive"],
      whoami: [stays.userId, leaves.userId],
    });
  });

  it("can't make up a caller, or use one after its call ended", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await granted(admin, outlook(app));
    const caller = as(admin.userId);

    const madeUp = await Promise.all(
      [
        { userId: admin.userId, token: crypto.randomUUID() },
        { userId: admin.userId },
        admin.userId,
        null,
      ].map(async (forged) => await callApp(env, app, caller, "mail", [forged]))
    );
    await callApp(env, app, caller, "keep");
    const afterItEnded = await callApp(env, app, caller, "mailAsKept");
    expect({ madeUp, afterItEnded }).toStrictEqual({
      madeUp: [
        "app.caller_invalid",
        "app.caller_invalid",
        "app.caller_invalid",
        "app.caller_invalid",
      ],
      afterItEnded: "app.caller_invalid",
    });
  });

  it("can't act with a caller of another App", async () => {
    const admin = await personApi("admin");
    const [mine, theirs] = await Promise.all([
      sampleApp(admin),
      sampleApp(admin),
    ]);
    await granted(admin, outlook(mine));
    await granted(admin, outlook(theirs));
    await Promise.all([
      callApp(env, mine, as(admin.userId), "label"),
      callApp(env, theirs, as(admin.userId), "label"),
    ]);

    const held = gate();
    const theirCall = callApp(env, theirs, as(admin.userId), "mailLater", [
      held.wait,
    ]);
    const theirCaller = await held.entered;
    const withTheirCaller = await callApp(env, mine, as(admin.userId), "mail", [
      theirCaller,
    ]);
    held.release();
    expect({
      withTheirCaller,
      theirOwn: await theirCall,
    }).toStrictEqual({
      withTheirCaller: "app.caller_invalid",
      theirOwn: reached,
    });
  });

  it("loses a revoked connection at once, and gets a new grant without a release", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    const caller = as(admin.userId);
    const permission = await granted(admin, outlook(app));
    const whileGranted = await callApp(env, app, caller, "mail");

    await admin.api.permissions.revoke(permission);
    const afterRevoke = await Promise.all([
      callApp(env, app, caller, "mail"),
      callApp(env, app, caller, "envNames"),
    ]);
    await granted(admin, outlook(app, "OUTLOOK"));
    const afterNewGrant = await callApp(env, app, caller, "mail");
    expect({ whileGranted, afterRevoke, afterNewGrant }).toStrictEqual({
      whileGranted: reached,
      afterRevoke: ["no binding", []],
      afterNewGrant: reached,
    });
  });

  it("is audited with the version whose code made each connection call", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin, "v1");
    await granted(admin, outlook(app));
    /** The versions on the App's connection calls in the log, once `count` are. */
    const auditedVersions = async (count: number) =>
      await vi.waitFor(async () => {
        const events = await allEvents();
        const calls = events.filter(
          ({ action, actor }) =>
            action === "connection.call" &&
            actor.type === "app" &&
            actor.appId === app
        );
        if (calls.length < count) {
          throw new Error("Not every call is in the audit log yet");
        }
        return calls.map(({ detail }) => detail.appVersion);
      }, 10_000);

    await callApp(env, app, as(admin.userId), "mail");
    const beforeRelease = await auditedVersions(1);
    await release(admin, app, { "app/server.ts": serverCode("v2") });
    await callApp(env, app, as(admin.userId), "mail");
    // A workflow run's call into the App, with its step's key.
    await callApp(
      env,
      app,
      { userId: admin.userId, mode: "workflow", idempotencyKey: "run:step" },
      "mail"
    );
    expect({
      beforeRelease,
      afterRelease: await auditedVersions(3),
    }).toStrictEqual({ beforeRelease: [1], afterRelease: [1, 2, 2] });
  });

  it("makes no connection calls once it is in restricted mode", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await granted(admin, outlook(app));
    const caller = as(admin.userId);
    const before = await callApp(env, app, caller, "mail");
    await appHost(env, app).restrict();
    const after = await callApp(env, app, caller, "mail");
    expect({ before, after }).toStrictEqual({
      before: reached,
      after: "permission.restricted",
    });
  });

  it("keeps its data across restarts and versions, and nothing else", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder, "v1");
    const caller = as(builder.userId);
    await callApp(env, app, caller, "remember", ["before"]);
    await callApp(env, app, caller, "count");

    await appHost(env, app).restart("A test restarts it.");
    const afterRestart = {
      notes: await callApp(env, app, caller, "remember", ["restarted"]),
      count: await callApp(env, app, caller, "count"),
    };

    await release(builder, app, { "app/server.ts": serverCode("v2") });
    const afterRelease = {
      label: await callApp(env, app, caller, "label"),
      notes: await callApp(env, app, caller, "remember", ["released"]),
      count: await callApp(env, app, caller, "count"),
    };

    await builder.api.apps.versions.setCurrent(app, 1);
    const afterRollback = {
      label: await callApp(env, app, caller, "label"),
      count: await callApp(env, app, caller, "count"),
    };
    expect({ afterRestart, afterRelease, afterRollback }).toStrictEqual({
      afterRestart: { notes: ["before", "restarted"], count: 1 },
      afterRelease: {
        label: "v2",
        notes: ["before", "restarted", "released"],
        count: 1,
      },
      afterRollback: { label: "v1", count: 1 },
    });
  });

  it("can't keep acting for a caller by holding a call open", async () => {
    const admin = await personApi("admin");
    const app = await sampleApp(admin);
    await granted(admin, outlook(app));
    const caller = as(admin.userId);
    await callApp(env, app, caller, "label");

    // A busy loop ends at the CPU limit, which the platform enforces and
    // workerd doesn't; a call that waits too long is given up on.
    const held = gate();
    const holding = outcome(
      callApp(env, app, caller, "mailLater", [held.wait])
    );
    await held.entered;
    const timedOut = await holding;
    const meanwhile = await callApp(env, app, caller, "mail");
    // The held call goes on in the App, but its caller has stopped working.
    held.release();
    const mailedAfter = await vi.waitFor(async () => {
      const mailed = await callApp(env, app, caller, "mailed");
      if (mailed === "not yet") {
        throw new Error("The held call hasn't mailed yet");
      }
      return mailed;
    }, 10_000);
    expect({ timedOut, meanwhile, mailedAfter }).toStrictEqual({
      timedOut: "app.timed_out",
      meanwhile: reached,
      mailedAfter: "app.caller_invalid",
    });
  });

  it("reports its errors with the version, and logs none of their text", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    // What the App's host writes to Workers Logs while the call fails.
    const logged = vi.spyOn(console, "warn");
    let failed: unknown;
    let logs: string;
    try {
      failed = await callApp(env, app, as(builder.userId), "fail").then(
        () => {},
        (error: unknown) => error
      );
      await outcome(callApp(env, app, as(builder.userId), "failNamed"));
      logs = JSON.stringify(logged.mock.calls);
    } finally {
      logged.mockRestore();
    }
    expect({
      failed,
      logsTheCall: logs.includes("app.call_failed"),
      logsTheText: logs.includes("Invoice 7"),
    }).toMatchObject({
      failed: {
        code: "app.failed",
        details: {
          version: 1,
          method: "fail",
          message: "Invoice 7 has no total",
        },
      },
      logsTheCall: true,
      logsTheText: false,
    });
  });

  it("answers plain data only, never a way back into the App", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const answers = await Promise.all(
      ["giveFunction", "giveTarget", "giveMap"].map(
        async (method) =>
          await outcome(callApp(env, app, as(builder.userId), method))
      )
    );
    expect(answers).toStrictEqual([
      "app.answer_invalid",
      "app.answer_invalid",
      "ok",
    ]);
  });

  it("tells its callers nothing of what fails outside the App", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    // Arguments RPC can't carry fail on the way in.
    const failed = await callApp(env, app, as(builder.userId), "label", [
      Symbol("not data"),
    ]).then(
      () => {},
      (error: unknown) => error
    );
    expect(failed).toMatchObject({
      code: "internal.unexpected",
      message: "Something went wrong.",
    });
  });

  it("answers only the methods the App exports", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const refused = await Promise.all(
      [
        "fetch",
        "alarm",
        "constructor",
        "__proto__",
        "then",
        "",
        "a.b",
        "toString",
        "hasOwnProperty",
        "propertyIsEnumerable",
        "toLocaleString",
        "valueOf",
        "connect",
        "get",
        "put",
        "delete",
        "queue",
        "scheduled",
        "id",
        "name",
      ].map(
        async (method) =>
          await outcome(callApp(env, app, as(builder.userId), method))
      )
    );
    expect(refused).toStrictEqual(refused.map(() => "app.method_invalid"));
  });

  it("can't open a socket, to the internet or to the host", async () => {
    // What the App's server build refuses to import, loaded as the sandbox
    // loads App code: `connect()` has no way out either.
    const sockets = env.LOADER.get("sandbox-sockets-test", () => ({
      ...sandbox,
      mainModule: "sockets.js",
      modules: {
        "sockets.js": `import { WorkerEntrypoint } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

export default class extends WorkerEntrypoint {
  async open(address) {
    try {
      const socket = connect(address);
      await socket.opened;
      return "open";
    } catch (error) {
      return String(error);
    }
  }
}
`,
      },
      env: {},
    }));
    const entrypoint = sockets.getEntrypoint<SocketsProbe>();
    const opened = await Promise.all(
      ["1.1.1.1:443", "example.com:80", "127.0.0.1:8787", "localhost:80"].map(
        async (address) => await entrypoint.open(address)
      )
    );
    expect(
      opened.map((result) =>
        result.includes("not permitted to access the internet")
      )
    ).toStrictEqual([true, true, true, true]);
  });

  it("runs nothing without a current version that builds, and builds it once", async () => {
    const builder = await personApi("builder");
    const { id } = await builder.api.apps.create({ name: "Empty" });
    const empty = appIdSchema.parse(id);
    const noVersion = await outcome(
      callApp(env, empty, as(builder.userId), "label")
    );
    const broken = {
      "app/server.ts":
        'import { readFileSync } from "node:fs";\nimport "./legacy.js";\nimport "./lazy.js";\nexport class App {}\n',
      "app/legacy.ts": 'export const fs = require("node:fs");\n',
      "app/lazy.ts":
        'export const load = async () => await import("node:fs");\n',
    };
    await release(builder, empty, broken);
    const brokenBuild = await callApp(
      env,
      empty,
      as(builder.userId),
      "label"
    ).then(
      () => {},
      (error: unknown) => error
    );
    // The same files fail the same way: from the cache, without a compiler.
    const again = await buildServer(
      { ...env, LOADER: noLoader },
      { app: empty, version: "1", files: broken }
    );
    const unknownApp = await outcome(
      callApp(
        env,
        appIdSchema.parse("no-such-app"),
        as(builder.userId),
        "label"
      )
    );
    expect({
      noVersion,
      brokenBuild,
      again: again.ok,
      unknownApp,
    }).toMatchObject({
      noVersion: "app.not_running",
      brokenBuild: {
        code: "app.build_failed",
        details: {
          version: 1,
          diagnostics: [
            { file: "app/lazy.ts", line: 1 },
            { file: "app/legacy.ts" },
            { file: "app/server.ts", line: 1 },
          ],
        },
      },
      again: false,
      unknownApp: "app.not_found",
    });
  });
});

/** Someone's Knowledge, as they reach it in the product. */
const knowledgeOf = (person: Builder): { knowledge: KnowledgeApi } => {
  const knowledge: KnowledgeApi = person.api.knowledge;
  return { knowledge };
};

/** What each of the sample App's reads (`reads`) ended with. */
const everyReadIs = (code: string) => Array.from({ length: 5 }, () => code);

// The same App serves everyone, so what it reads from Knowledge must be
// what the person whose call it runs in may read, and no more (R5): the
// App's grant intersected with that person's access, never a personal
// collection (those never enter a shared context), and never for someone
// App code names itself (R3, SB4). A sensitive read restricts the App for
// good, before the data reaches its code (Q12).
describe("App server code reading Knowledge", { timeout: 60_000 }, () => {
  /**
   * An App granted a team's collection (`HANDBOOK`), a member of the team
   * and someone outside it, and a collection the App wasn't granted.
   */
  const setUp = async () => {
    const admin = await personApi("admin");
    const member = await personApi("user");
    const outsider = await personApi("user");
    const teamId = await newTeam(admin, [member]);
    const [finance, other] = await Promise.all([
      collectionWithNote(knowledgeOf(admin), {
        name: "Finance",
        access: "teams",
        teams: [teamId],
      }),
      collectionWithNote(knowledgeOf(admin), {
        name: "Other",
        access: "everyone",
      }),
    ]);
    const app = await sampleApp(admin);
    const permission = await granted(
      admin,
      readCollection({ type: "app", appId: app }, finance.collectionId)
    );
    return { admin, member, outsider, app, permission, finance, other };
  };

  it("reads a granted collection for the calling person, and nothing they or it can't read", async () => {
    const { admin, member, outsider, app, permission, finance, other } =
      await setUp();
    const readsAs = async (userId: string, noteId = finance.noteId) =>
      await callApp(env, app, as(userId), "reads", ["HANDBOOK", noteId]);

    expect({
      envNames: await callApp(env, app, as(member.userId), "envNames"),
      member: await readsAs(member.userId),
      // The App's grant alone isn't enough.
      outsider: await readsAs(outsider.userId),
      // Only its own collection, also for someone who can read another.
      other: await readsAs(member.userId, other.noteId),
    }).toStrictEqual({
      envNames: ["HANDBOOK"],
      member: everyReadIs("ok"),
      outsider: everyReadIs("knowledge.not_found"),
      other: [
        "ok",
        "knowledge.not_found",
        "knowledge.not_found",
        "knowledge.not_found",
        "ok",
      ],
    });

    await admin.api.permissions.revoke(permission);
    await expect(readsAs(member.userId)).resolves.toStrictEqual(["no binding"]);
  });

  it("reads nothing for someone who has left", async () => {
    const { member, app, finance } = await setUp();
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(member.userId)
      .run();
    await expect(
      callApp(env, app, as(member.userId), "reads", [
        "HANDBOOK",
        finance.noteId,
      ])
    ).resolves.toStrictEqual(everyReadIs("permission.person_inactive"));
  });

  it("reads for each caller of the App, when two people read at once", async () => {
    const { member, outsider, app, finance } = await setUp();
    await callApp(env, app, as(member.userId), "label");
    const readArgs = ["HANDBOOK", finance.noteId];

    // Each waits in the App while the other one reads, in both orders.
    const first = gate();
    const memberFirst = callApp(env, app, as(member.userId), "readLater", [
      first.wait,
      ...readArgs,
    ]);
    await first.entered;
    const outsiderMeanwhile = await callApp(
      env,
      app,
      as(outsider.userId),
      "reads",
      readArgs
    );
    first.release();

    const second = gate();
    const outsiderFirst = callApp(env, app, as(outsider.userId), "readLater", [
      second.wait,
      ...readArgs,
    ]);
    await second.entered;
    const memberMeanwhile = await callApp(
      env,
      app,
      as(member.userId),
      "reads",
      readArgs
    );
    second.release();

    expect({
      member: [await memberFirst, memberMeanwhile],
      outsider: [outsiderMeanwhile, await outsiderFirst],
    }).toStrictEqual({
      member: [everyReadIs("ok"), everyReadIs("ok")],
      outsider: [
        everyReadIs("knowledge.not_found"),
        everyReadIs("knowledge.not_found"),
      ],
    });
  });

  it("can't read with a made-up caller, one whose call ended, or another App's", async () => {
    const { admin, member, app, finance } = await setUp();
    const theirs = await sampleApp(admin);
    await granted(
      admin,
      readCollection({ type: "app", appId: theirs }, finance.collectionId)
    );
    const caller = as(member.userId);
    const readArgs = ["HANDBOOK", finance.noteId];

    const madeUp = await Promise.all(
      [
        { userId: member.userId, token: crypto.randomUUID() },
        { userId: member.userId },
        member.userId,
        null,
      ].map(
        async (forged) =>
          await callApp(env, app, caller, "reads", [...readArgs, forged])
      )
    );
    await callApp(env, app, caller, "keep");
    const afterItEnded = await callApp(
      env,
      app,
      caller,
      "readAsKept",
      readArgs
    );

    const held = gate();
    const theirCall = callApp(env, theirs, caller, "readLater", [
      held.wait,
      ...readArgs,
    ]);
    const theirCaller = await held.entered;
    const withTheirCaller = await callApp(env, app, caller, "reads", [
      ...readArgs,
      theirCaller,
    ]);
    held.release();
    expect({
      madeUp,
      afterItEnded,
      withTheirCaller,
      theirOwn: await theirCall,
    }).toStrictEqual({
      madeUp: Array.from({ length: 4 }, () =>
        everyReadIs("app.caller_invalid")
      ),
      afterItEnded: everyReadIs("app.caller_invalid"),
      withTheirCaller: everyReadIs("app.caller_invalid"),
      theirOwn: everyReadIs("ok"),
    });
  });

  it("never reads a personal collection, not even for its owner", async () => {
    const owner = await personApi("user");
    const diary = await collectionWithNote(knowledgeOf(owner), {
      name: "Diary",
      access: "me",
    });
    const app = await sampleApp(await personApi("builder"));
    // Nobody can grant one; a grant that exists anyway reads nothing.
    await storedGrant(
      { type: "app", id: app },
      { type: "collection", id: diary.collectionId },
      ["read"],
      "DIARY"
    );
    await expect(
      callApp(env, app, as(owner.userId), "reads", ["DIARY", diary.noteId])
    ).resolves.toStrictEqual(everyReadIs("knowledge.not_found"));
  });

  it("is restricted for good by a sensitive read, and then makes no connection calls for anyone", async () => {
    const admin = await personApi("admin");
    const outsider = await personApi("user");
    const teamId = await newTeam(admin, []);
    const [payroll, handbook] = await Promise.all([
      collectionWithNote(knowledgeOf(admin), {
        name: "Payroll",
        access: "teams",
        teams: [teamId],
        sensitive: true,
      }),
      collectionWithNote(knowledgeOf(admin), {
        name: "Handbook",
        access: "everyone",
      }),
    ]);
    const app = await sampleApp(admin);
    const subject = { type: "app" as const, appId: app };
    await granted(admin, outlook(app));
    await granted(admin, readCollection(subject, payroll.collectionId));
    await granted(
      admin,
      readCollection(subject, handbook.collectionId, "OTHER")
    );
    const mail = async (userId: string) =>
      await callApp(env, app, as(userId), "mail");

    // Ordinary reads, and a sensitive read that was refused, change nothing.
    const ordinary = await callApp(env, app, as(admin.userId), "provenance", [
      "OTHER",
      handbook.noteId,
    ]);
    const refused = await callApp(env, app, as(outsider.userId), "reads", [
      "HANDBOOK",
      payroll.noteId,
    ]);
    const before = await mail(admin.userId);

    const sensitive = await callApp(env, app, as(admin.userId), "provenance", [
      "HANDBOOK",
      payroll.noteId,
    ]);
    await appHost(env, app).restart("A test restarts it.");
    expect({
      ordinary,
      refused,
      before,
      sensitive,
      after: [await mail(admin.userId), await mail(outsider.userId)],
      // Knowledge stays inside the deployment, so it can still be read.
      stillReads: await callApp(env, app, as(admin.userId), "reads", [
        "OTHER",
        handbook.noteId,
      ]),
    }).toStrictEqual({
      ordinary: {
        collectionIds: [handbook.collectionId],
        sensitive: false,
        restricted: false,
      },
      refused: everyReadIs("knowledge.not_found"),
      before: reached,
      sensitive: {
        collectionIds: [payroll.collectionId],
        sensitive: true,
        restricted: true,
      },
      after: ["permission.restricted", "permission.restricted"],
      stillReads: everyReadIs("ok"),
    });
  });

  it("is restricted by every read that reaches a sensitive collection, also one that finds nothing", async () => {
    const admin = await personApi("admin");
    const teamId = await newTeam(admin, []);
    const payroll = await collectionWithNote(knowledgeOf(admin), {
      name: "Payroll",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    // A search that misses, or a version that isn't there, still tells App
    // code something of the collection, so it could probe it candidate by
    // candidate and send out what it learned.
    const reads: [method: string, args: unknown[]][] = [
      ["listDocuments", []],
      ["history", [payroll.noteId]],
      ["backlinks", [payroll.noteId]],
      ["search", ["note"]],
      ["search", ["zzzqqqxxx"]],
      ["search", [""]],
      ["getDocument", [payroll.noteId, 99]],
    ];
    const results = await Promise.all(
      reads.map(async ([method, args]) => {
        const app = await sampleApp(admin);
        await granted(admin, outlook(app));
        await granted(
          admin,
          readCollection({ type: "app", appId: app }, payroll.collectionId)
        );
        const read = await callApp(env, app, as(admin.userId), "readWith", [
          "HANDBOOK",
          method,
          args,
        ]);
        return [read, await callApp(env, app, as(admin.userId), "mail")];
      })
    );
    expect(results).toStrictEqual([
      ["ok", "permission.restricted"],
      ["ok", "permission.restricted"],
      ["ok", "permission.restricted"],
      ["ok", "permission.restricted"],
      ["ok", "permission.restricted"],
      ["ok", "permission.restricted"],
      ["knowledge.not_found", "permission.restricted"],
    ]);
  });

  it("reads for the person a workflow run acts for, when the run calls it", async () => {
    const { member, outsider, app, finance } = await setUp();
    const readArgs = ["HANDBOOK", finance.noteId];
    expect({
      member: await callApp(env, app, inRun(member.userId), "reads", readArgs),
      outsider: await callApp(
        env,
        app,
        inRun(outsider.userId),
        "reads",
        readArgs
      ),
    }).toStrictEqual({
      member: everyReadIs("ok"),
      outsider: everyReadIs("knowledge.not_found"),
    });
  });
});
