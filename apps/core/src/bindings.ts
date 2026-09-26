import { signCapability } from "@grasp-os/shared/capability";
import { connectCallSchema, connectErrors } from "@grasp-os/shared/connect";
import type { ConnectCall, ConnectResult } from "@grasp-os/shared/connect";
import { isExpectedError, toOpaqueError } from "@grasp-os/shared/errors";
import type { PermissionId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { bindingNameSchema } from "@grasp-os/shared/permissions";
import type { Authority, PermissionObject } from "@grasp-os/shared/permissions";
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
 * `context`: checks the permission (only `permissionId`, when given) and
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
  permissionId?: PermissionId
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

interface ConnectionBindingProps {
  authority: Authority;
  context: WorkContext;
  /** The permission the stub was built from: only it counts on each call. */
  permissionId: PermissionId;
  connection: ConnectionObject;
}

/** A connection, as an App or agent holds it: `await env.OUTLOOK.call(...)`. */
export class ConnectionBinding extends WorkerEntrypoint<
  Env,
  ConnectionBindingProps
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
    const { authority, context, permissionId, connection } = this.ctx.props;
    const call = stubCallSchema.safeParse([action, input, options]);
    if (!call.success) {
      throw connectErrors.create("connect.invalid_call");
    }
    const [checkedAction, checkedInput, checkedOptions] = call.data;
    try {
      return await callConnection(
        this.env,
        authority,
        context,
        connection,
        {
          action: checkedAction,
          input: checkedInput,
          idempotencyKey: checkedOptions?.idempotencyKey,
        },
        permissionId
      );
    } catch (error) {
      throw forSandbox(error);
    }
  }
}

/**
 * The env for one authority working in `context`, built from the
 * permission records as they are now: one stub per active permission,
 * under the permission's binding name. Every stub acts for
 * `authority.onBehalfOf`, and keeps its restricted mode in `context`.
 * Throws `permission.person_inactive` when that person has left.
 *
 * That fits a workflow run, which acts for one person: the dispatcher
 * builds it on every start and resume, so a revoked permission is gone from
 * the next one. It doesn't fit an App as is: one App object serves everyone
 * using the App, so an env built once per load would act for whoever loaded
 * it. The App sandbox has to take the person from the host on each call (or
 * give App authority no person); that design is the sandbox's.
 *
 * Workflows get their stubs with the workflow dispatcher; until then
 * nothing reaches them.
 */
export const bindingsFor = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<
  Record<string, Fetcher<ConnectionBinding> | Fetcher<CollectionBinding>>
> => {
  const bindings: Record<
    string,
    Fetcher<ConnectionBinding> | Fetcher<CollectionBinding>
  > = {};
  for (const { id, binding, object } of await grantedPermissions(
    env,
    authority
  )) {
    const name = bindingNameSchema.parse(binding);
    const props = { authority, context, permissionId: id };
    if (object.type === "connection") {
      bindings[name] = exports.ConnectionBinding({
        props: { ...props, connection: object },
      });
    } else if (object.type === "collection") {
      bindings[name] = exports.CollectionBinding({
        props: { ...props, collectionId: object.collectionId },
      });
    }
  }
  return bindings;
};
