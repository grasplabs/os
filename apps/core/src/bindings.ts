import { signCapability } from "@grasp-os/shared/capability";
import { connectCallSchema, connectErrors } from "@grasp-os/shared/connect";
import type { ConnectCall, ConnectResult } from "@grasp-os/shared/connect";
import { internalErrors } from "@grasp-os/shared/errors";
import {
  bindingNameSchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type { Authority, PermissionObject } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import { errorFields, log } from "./log.ts";
import { authorize, grantedPermissions } from "./permissions.ts";

// What Apps and agents get in their env: one stub per granted permission,
// and nothing else. Each stub is a loopback entrypoint of core whose props
// core sets when it builds the env; the code holding the stub can call its
// methods but can't read or change its props. So who is calling, and for
// whom, comes from core, and every call is checked against the permission
// records again: revoking a permission stops the stubs already handed out.

type ConnectionObject = Extract<PermissionObject, { type: "connection" }>;

/**
 * Calls an action on a connection for an App or agent: checks the
 * permission, then signs the capability connect needs for exactly this call.
 * Core makes capabilities here and nowhere else, and nothing outside core
 * reaches this function.
 */
export const callConnection = async (
  env: Env,
  authority: Authority,
  connection: ConnectionObject,
  {
    action,
    input,
    idempotencyKey,
  }: Pick<ConnectCall, "action" | "input" | "idempotencyKey">
): Promise<ConnectResult> => {
  await authorize(env, authority, connection, action);
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
const forSandbox = (error: unknown): Error => {
  const expected =
    permissionErrors.codeOf(error) !== undefined ||
    connectErrors.codeOf(error) !== undefined;
  if (expected && error instanceof Error) {
    return error;
  }
  log.error("binding.failed", errorFields(error));
  const replacement = internalErrors.create("internal.unexpected");
  replacement.stack = undefined;
  return replacement;
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
    const { authority, connection } = this.ctx.props;
    const call = stubCallSchema.safeParse([action, input, options]);
    if (!call.success) {
      throw connectErrors.create("connect.invalid_call");
    }
    const [checkedAction, checkedInput, checkedOptions] = call.data;
    try {
      return await callConnection(this.env, authority, connection, {
        action: checkedAction,
        input: checkedInput,
        idempotencyKey: checkedOptions?.idempotencyKey,
      });
    } catch (error) {
      throw forSandbox(error);
    }
  }
}

/**
 * The env of an App or agent, built from its permission records as they
 * are now: one stub per active permission, under the permission's binding
 * name. App sandboxes build it on every load, and the workflow dispatcher on
 * every start and resume, so a revoked permission is gone from the next one.
 * Throws `permission.person_inactive` when the person it acts for has left.
 *
 * Collections and workflows get their stubs with the Knowledge API and the
 * workflow dispatcher; until then nothing reaches them.
 */
export const bindingsFor = async (
  env: Env,
  authority: Authority
): Promise<Record<string, Fetcher<ConnectionBinding>>> => {
  const bindings: Record<string, Fetcher<ConnectionBinding>> = {};
  for (const { binding, object } of await grantedPermissions(env, authority)) {
    if (object.type === "connection") {
      bindings[bindingNameSchema.parse(binding)] = exports.ConnectionBinding({
        props: { authority, connection: object },
      });
    }
  }
  return bindings;
};
