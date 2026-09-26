import { signCapability } from "@grasp-os/shared/capability";
import { connectCallSchema, connectErrors } from "@grasp-os/shared/connect";
import type { ConnectCall, ConnectResult } from "@grasp-os/shared/connect";
import { isExpectedError, toOpaqueError } from "@grasp-os/shared/errors";
import type { PermissionId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { bindingNameSchema } from "@grasp-os/shared/permissions";
import type {
  Authority,
  Permission,
  PermissionObject,
} from "@grasp-os/shared/permissions";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import type { CollectionBinding } from "./knowledge/binding.ts";
import { authorize, grantedPermissions } from "./permissions.ts";
import { requireUnrestricted } from "./restricted.ts";
import type { WorkContext } from "./restricted.ts";

// What Apps and agents get in their env: one stub per granted permission,
// and nothing else. Each stub is a loopback entrypoint of core whose props
// core sets when it builds the env; the code holding the stub can call its
// methods but can't read or change its props. So who is calling, and for
// whom, comes from core, and every call is checked against the permission
// records again: revoking a permission stops the stubs already handed out.

type ConnectionObject = Extract<PermissionObject, { type: "connection" }>;

/**
 * Calls an action on a connection for an App or agent working in
 * `context`: checks its permission, `permissionId`, and
 * that `context` isn't in restricted mode, then signs the capability
 * connect needs for exactly this call. Core makes capabilities here and
 * nowhere else, and nothing outside core reaches this function.
 */
export const callConnection = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  connection: ConnectionObject,
  {
    action,
    input,
    idempotencyKey,
  }: Pick<ConnectCall, "action" | "input" | "idempotencyKey">,
  permissionId: PermissionId
): Promise<ConnectResult> => {
  await authorize(env, authority, connection, action, permissionId);
  await requireUnrestricted(env, authority, context);
  const scope = {
    connectionId: connection.connectionId,
    resource: connection.resource,
    action,
    idempotencyKey,
  };
  const capability = await signCapability(
    env.CAPABILITY_SIGNING_KEY,
    authority,
    scope
  );
  return await env.CONNECT.call({ capability, ...scope, input });
};

/**
 * What an error looks like inside a sandbox: expected refusals as they are,
 * anything else replaced, so no internals reach App or agent code.
 */
export const forSandbox = (error: unknown): Error => {
  if (!isExpectedError(error)) {
    log.error("binding.failed", errorFields(error));
  }
  return toOpaqueError(error);
};

/** What App or agent code passes to a connection stub; the rest is core's. */
const stubCallSchema = z.tuple([
  connectCallSchema.shape.action,
  connectCallSchema.shape.input,
  z
    .strictObject({ idempotencyKey: connectCallSchema.shape.idempotencyKey })
    .optional(),
]);

/** A connection permission, as a stub holds it, and where it works. */
export interface ConnectionGrant {
  context: WorkContext;
  /** The permission the stub was built from: only it counts on each call. */
  permissionId: PermissionId;
  connection: ConnectionObject;
}

/**
 * Refuses a workflow's connection call with a key other than its step's
 * (`stepKey`; none outside a step): core, not workflow or App code, holds
 * the key to a workflow's side effects, so a retry, a replay or another
 * run can't repeat or reuse one with a key of its own making. No key is
 * fine: a read needs none, and connect refuses a side effect without one.
 */
export const requireStepKey = (
  key: string | undefined,
  stepKey: string | undefined
): void => {
  if (key !== undefined && key !== stepKey) {
    throw workflowErrors.create("workflow.idempotency_key_invalid");
  }
};

/**
 * Runs one stub call for `authority` (or for whoever it resolves to, given
 * the call's idempotency key, which the resolver may refuse), with errors
 * as the sandbox sees them.
 */
export const runStubCall = async (
  env: Env,
  authority: Authority | ((key: string | undefined) => Promise<Authority>),
  { context, permissionId, connection }: ConnectionGrant,
  call: unknown[]
): Promise<ConnectResult> => {
  const parsed = stubCallSchema.safeParse(call);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid_call");
  }
  const [action, input, options] = parsed.data;
  try {
    return await callConnection(
      env,
      typeof authority === "function"
        ? await authority(options?.idempotencyKey)
        : authority,
      context,
      connection,
      { action, input, idempotencyKey: options?.idempotencyKey },
      permissionId
    );
  } catch (error) {
    throw forSandbox(error);
  }
};

