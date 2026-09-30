import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import type { StatisticAnswer } from "@grasp-os/shared/statistics";
import { statisticErrors } from "@grasp-os/shared/statistics";
import { WorkerEntrypoint } from "cloudflare:workers";

import { limitedReadCallerOf, statisticCallerOf } from "./app-bindings.ts";
import { forSandbox } from "./bindings.ts";
import {
  auditPlatformRead,
  platformReadOf,
  readStatistics,
  recordStatistic,
} from "./statistics.ts";

/**
 * The App's statistics, as its server code holds them:
 * `await this.env.STATISTICS.record(caller, { measure, value, dimensions })`
 * and `.read(caller, query)` (statistics.ts). Every App has `STATISTICS`,
 * with no permission, for its own measures. The stub of a permission an
 * admin granted it on the platform's statistics (`{ type: "platform" }`,
 * `permissionId`), under that permission's name, reads the platform's
 * measures too, only of Apps whose runs the caller may see. Like every
 * stub, it passes the caller of the App method it runs in, and acts only
 * while that call runs; points and reads count against the call's and
 * the App's minute's bounds (`statisticCallerOf`). A point recorded for a
 * workflow run's step is added up when the step completes, once however
 * often the step runs, and isn't read before (`recordStatistic`).
 */
export class AppStatisticsBinding extends WorkerEntrypoint<
  Env,
  { app: AppId; permissionId?: PermissionId }
> {
  /** Records one point of the App's own measure. */
  async record(caller: unknown, point: unknown): Promise<void> {
    const { app } = this.ctx.props;
    try {
      const { idempotencyKey, attempt } = await statisticCallerOf(
        this.env,
        app,
        caller,
        "point"
      );
      // A workflow run's step: kept with its attempt, and added up when
      // the step completes.
      await recordStatistic(this.env, app, point, {
        step:
          idempotencyKey === undefined || attempt === undefined
            ? undefined
            : { key: idempotencyKey, attempt },
      });
    } catch (error) {
      throw forSandbox(error);
    }
  }

  /**
   * Reads a measure of its own, or one the platform publishes. A platform
   * read refused past its bounds is audited too, once a minute for the App.
   */
  async read(caller: unknown, query: unknown): Promise<StatisticAnswer> {
    const { app, permissionId } = this.ctx.props;
    try {
      const { authority } = await statisticCallerOf(
        this.env,
        app,
        caller,
        "read"
      ).catch(async (error: unknown) => {
        await this.#auditLimited(caller, query, error);
        throw error;
      });
      return await readStatistics(this.env, authority, query, permissionId);
    } catch (error) {
      throw forSandbox(error);
    }
  }

  /** Audits a platform read `query` refused past its bounds (`error`). */
  async #auditLimited(
    caller: unknown,
    query: unknown,
    error: unknown
  ): Promise<void> {
    const read = platformReadOf(query);
    if (
      read === undefined ||
      statisticErrors.codeOf(error) !== "statistics.rate_limited"
    ) {
      return;
    }
    const resolved = await limitedReadCallerOf(
      this.env,
      this.ctx.props.app,
      caller
    );
    if (resolved !== undefined) {
      await auditPlatformRead(
        this.env,
        resolved.authority,
        read,
        "statistics.rate_limited"
      );
    }
  }
}
