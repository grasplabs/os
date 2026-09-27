import type { ScreenRun } from "@grasp-os/shared/screens";
import type { RunStatus, WorkflowRun } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { toScreenRun } from "../src/workflows/screen-runs.ts";
import { allEvents } from "./audit-events.ts";
import { approvalApp, week } from "./decisions.ts";
import type { Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import {
  endLiveRuns,
  finished,
  listening as waitsForEvent,
  sleeping,
} from "./runs.ts";
import { openRpc, outcome, signedInApi, signedInWithRole } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// An App's screens and its workflows, together: a screen starts a run of
// its App's workflow, follows it, and answers its decisions, for the
// person using it. The ways this could go wrong, tried below: a screen
// reaching another App's runs or decisions (whatever the person may do
// there), someone without a role in the App starting or reading runs, a
// decision answered through a screen by someone its rules leave out (not
// who it is from, or the run's starter), what workflow code wrote in a
// decision's description reaching someone who may neither answer it nor
// see the run's details, a start or answer on a screen that the audit log
// can't tell from a direct one, and the feature not switching off.

const idp = mockIdp();

const personApi = async (role: "admin" | "builder" | "user") =>
  await signedInApi(idp, role);

/**
 * `value` as whatever a call takes: what a page made to pass on anything
 * can send, which core must refuse.
 */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; Cap'n Web checks no types, so core must.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** The approval workflow's input: a decision any admin answers, for a week. */
const byAdmins = { from: "role:admin", timeout: week };

/** The run, as `person` sees it on a screen of `app`, once it waits. */
const waiting = async (
  person: Person,
  app: string,
  run: string
): Promise<ScreenRun> =>
  await vi.waitFor(
    async () => {
      const found = await person.api.screens.run(app, run);
      if (found.status !== "waiting") {
        throw new Error(`The run is ${found.status}`);
      }
      return found;
    },
    { timeout: 20_000, interval: 100 }
  );

describe("workflows from screens", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("start a run, show it waiting for its decision, and take the answer of someone it is from", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const app = await approvalApp(builder);

    const { id: run } = await builder.api.screens.startRun(
      app,
      "approval",
      byAdmins
    );
    await waiting(builder, app, run);
    const whileWaiting = {
      run: await builder.api.screens.run(app, run),
      runs: await admin.api.screens.runs(app, "approval"),
      // The run's starter doesn't answer a decision of all admins (#87).
      starter: await outcome(
        builder.api.screens.decide(app, run, "review", { approved: true })
      ),
    };
    const answered = await admin.api.screens.decide(app, run, "review", {
      approved: true,
      payload: { comment: "Matches the PO" },
    });
    await finished(run);
    const events = await allEvents();
    const started = events.find(
      ({ action, target }) =>
        action === "workflow.run.started" && target?.id === run
    );
    const approved = events.find(
      ({ action, detail }) =>
        action === "workflow.decision.approved" && detail.run === run
    );

    expect({
      started: { actor: started?.actor, via: started?.detail.via },
      approved: { actor: approved?.actor, via: approved?.detail.via },
      whileWaiting,
      answered: answered.status,
      after: await builder.api.screens.run(app, run),
      runs: await builder.api.screens.runs(app, "approval"),
    }).toMatchObject({
      // Audited under who they were for, and that a screen did it.
      started: {
        actor: { type: "person", userId: builder.userId },
        via: "screen",
      },
      approved: {
        actor: { type: "person", userId: admin.userId },
        via: "screen",
      },
      whileWaiting: {
        run: {
          id: run,
          status: "waiting",
          waitingFor: [{ name: "review", description: "Approve the invoice" }],
        },
        runs: [
          { id: run, status: "waiting", waitingFor: [{ name: "review" }] },
        ],
        starter: "decision.forbidden",
      },
      answered: "approved",
      after: {
        status: "completed",
        waitingFor: [],
        output: {
          approved: true,
          by: admin.userId,
          payload: { comment: "Matches the PO" },
        },
      },
      runs: [{ id: run, status: "completed", waitingFor: [] }],
    });
  });

  it("let someone the App is shared with as a user start runs, and only those its decisions are from answer", async () => {
    const builder = await personApi("builder");
    const user = await personApi("user");
    const other = await personApi("user");
    const app = await approvalApp(builder);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });

    const run = await user.api.screens.startRun(app, "approval", {
      from: `person:${builder.userId}`,
      timeout: week,
    });
    await waiting(user, app, run.id);
    // A second run, whose decision asks `other`: listing both takes the
    // answers of more than one set of deciders at once.
    const second = await builder.api.screens.startRun(app, "approval", {
      from: `person:${other.userId}`,
      timeout: week,
    });
    await waiting(builder, app, second.id);
    /** Each run's description, as `person` sees it listed and on its own. */
    const descriptions = async (person: Person) => {
      const listed = await person.api.screens.runs(app, "approval");
      return await Promise.all(
        [run.id, second.id].map(async (id) => {
          const found = await person.api.screens.run(app, id);
          const inList = listed.find((each) => each.id === id);
          return [inList?.waitingFor, found.waitingFor].map((decisions) =>
            decisions?.map(({ description }) => description ?? "(hidden)")
          );
        })
      );
    };
    // A run's starter sees its details, the person its decision asks may
    // answer it; anyone else sees only that it waits, and until when.
    const seen = {
      starter: await descriptions(user),
      named: await descriptions(builder),
      other: await descriptions(other),
    };
    const shown = [["Approve the invoice"], ["Approve the invoice"]];
    const hidden = [["(hidden)"], ["(hidden)"]];

    expect({
      seen,
      other: await outcome(
        other.api.screens.decide(app, run.id, "review", { approved: true })
      ),
      starter: await outcome(
        user.api.screens.decide(app, run.id, "review", { approved: true })
      ),
      named: await outcome(
        builder.api.screens.decide(app, run.id, "review", { approved: false })
      ),
      again: await outcome(
        builder.api.screens.decide(app, run.id, "review", { approved: true })
      ),
    }).toStrictEqual({
      seen: {
        // Started the first; neither started nor asked by the second.
        starter: [shown, hidden],
        // Asked by the first; started the second.
        named: [shown, shown],
        // Asked by the second only.
        other: [hidden, shown],
      },
      other: "decision.forbidden",
      starter: "decision.forbidden",
      named: "ok",
      again: "decision.closed",
    });
  });

  it("never reach another App's runs or decisions, whatever the person may do there", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const [app, elsewhere] = await Promise.all([
      approvalApp(builder),
      approvalApp(builder),
    ]);
    const run = await builder.api.screens.startRun(
      elsewhere,
      "approval",
      byAdmins
    );
    await waiting(admin, elsewhere, run.id);

    expect({
      run: await outcome(admin.api.screens.run(app, run.id)),
      decide: await outcome(
        admin.api.screens.decide(app, run.id, "review", { approved: true })
      ),
      runs: await admin.api.screens.runs(app, "approval"),
      // Nor a decision the run doesn't have, or a name that isn't one.
      unknown: await outcome(
        admin.api.screens.decide(elsewhere, run.id, "other", {
          approved: true,
        })
      ),
      invalid: await outcome(
        admin.api.screens.decide(elsewhere, run.id, unchecked(7), {
          approved: true,
        })
      ),
      invalidRun: await outcome(
        admin.api.screens.run(elsewhere, unchecked({ id: run.id }))
      ),
      // Still waiting: nothing above answered it.
      stillWaiting: await admin.api.screens
        .run(elsewhere, run.id)
        .then(({ status }) => status),
    }).toStrictEqual({
      run: "workflow.run_not_found",
      decide: "decision.not_found",
      runs: [],
      unknown: "decision.not_found",
      invalid: "decision.invalid",
      invalidRun: "workflow.invalid",
      stillWaiting: "waiting",
    });
  });

  it("show a run that sleeps or waits for an event as running, in the list and on its own, and list only the workflow asked for", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      ...workflowFiles(
        "napping",
        `  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  return 1;`
      ),
      ...workflowFiles(
        "listening",
        `  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return 1;`
      ),
    });
    const napping = await builder.api.screens.startRun(app, "napping");
    const listening = await builder.api.screens.startRun(app, "listening");
    await sleeping(napping.id, "nap");
    await waitsForEvent(listening.id, "go");
    const seen = async (workflow: string, run: string) => ({
      listed: await builder.api.screens
        .runs(app, workflow)
        .then((runs) =>
          runs.map(({ id, status, waitingFor }) => ({ id, status, waitingFor }))
        ),
      run: await builder.api.screens
        .run(app, run)
        .then(({ status, waitingFor }) => ({ status, waitingFor })),
    });

    expect({
      napping: await seen("napping", napping.id),
      listening: await seen("listening", listening.id),
    }).toStrictEqual({
      napping: {
        listed: [{ id: napping.id, status: "running", waitingFor: [] }],
        run: { status: "running", waitingFor: [] },
      },
      listening: {
        listed: [{ id: listening.id, status: "running", waitingFor: [] }],
        run: { status: "running", waitingFor: [] },
      },
    });
  });

  it("refuse someone without a role in the App, as if it weren't there", async () => {
    const builder = await personApi("builder");
    const stranger = await personApi("builder");
    const app = await approvalApp(builder);
    const run = await builder.api.screens.startRun(app, "approval", byAdmins);
    await waiting(builder, app, run.id);

    expect({
      start: await outcome(
        stranger.api.screens.startRun(app, "approval", byAdmins)
      ),
      runs: await outcome(stranger.api.screens.runs(app, "approval")),
      run: await outcome(stranger.api.screens.run(app, run.id)),
      decide: await outcome(
        stranger.api.screens.decide(app, run.id, "review", { approved: true })
      ),
    }).toStrictEqual({
      start: "app.not_found",
      runs: "app.not_found",
      run: "app.not_found",
      decide: "app.not_found",
    });
  });

  it("switch off with screen_workflows, and leave the rest of screens on", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        FEATURES: {
          apps: true,
          screens: true,
          workflows: true,
          decisions: true,
        },
      },
    });
    const session = core.authenticate();
    const app = crypto.randomUUID();

    expect({
      start: await outcome(session.screens.startRun(app, "approval")),
      runs: await outcome(session.screens.runs(app, "approval")),
      run: await outcome(session.screens.run(app, "run")),
      decide: await outcome(
        session.screens.decide(app, "run", "review", { approved: true })
      ),
      watch: await outcome(
        session.screens.watchRuns(app, "approval", () => {
          // Never called.
        })
      ),
      version: await outcome(session.screens.version(app)),
    }).toStrictEqual({
      start: "feature.disabled",
      runs: "feature.disabled",
      run: "feature.disabled",
      decide: "feature.disabled",
      watch: "feature.disabled",
      // Past the flags: there's no such App.
      version: "app.not_found",
    });
  });

  it("refuse to answer on a screen while decisions are off, and leave following runs on", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const { core } = await openRpc(admin.session, {
      coreEnv: {
        ...env,
        FEATURES: {
          apps: true,
          screens: true,
          workflows: true,
          screen_workflows: true,
          decisions: false,
        },
      },
    });
    const session = core.authenticate();
    const app = crypto.randomUUID();

    expect({
      decide: await outcome(
        session.screens.decide(app, "run", "review", { approved: true })
      ),
      runs: await outcome(session.screens.runs(app, "approval")),
    }).toStrictEqual({
      decide: "feature.disabled",
      // Past the flags: there's no such App.
      runs: "app.not_found",
    });
  });
});

