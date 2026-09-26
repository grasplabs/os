import type { AppId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { callApp } from "../app.ts";
import type { AppAnswer } from "../app.ts";
import { forSandbox } from "../bindings.ts";
import { requireActivePerson } from "../permissions.ts";

/**
 * A run's own App, as its workflow code holds it: `await
 * env.APP.call("setStatus", invoice, "booked")` calls a method of the
 * App's server code for the person the run acts for, in workflow mode.
 * Within one App no permission is needed, but the person must still be
 * there. The answer is plain data (`callApp`), and whatever it holds of
 * the App's data is covered by the run's restricted mode, which is the
 * App's (restricted.ts).
 */
export class RunAppBinding extends WorkerEntrypoint<
  Env,
  { app: AppId; authority: Authority }
> {
  async call(method: unknown, ...args: unknown[]): Promise<AppAnswer> {
    const { app, authority } = this.ctx.props;
    try {
      await requireActivePerson(this.env, authority);
      return await callApp(
        this.env,
        app,
        { userId: authority.onBehalfOf, mode: "workflow" },
        String(method),
        args
      );
    } catch (error) {
      throw forSandbox(error);
    }
  }
}
