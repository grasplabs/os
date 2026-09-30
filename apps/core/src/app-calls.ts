import { appCallLimits, appErrors, isExportName } from "@grasp-os/shared/apps";
import type { AppExport } from "@grasp-os/shared/apps";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { callerOf } from "./app-bindings.ts";
import type { AppAnswer, CallPath } from "./app.ts";
import { auditedBatch, keepAuditEvent, outboxed } from "./audit-outbox.ts";
import { forSandbox } from "./bindings.ts";
import type { ExportGrant } from "./bindings.ts";
import { apps, appVersions } from "./db/core/schema.ts";
import { appHost } from "./durable-objects.ts";
import { requireFeature } from "./features.ts";
import { authorizeExport } from "./permissions.ts";
import { isRestricted, restrict } from "./restricted.ts";

// Calls between Apps. An App calls another's exports (the server methods
// its `app/exports.json` declares, app-exports.ts) under a permission an
// admin granted it on them: `await this.env.CRM.call(caller, "findCustomers",
// input)` in its server code, `env.CRM.call("findCustomers", input)` in its
// workflows. The call runs on the calling App's permission alone, for the
// person its caller acts for, as a connection call would: whether that
// person has a role in the called App isn't checked. The called App's
// method runs in its own sandbox, with its own permissions, and gets the
// calling App and version on its caller (`caller.app`).
//
// Everything that decides a call is core's, never the calling code's: the
// calling App and the person come from its host's running call (the token
// on the caller), the called App from the permission the stub was built
// from, and the exports from the called App's current version. In order:
//
// - The Apps whose calls are under way (`CallPath.chain`, kept by each
//   host) never include the called App, so no call comes back round, and
//   are at most `appCallLimits.depth` long. Each call ends by the time the
//   first must (`CallPath.deadline`).
// - The export exists in the called App's current version, and the call
//   runs only on that version (`ExportCall.version`): an export removed or
//   changed since is `app.export_not_found` or `app.conflict`, never a call
//   of code nobody checked it against.
// - A call made while serving an export marked `read` calls only exports
//   marked `read` further on (`CallPath.readOnly`): reading can't turn into
//   writing down a chain.
// - The permission allows the export (`authorizeExport`), and one marked
//   `write` only from a version of the calling code an admin approved.
// - The input and the answer are JSON within `appCallLimits`, and match
//   the export's schemas. The called App gets the JSON, nothing else.
// - Restricted mode follows the data both ways, each flag set before the
//   data moves (restricted.ts): a restricted caller restricts the called App
//   before its input reaches it, and a restricted called App restricts the
//   caller before its answer does.
// - Every call is recorded before it runs, on both sides: `app.call` by
//   the calling App (or run) and `app.called` by the called App, in one
//   batch, once the called App's host has pinned the call to the version
//   checked and just before the method runs (`ExportCall.onPinned`); if
//   they can't be stored, nothing is called. One the host refuses before
//   its method runs (another version current, say) is recorded as
//   refused instead. A refusal is
//   recorded as `app.call` with why, a caller the calling App isn't
//   running a call of too.
//
// What the called App's method then does with its own permissions is its
// own: its connections and collections are checked as for any of its
// calls, for the same person. Whether an export reads or writes is the
// called App's own declaration. The chain and read-only hold per call,
// by its token: the called App's code could make a call on with the token
// of another call of its own running at the same time, which is within
// that declaration's trust.

/** What a call records for a name that isn't a method's: none can be it. */
const notAMethod = "(not a method)";

/**
 * The export's name as the audit log keeps it: an export's name, or
 * `notAMethod`, so calling code can't write text of its choosing into the
 * log for good.
 */
const recordedName = (method: unknown): string =>
  typeof method === "string" && isExportName(method) ? method : notAMethod;

/** Who calls an export, as core knows them. */
export interface ExportCaller {
  /** The calling App, the version of its code, and the person. */
  authority: Authority;
  /** For a workflow run's step: its key, handed on to the called App. */
  idempotencyKey: string | undefined;
  /** For a workflow run's step: its attempt, handed on with the key. */
  attempt?: string | undefined;
  /** Where the call is: the calling App last in its chain. */
  path: CallPath;
  /** Who the audit log says called: the App's server code, or the run. */
  actor: AuditActor;
}

/** The version of `app` that runs, and its exports; refused while none does. */
const currentExports = async (
  env: Env,
  app: AppId
): Promise<{ version: number; exports: Record<string, AppExport> }> => {
  const found = await drizzle(env.DB)
    .select({ version: apps.currentVersion, exports: appVersions.exports })
    .from(apps)
    .leftJoin(
      appVersions,
      and(
        eq(appVersions.appId, apps.id),
        eq(appVersions.version, apps.currentVersion)
      )
    )
    .where(eq(apps.id, app))
    .get();
  if (!found) {
    throw appErrors.create("app.not_found");
  }
  if (found.version === null || found.exports === null) {
    throw appErrors.create("app.not_running");
  }
  return { version: found.version, exports: found.exports };
};

