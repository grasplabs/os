import { appErrors } from "@grasp-os/shared/apps";
import { runIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RunFailure } from "@grasp-os/shared/workflows";

import { sourcesOf } from "./app-provenance.ts";
import { appFor } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { detailsRemoved } from "./workflows/retention.ts";
import { findRun, seesDetails } from "./workflows/runs.ts";
import type { RunToFix } from "./workspace.ts";

// Asking the chat's agent to fix a failed run (`fixRun` in chats-rpc.ts),
// from its threat model:
//
// - Who: only whoever sees the run's failure report (`seesDetails`): the
//   person it acted for, and admins, while they can open its App. Anyone
//   else is refused as if there were no such run, so run IDs can't be
//   probed.
// - Injection: the report's message is text the workflow's code wrote,
//   from what the run read (a mail, say): it may say anything. It never
//   goes into the agent's instructions or the question. The question
//   names only the run, its App and its workflow, by ID, and the agent
//   reads the report as a code step's result (`env.chat.attachments()`),
//   as it reads any data, in a field that says whose words they are.
// - Provenance: the report may hold what the run read, so the chat
//   carries, from the start, the run and every source its App may have
//   read as its sources, which the model rules judge each request by; and
//   the App's restricted mode: a report of a restricted App's run starts a
//   restricted chat.
// - The agent's rights: none new. It acts for the person, under its own
//   permissions, as in any chat: it changes the workflow only by proposing
//   a version, which a builder of the App makes current or not
//   (agent-builds.ts).

/** A refusal that says no more than an unknown run's. */
const notFound = () => workflowErrors.create("workflow.run_not_found");

/**
 * The failed run `run`, as a chat of `by`'s may be started to fix it: its
 * report, and what that may hold data from. Refused as not found for a
 * run `by` doesn't see the report of, and one that didn't fail. Refused
 * with `workflow.run_details_removed` for one whose details were removed
 * (workflows/retention.ts), only to who would have seen its report: the
 * message that said why it failed went with them, and the engine has no
 * record of its steps, so a chat would have nothing to go on.
 */
export const runToFix = async (
  env: Env,
  by: Identity,
  run: unknown
): Promise<RunToFix> => {
  const id = runIdSchema.safeParse(run);
  const row = id.success ? await findRun(env, id.data) : undefined;
  if (row === undefined) {
    throw notFound();
  }
  const app = await appFor(env, by, row.appId, "user").catch(
    (error: unknown) => {
      throw appErrors.codeOf(error) === "app.not_found" ||
        roleErrors.codeOf(error) !== undefined
        ? notFound()
        : error;
    }
  );
  if (
    row.status !== "failed" ||
    row.failure === null ||
    !seesDetails(by, row, app.owner)
  ) {
    throw notFound();
  }
  if (detailsRemoved(env, row)) {
    throw workflowErrors.create("workflow.run_details_removed");
  }
  const [sources, restricted] = await Promise.all([
    sourcesOf(env, app.id),
    appHost(env, app.id).isRestricted(),
  ]);
  return {
    report: row.failure,
    sources: [
      ...sources.connections.map(({ id: connection }) => connection),
      ...sources.collections.map(({ id: collection }) => collection),
      // Named `connection:<id>` or `collection:<id>`: the ID alone.
      ...sources.unresolved.map((named) => named.slice(named.indexOf(":") + 1)),
    ],
    restricted,
  };
};

/**
 * The question that asks the agent to fix the run: the platform's words,
 * naming the run, its App and its workflow by ID alone, never anything
 * the workflow wrote.
 */
export const fixQuestion = ({
  run,
  app,
  workflow,
  version,
}: RunFailure): string =>
  `Run ${run} of workflow "${workflow}" in App ${app} (version ${version}) failed. Its failure report is attached to this chat: read it with \`env.chat.attachments()\`. Find out why the run failed, and fix the workflow if you can, by proposing a new version of the App for a builder to review.`;