/**
 * A connection, as an agent holds it:
 * `await env.OUTLOOK.call(...)`. It acts for the one person in its props.
 */
export class ConnectionBinding extends WorkerEntrypoint<
  Env,
  ConnectionGrant & { authority: Authority }
> {
  /**
   * Runs one of the connection's actions. A side effect needs an
   * `idempotencyKey`: repeating the call with it returns the first result.
   */
  async call(
    action: unknown,
    input: unknown,
    options?: unknown
  ): Promise<ConnectResult> {
    const { authority, ...grant } = this.ctx.props;
    return await runStubCall(this.env, authority, grant, [
      action,
      input,
      options,
    ]);
  }
}

/**
 * One stub per active permission `stubOf` makes one for, under the
 * permission's binding name. A name that is no longer valid (say, one the
 * platform took for itself since) is left out and logged, so the rest
 * still work.
 */
export const stubsOf = <Stub>(
  permissions: Permission[],
  stubOf: (permission: Permission) => Stub | undefined
): Record<string, Stub> => {
  const stubs: Record<string, Stub> = {};
  for (const permission of permissions) {
    const { id, binding } = permission;
    if (bindingNameSchema.safeParse(binding).success) {
      const stub = stubOf(permission);
      if (stub !== undefined) {
        stubs[binding] = stub;
      }
    } else {
      log.warn("binding.name_invalid", { permissionId: id, binding });
    }
  }
  return stubs;
};

/** A connection permission as its grant in `context`; nothing for any other. */
const connectionGrantOf =
  (context: WorkContext) =>
  ({ id, object }: Permission): ConnectionGrant | undefined =>
    object.type === "connection"
      ? { context, permissionId: id, connection: object }
      : undefined;

/** A collection permission's stub; nothing for any other. */
const collectionStubOf =
  (authority: Authority, context: WorkContext) =>
  ({ id, object }: Permission): Fetcher<CollectionBinding> | undefined =>
    object.type === "collection"
      ? exports.CollectionBinding({
          props: {
            authority,
            context,
            permissionId: id,
            collectionId: object.collectionId,
          },
        })
      : undefined;

/**
 * The env for one authority working in `context`, built from the
 * permission records as they are now, every stub acting for
 * `authority.onBehalfOf` and keeping its restricted mode in `context`.
 * Throws `permission.person_inactive` when that person has left.
 *
 * That fits an agent, which acts for one person. A workflow run gets
 * `runBindingsFor`, and an App, which serves many people at once,
 * `appBindings`.
 */
export const bindingsFor = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<
  Record<string, Fetcher<ConnectionBinding> | Fetcher<CollectionBinding>>
> => {
  const grantOf = connectionGrantOf(context);
  const collectionOf = collectionStubOf(authority, context);
  return stubsOf<Fetcher<ConnectionBinding> | Fetcher<CollectionBinding>>(
    await grantedPermissions(env, authority),
    (permission) => {
      const grant = grantOf(permission);
      return grant === undefined
        ? collectionOf(permission)
        : exports.ConnectionBinding({ props: { ...grant, authority } });
    }
  );
};

/**
 * A workflow run's permissions as they are now, as `bindingsFor` builds
 * them, but for its connections: those aren't stubs in its env but grants,
 * by binding name, which the run's host calls for it (workflows/host.ts),
 * so each call is checked against the step running then and its key. The
 * workflow dispatcher builds them on every start and resume, so a revoked
 * permission is gone from the next one.
 */
export const runBindingsFor = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<{
  bindings: Record<string, Fetcher<CollectionBinding>>;
  connections: Record<string, ConnectionGrant>;
}> => {
  const permissions = await grantedPermissions(env, authority);
  return {
    bindings: stubsOf(permissions, collectionStubOf(authority, context)),
    connections: stubsOf(permissions, connectionGrantOf(context)),
  };
};