/**
 * Most export schemas this isolate keeps compiled: past it, it starts
 * again, so memory stays bounded however many Apps call.
 */
const compiledSchemasMax = 512;

/**
 * Each export schema compiled once, by App, version, export and which
 * side (`input` or `output`): a version's exports never change, so the
 * key names one schema for good.
 */
const compiledSchemas = new Map<string, z.ZodType>();

/** `schema`, the export schema `key` names, compiled (`compiledSchemas`). */
const compiledSchema = (
  key: string,
  schema: Record<string, unknown>
): z.ZodType => {
  const kept = compiledSchemas.get(key);
  if (kept !== undefined) {
    return kept;
  }
  if (compiledSchemas.size >= compiledSchemasMax) {
    compiledSchemas.clear();
  }
  const compiled = z.fromJSONSchema(schema);
  compiledSchemas.set(key, compiled);
  return compiled;
};

/**
 * `value` as JSON within `maxBytes` (its UTF-8 as sent), checked against
 * `schema`, and read back from that JSON: nothing but JSON goes on.
 */
const checkedJson = (
  value: unknown,
  maxBytes: number,
  schema: z.ZodType,
  invalid: () => Error
): Json => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw invalid();
  }
  if (text === undefined) {
    throw invalid();
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw appErrors.create("app.call_too_large", { maxBytes });
  }
  const json = z.json().parse(JSON.parse(text));
  if (!schema.safeParse(json).success) {
    throw invalid();
  }
  return json;
};

/** What both sides' records of a call say. */
interface CallRecord {
  caller: ExportCaller;
  called: AppId;
  method: string;
}

/** The calling side's record: `app.call`, and how it ended when refused. */
const callEntry = (
  { caller, called, method }: CallRecord,
  detail: Record<string, string | number | null>
): AuditEntry => ({
  actor: caller.actor,
  action: "app.call",
  target: { type: "app", id: called },
  detail: {
    method,
    version: caller.authority.appVersion ?? null,
    person: caller.authority.onBehalfOf,
    depth: caller.path.chain.length,
    ...detail,
  },
});

/** The called side's record: `app.called`, by the called App. */
const calledEntry = (
  { caller, called, method }: CallRecord,
  { version, access }: { version: number; access: string }
): AuditEntry => {
  const { subject, appVersion, onBehalfOf } = caller.authority;
  return {
    actor: { type: "app", appId: called, part: "server" },
    action: "app.called",
    target: {
      type: "app",
      id: subject.type === "app" ? subject.appId : subject.agentId,
    },
    detail: {
      method,
      access,
      version,
      callerVersion: appVersion ?? null,
      person: onBehalfOf,
      depth: caller.path.chain.length,
    },
  };
};

/**
 * Refuses a call that would come back round to an App already in it, or
 * go deeper than `appCallLimits.depth`.
 */
const requireWithinChain = (path: CallPath, called: AppId): void => {
  if (path.chain.includes(called)) {
    throw appErrors.create("app.call_cycle");
  }
  if (path.chain.length > appCallLimits.depth) {
    throw appErrors.create("app.call_too_deep", {
      depth: appCallLimits.depth,
    });
  }
};

/**
 * The App a caller's authority names, and its code's version, which the
 * host always sets; an agent never calls exports.
 */
const callingApp = ({
  subject,
  appVersion,
}: Authority): { app: AppId; version: number } => {
  if (subject.type !== "app" || appVersion === undefined) {
    throw permissionErrors.create("permission.denied", { action: "call" });
  }
  return { app: subject.appId, version: appVersion };
};

/**
 * Calls export `method` of the App `grant` names, with `input`, for
 * `caller`, as the comment at the top of this file says. Refusals are
 * recorded and thrown as they are; errors as the calling code should see
 * them are the caller's to make (`forSandbox`).
 */
