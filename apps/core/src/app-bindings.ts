import { appErrors } from "@grasp-os/shared/apps";
import type { ConnectResult } from "@grasp-os/shared/connect";
import type { AppId } from "@grasp-os/shared/ids";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import { runStubCall, stubsOf } from "./bindings.ts";
import type { ConnectionGrant } from "./bindings.ts";
import { appHost } from "./durable-objects.ts";
import { activePermissions } from "./permissions.ts";

/** What App code passes as the caller: the one its method was called with. */
const callerSchema = z.object({ token: z.string().min(1).max(100) });

/**
 * A connection, as an App's server code holds it:
 * `await this.env.OUTLOOK.call(caller, action, input)`. One App serves
 * everyone using it, so the stub acts for no one on its own: each call
 * passes the caller of the App method it runs in, and the App's host says
 * who that is, while that method runs (see app.ts). App code can't name
 * anyone else.
 */
export class AppConnectionBinding extends WorkerEntrypoint<
  Env,
  ConnectionGrant & { app: AppId }
> {
  /** Runs one of the connection's actions for `caller`, as `ConnectionBinding` does. */
  async call(
    caller: unknown,
    action: unknown,
    input: unknown,
    options?: unknown
  ): Promise<ConnectResult> {
    const { app, ...grant } = this.ctx.props;
    const parsed = callerSchema.safeParse(caller);
    if (!parsed.success) {
      throw appErrors.create("app.caller_invalid");
    }
    return await runStubCall(
      this.env,
      async () => await appHost(this.env, app).authorityOf(parsed.data.token),
      grant,
      [action, input, options]
    );
  }
}

/**
 * The env of an App's server code, built from the App's permission
 * records as they are now. Its stubs act for no one person: each call
 * passes its caller (`AppConnectionBinding`).
 */
export const appBindings = async (
  env: Env,
  app: AppId
): Promise<Record<string, Fetcher<AppConnectionBinding>>> =>
  stubsOf(
    await activePermissions(env, { type: "app", appId: app }),
    ({ id, object }) =>
      object.type === "connection"
        ? exports.AppConnectionBinding({
            props: {
              app,
              context: { type: "app", appId: app },
              permissionId: id,
              connection: object,
            },
          })
        : undefined
  );
