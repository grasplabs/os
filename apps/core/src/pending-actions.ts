import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectResult,
  PendingAction,
  PendingActionsApi,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { connectionIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { runOfStepKey } from "@grasp-os/shared/workflows";
import { RpcTarget } from "capnweb";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { signedCall } from "./bindings.ts";
import { personOf } from "./connections.ts";
import { workflowRuns } from "./db/core/schema.ts";
import { isRestricted } from "./restricted.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Side effects that connect holds for their person (threat model R7, R12):
// from chat, from a person using an App, and every one of a context that
// read restricted data; as core shows them to that person and lets them
// decide. Connect keeps the held actions; core names the person from their session, read
// fresh on every call, as it does for connecting accounts. Confirming is
// the one way a held action runs: core checks the App's or agent's
// permission and its context's restricted mode again, as for any call, and
// signs a capability that confirms exactly that action for that person. A
// held action of a context that read restricted data runs on confirmation
// too; the list warns of it, and connect records it on every event.
// Nothing an App or agent holds reaches this: it is only on `/rpc`, behind
// the person's session (CN8).

/** Runs that have ended: none of their steps runs again. */
const endedStatuses: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Whether the workflow run a held action came from has ended (or isn't
 * the App's): its step's key names the run, whichever of its App's code
 * made the call. A paused run hasn't: it may be resumed.
 */
const runEnded = async (env: Env, held: PendingAction): Promise<boolean> => {
  const runId = runOfStepKey(held.idempotencyKey);
  if (runId === undefined || held.subject.type !== "app") {
    return true;
  }
  const run = await drizzle(env.DB)
    .select({ appId: workflowRuns.appId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();
  return (
    run === undefined ||
    run.appId !== held.subject.appId ||
    endedStatuses.has(run.status)
  );
};

/**
 * Runs the held action `id` for the signed-in person it waits for, with
 * the input they were shown (`inputHash`): its answer, as the call would
 * have had it. Refused like any call once the App's or agent's permission
 * is gone, its context is restricted, or the person has left; and by
 * connect for anyone the action doesn't wait for, Grasp staff included,
 * which it records.
 */
export const confirmPendingAction = async (
  env: Env,
  identity: Identity,
  id: unknown,
  inputHash: unknown
): Promise<ConnectResult> => {
  const person = await personOf(env, identity);
  const request = { person, id, inputHash };
  // Connect finds none for staff, and only the person's own.
  const parsedId = z.uuid().safeParse(id);
  const held = parsedId.success
    ? await env.CONNECT.pendingAction({ person, id: parsedId.data })
    : null;
  if (held === null) {
    // Connect refuses it, and records who tried: nothing confirms it.
    return await env.CONNECT.confirmAction({ ...request, capability: null });
  }
  // A run that has ended can't take the answer: its held action goes.
  // Accepted: a run cancelled between this check and connect taking the
  // action still gets it run, as the person confirmed exactly that action,
  // and the window is one request long.
  if (held.mode === "workflow" && (await runEnded(env, held))) {
    await env.CONNECT.dropForEndedRun({ person, id: held.id });
    throw connectErrors.create("connect.run_ended");
  }
  const authority = authoritySchema.parse({
    subject: held.subject,
    onBehalfOf: identity.userId,
    mode: held.mode,
    ...(held.appVersion === null ? {} : { appVersion: held.appVersion }),
  });
  let capability: string;
  try {
    ({ capability } = await signedCall(
      env,
      {
        authority,
        context: held.context,
        connection: {
          type: "connection",
          connectionId: connectionIdSchema.parse(held.connectionId),
          resource: held.resource ?? undefined,
        },
        permissionId: permissionIdSchema.parse(held.permissionId),
      },
      { action: held.action, idempotencyKey: held.idempotencyKey },
      held.id
    ));
  } catch (error) {
    // Refused here (the permission is gone, the person has left, the
    // context is invalid): recorded as connect records its own refusals,
    // and the action keeps waiting.
    await env.CONNECT.refuseConfirmation({
      person,
      id: held.id,
      reason: isExpectedError(error) ? error.code : "internal.unexpected",
    }).catch((auditError: unknown) => {
      log.error("audit.record_failed", errorFields(auditError));
    });
    throw error;
  }
  return await env.CONNECT.confirmAction({ ...request, capability });
};

/** `isRestricted`, or `true` for a context that can no longer be read. */
const restrictedOrUnknown = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<boolean> => {
  try {
    return await isRestricted(env, authority, context);
  } catch {
    return true;
  }
};

/**
 * `waiting`, each marked restricted also when its context has read
 * restricted data since it was held: the person is warned before
 * confirming what would now go out from there. A context that can no
 * longer be read is shown as restricted too. Each context (and the App or
 * agent in it) is looked up once, however many actions it holds.
 */
const withRestricted = async (
  env: Env,
  userId: string,
  waiting: PendingAction[]
): Promise<PendingAction[]> => {
  const lookups = new Map<string, Promise<boolean>>();
  const restrictedNow = async (held: PendingAction): Promise<boolean> => {
    const key = JSON.stringify([held.subject, held.context]);
    let lookup = lookups.get(key);
    if (lookup === undefined) {
      const authority = authoritySchema.parse({
        subject: held.subject,
        onBehalfOf: userId,
        mode: held.mode,
      });
      lookup = restrictedOrUnknown(env, authority, held.context);
      lookups.set(key, lookup);
    }
    return await lookup;
  };
  return await Promise.all(
    waiting.map(async (held) =>
      held.restricted
        ? held
        : { ...held, restricted: await restrictedNow(held) }
    )
  );
};

/** A signed-in person's held actions, over `/rpc`. */
export class PendingActionsRpc extends RpcTarget implements PendingActionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<PendingAction[]> {
    return await withPerson(this.#check, async (person) => {
      if (person.staff) {
        return [];
      }
      const waiting = await this.#env.CONNECT.listPendingActions(
        await personOf(this.#env, person)
      );
      return await withRestricted(this.#env, person.userId, waiting);
    });
  }

  async confirm(id: string, inputHash: string): Promise<ConnectResult> {
    return await withPerson(
      this.#check,
      async (person) =>
        await confirmPendingAction(this.#env, person, id, inputHash)
    );
  }

  async decline(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      // Connect refuses anyone the action doesn't wait for, and records it.
      await this.#env.CONNECT.declineAction({
        person: await personOf(this.#env, person),
        id,
      });
    });
  }
}