export const callExport = async (
  env: Env,
  caller: ExportCaller,
  grant: ExportGrant,
  method: unknown,
  input: unknown
): Promise<Json> => {
  const name = recordedName(method);
  const record: CallRecord = { caller, called: grant.app, method: name };
  const { app: calling, version: callingVersion } = callingApp(
    caller.authority
  );
  const db = drizzle(env.DB);
  let checked: { version: number; exported: AppExport; input: Json };
  try {
    requireFeature(env, "apps");
    requireFeature(env, "app_calls");
    requireWithinChain(caller.path, grant.app);
    const { version, exports } = await currentExports(env, grant.app);
    const exported =
      name !== notAMethod && Object.hasOwn(exports, name)
        ? exports[name]
        : undefined;
    if (exported === undefined) {
      throw appErrors.create("app.export_not_found", { method: name });
    }
    if (caller.path.readOnly && exported.access === "write") {
      throw permissionErrors.create("permission.denied", { action: name });
    }
    await authorizeExport(
      env,
      caller.authority,
      grant.app,
      { method: name, access: exported.access },
      grant.permissionId
    );
    checked = {
      version,
      exported,
      input: checkedJson(
        input,
        appCallLimits.inputBytes,
        compiledSchema(`${grant.app}:${version}:${name}:input`, exported.input),
        () => appErrors.create("app.call_invalid", { method: name })
      ),
    };
  } catch (error) {
    await keepAuditEvent(
      env,
      db,
      callEntry(record, {
        outcome: "refused",
        reason: isExpectedError(error) ? error.code : "internal.unexpected",
      })
    );
    throw error;
  }
  const {
    version,
    exported: { access, output },
  } = checked;
  const { onBehalfOf, mode } = caller.authority;
  const calledAuthority: Authority = {
    subject: { type: "app", appId: grant.app },
    onBehalfOf,
    mode,
    appVersion: version,
  };
  const callingContext = { type: "app", appId: calling } as const;
  const calledContext = { type: "app", appId: grant.app } as const;
  // The input may carry what a restricted caller read.
  if (await isRestricted(env, caller.authority, callingContext)) {
    await restrict(env, calledAuthority, calledContext, [`app:${calling}`]);
  }
  // Both sides' records, once the called App's host has pinned the call
  // to `version` and before its method runs (`ExportCall.onPinned`): a
  // call that never gets that far is recorded as refused instead.
  let recorded = false;
  const recordCalled = async (): Promise<void> => {
    await auditedBatch(env, db, [
      outboxed(
        db,
        callEntry(record, {
          access,
          calledVersion: version,
          outcome: "called",
        })
      ),
      outboxed(db, calledEntry(record, { version, access })),
    ]);
    recorded = true;
  };
  // The answer, and an error of the called App's own (its message), may
  // carry what it read restricted: the caller is restricted before either
  // reaches it. Should that fail, so does the call, whatever the called
  // App answered: failing closed, not passing on what may be restricted.
  const carryRestricted = async (): Promise<void> => {
    if (await isRestricted(env, calledAuthority, calledContext)) {
      await restrict(env, caller.authority, callingContext, [
        `app:${grant.app}`,
      ]);
    }
  };
  let answer: AppAnswer;
  try {
    answer = await appHost(env, grant.app).call(
      {
        userId: onBehalfOf,
        mode,
        ...(caller.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: caller.idempotencyKey }),
        ...(caller.attempt === undefined ? {} : { attempt: caller.attempt }),
        app: { id: calling, version: callingVersion },
      },
      name,
      [checked.input],
      {
        version,
        chain: caller.path.chain,
        deadline: caller.path.deadline,
        readOnly: caller.path.readOnly || access === "read",
        onPinned: recordCalled,
      }
    );
  } catch (error) {
    // Refused before its method ran: never recorded as called, or found
    // another version running once it was (`app.conflict`).
    const code = isExpectedError(error) ? error.code : "internal.unexpected";
    if (!recorded || code === "app.conflict") {
      await keepAuditEvent(
        env,
        db,
        callEntry(record, {
          access,
          calledVersion: version,
          outcome: "refused",
          reason: code,
        })
      );
    }
    await carryRestricted();
    throw error;
  }
  await carryRestricted();
  // The host ran exactly `version` (or refused), so its schema holds.
  return checkedJson(
    answer,
    appCallLimits.answerBytes,
    compiledSchema(`${grant.app}:${version}:${name}:output`, output),
    () => appErrors.create("app.answer_invalid", { version, method: name })
  );
};

/**
 * Another App's exports, as an App's server code holds them:
 * `await this.env.CRM.call(caller, "findCustomers", input)`. Like a
 * connection stub it acts for no one on its own: each call passes the
 * caller of the App method it runs in, and the App's host says who that
 * is, and where the call is within calls between Apps.
 */
export class AppExportBinding extends WorkerEntrypoint<
  Env,
  ExportGrant & { caller: AppId }
> {
  /**
   * Calls export `method` with `input` for `caller`; answers its JSON.
   * (Typed as the App's answers are: RPC's types don't go down `Json`.)
   */
  async call(
    caller: unknown,
    method: unknown,
    input: unknown
  ): Promise<AppAnswer> {
    const { caller: app, ...grant } = this.ctx.props;
    try {
      let known: Awaited<ReturnType<typeof callerOf>>;
      try {
        known = await callerOf(this.env, app, caller);
      } catch (error) {
        // A caller this App isn't running a call of: made up, ended, or
        // another App's. Recorded by the App the stub is its, as nobody
        // else is known: no person, no version.
        await keepAuditEvent(this.env, drizzle(this.env.DB), {
          actor: { type: "app", appId: app, part: "server" },
          action: "app.call",
          target: { type: "app", id: grant.app },
          detail: {
            method: recordedName(method),
            version: null,
            person: null,
            depth: null,
            outcome: "refused",
            reason: isExpectedError(error) ? error.code : "internal.unexpected",
          },
        });
        throw error;
      }
      const { authority, idempotencyKey, attempt, path } = known;
      return await callExport(
        this.env,
        {
          authority,
          idempotencyKey,
          attempt,
          path,
          actor: delegateActorOf(authority),
        },
        grant,
        method,
        input
      );
    } catch (error) {
      throw forSandbox(error);
    }
  }
}