// Where a screen shows a run, from where core has it and the decisions it
// waits for: pure logic, and the one place both `run` and `runs` go
// through. The local engine never reports `waiting`, which Cloudflare
// Workflows does for a run that sleeps or waits for an event.
describe(toScreenRun, () => {
  const run = (status: RunStatus): WorkflowRun => ({
    id: unchecked("run"),
    app: unchecked("app"),
    workflow: unchecked("approval"),
    version: 1,
    startedBy: { type: "trigger" },
    status,
    createdAt: "2026-09-27T00:00:00.000Z",
    endedAt: null,
  });
  const review = { name: "review", expiresAt: "2026-10-04T00:00:00.000Z" };
  const shown = (status: RunStatus, decisions: (typeof review)[]) => {
    const { status: showing, waitingFor } = toScreenRun(run(status), decisions);
    return `${showing} ${waitingFor.length}`;
  };

  it("shows waiting exactly while a decision is open, and an ended run waiting for nothing", () => {
    expect({
      running: shown("running", []),
      engineWaiting: shown("waiting", []),
      runningWithDecision: shown("running", [review]),
      engineWaitingWithDecision: shown("waiting", [review]),
      paused: shown("paused", [review]),
      completed: shown("completed", [review]),
      failed: shown("failed", [review]),
      cancelled: shown("cancelled", [review]),
    }).toStrictEqual({
      running: "running 0",
      engineWaiting: "running 0",
      runningWithDecision: "waiting 1",
      engineWaitingWithDecision: "waiting 1",
      paused: "paused 1",
      completed: "completed 0",
      failed: "failed 0",
      cancelled: "cancelled 0",
    });
  });
});
