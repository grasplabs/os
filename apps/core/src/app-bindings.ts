import { appErrors } from "@grasp-os/shared/apps";
import type { ConnectResult } from "@grasp-os/shared/connect";
import type { AppId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import type { StatisticUse } from "@grasp-os/shared/statistics";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import type { AppExportBinding } from "./app-calls.ts";
import type { CallPath } from "./app.ts";
import {
  collectionGrantOf,
  connectionGrantOf,
  exportGrantOf,
  requireStepKey,
  runStubCall,
  stubsOf,
} from "./bindings.ts";
import type { ConnectionGrant } from "./bindings.ts";
import { appHost } from "./durable-objects.ts";
import type { AppCollectionBinding } from "./knowledge/app-binding.ts";
import { activePermissions } from "./permissions.ts";
import type { AppStatisticsBinding } from "./statistics-binding.ts";

/** What App code passes as the caller: the one its method was called with. */
const callerSchema = z.object({ token: z.string().min(1).max(100) });

/**
 * Who `caller` is, as App `app`'s host knows them while their call runs,
 * that call's step key, for a workflow run's caller, where the call is
 * within calls between Apps, and the App method it calls. App code can't
 * name anyone: a caller that
 * isn't one of a running call of this App (made up, ended, or another
 * App's) is `app.caller_invalid`.
 */
export const callerOf = async (
  env: Env,
  app: AppId,
  caller: unknown
): Promise<{
  authority: Authority;
  idempotencyKey: string | undefined;
  path: CallPath;
  method: string;
}> => {
  const parsed = callerSchema.safeParse(caller);
  if (!parsed.success) {
    throw appErrors.create("app.caller_invalid");
  }
  return await appHost(env, app).callerOf(parsed.data.token);
};

/**
 * Who `caller` is, as `callerOf` says, counting one statistics `use` (a
 * point or a read) of their call against its bounds
 * (`App.claimStatistic`): `statistics.rate_limited` past a bound.
 */
export const statisticCallerOf = async (
  env: Env,
  app: AppId,
  caller: unknown,
  use: StatisticUse
): Promise<{ authority: Authority }> => {
  const parsed = callerSchema.safeParse(caller);
  if (!parsed.success) {
    throw appErrors.create("app.caller_invalid");
  }
  return await appHost(env, app).claimStatistic(parsed.data.token, use);
};

/**
 * Who `caller` is, as `callerOf` says, to audit a statistics read of
 * theirs refused past its bounds: undefined once one was audited in the
 * App's minute (`App.limitedReadAudit`).
 */
export const limitedReadCallerOf = async (
  env: Env,
  app: AppId,
  caller: unknown
): Promise<{ authority: Authority } | undefined> => {
  const parsed = callerSchema.safeParse(caller);
  if (!parsed.success) {
    return undefined;
  }
  return await appHost(env, app).limitedReadAudit(parsed.data.token);
};

/**
 * A connection, as an App's server code holds it:
 * `await this.env.OUTLOOK.call(caller, action, input)`. One App serves
 * everyone using it, so the stub acts for no one on its own: each call
 * passes the caller of the App method it runs in, and the App's host says
 * who that is, while that method runs (see app.ts). App code can't name
 * anyone else. For a workflow run's caller, the only key a call takes is
 * the one on the caller (`caller.idempotencyKey`, its step's), as for the
 * run's own connection calls.
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
    return await runStubCall(
      this.env,
      async (key) => {
        const { authority, idempotencyKey } = await callerOf(
          this.env,
          app,
          caller
        );
        if (authority.mode === "workflow") {
          requireStepKey(key, idempotencyKey);
        }
        return authority;
      },
      grant,
      [action, input, options]
    );
  }
}

/** A stub an App's server code holds. */
type AppStub =
  | Fetcher<AppConnectionBinding>
  | Fetcher<AppCollectionBinding>
  | Fetcher<AppExportBinding>
  | Fetcher<AppStatisticsBinding>;

/**
 * The env of an App's server code, built from the App's permission
 * records as they are now: its connections, the collections it may read,
 * the other Apps whose exports it may call, and the platform's statistics
 * if it may read them; and its own statistics (`STATISTICS`), which every
 * App has. Its stubs act for no one person:
 * each call passes its caller.
 */
export const appBindings = async (
  env: Env,
  app: AppId
): Promise<Record<string, AppStub>> => {
  const context = { type: "app", appId: app } as const;
  const connectionOf = connectionGrantOf(context);
  const collectionOf = collectionGrantOf(context);
  const granted = stubsOf<AppStub>(
    await activePermissions(env, { type: "app", appId: app }),
    (permission) => {
      const connection = connectionOf(permission);
      if (connection !== undefined) {
        return exports.AppConnectionBinding({ props: { ...connection, app } });
      }
      const exported = exportGrantOf(permission);
      if (exported !== undefined) {
        return exports.AppExportBinding({
          props: { ...exported, caller: app },
        });
      }
      if (permission.object.type === "platform") {
        return exports.AppStatisticsBinding({
          props: { app, permissionId: permission.id },
        });
      }
      const collection = collectionOf(permission);
      return collection === undefined
        ? undefined
        : exports.AppCollectionBinding({ props: { ...collection, app } });
    }
  );
  // A platform binding name: no permission's stub has it.
  return {
    ...granted,
    STATISTICS: exports.AppStatisticsBinding({ props: { app } }),
  };
};
