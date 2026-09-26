import { maxDeciders } from "@grasp-os/shared/decisions";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startRun } from "../src/workflows/runs.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  approvalApp,
  asking,
  asksOf,
  linkOf,
  outputOf,
  reminding,
  week,
} from "./decisions.ts";
import type { Ask, Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { endLiveRuns, finished, resumed, stopped } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  callAuth,
  entraPerson,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  signIn,
  staffPerson,
  unique,
  whoami,
} from "./sign-in.ts";

// `step.decision`, from its threat model (R8, WF1 to WF4): a run waits for
// a person's answer, which only the people the decision is from can give,
// signed in, as they are when they answer, and never the run's starter,
// unless `from` is exactly `person:<them>`. A decision link only leads
// them there. Each case below is a way it could go wrong, most of them on
// purpose: someone else answering, the starter answering their own
// request, two answers, a late one, people who changed since they were
// asked, and workflow code or anyone with the Workflows API trying to
// answer in their place.

const idp = mockIdp();

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const joinTeam = async (
  admin: Person,
  teamId: string,
  person: Person
): Promise<void> => {
  const response = await callAuth(
    "/organization/add-team-member",
    admin.session,
    { teamId, userId: person.userId }
  );
  expect(response.ok).toBeTruthy();
};

const leaveTeam = async (
  admin: Person,
  teamId: string,
  person: Person
): Promise<void> => {
  const response = await callAuth(
    "/organization/remove-team-member",
    admin.session,
    { teamId, userId: person.userId }
  );
  expect(response.ok).toBeTruthy();
};

/** Adds `count` new members to `team`, as the IdP would bring them in. */
const addMembers = async (team: string, count: number): Promise<void> => {
  const now = Date.now();
  const ids = Array.from({ length: count }, () => `member-${unique()}`);
  await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Member', ?, 1, ?, ?)"
      ).bind(id, `${id}@acme.test`, now, now),
      env.DB.prepare(
        "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'user', ?)"
      ).bind(`membership-${id}`, id, now),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(`team-member-${id}`, team, id, now),
    ])
  );
};

/** Whom an ask went to, by user ID. */
const askedTo = (ask: Ask): string[] =>
  ask.recipients.map(({ userId }) => userId);

/** The audit events about `decision`, in log order. */
const eventsOf = async (decision: string) => {
  const events = await allEvents();
  return events.filter(({ target }) => target?.id === decision);
};

describe("decisions", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("wait durably across a restart and go on with the real answer, audited under the person who decided", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { run, ask, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const { link } = linkOf(ask, decider.userId);
    const seen = await decider.api.decisions.get(decision);
    // The run is stopped while it waits, as a deploy or a crash does, and
    // the answer comes in while it's down, days before the deadline.
    await stopped(run.id);
    const answered = await decider.api.decisions.answer(decision, {
      approved: true,
      payload: { comment: "Matches the PO" },
    });
    await resumed(run.id);

    expect({
      recipients: ask.recipients.map(({ userId, email }) => ({
        userId,
        email,
      })),
      // A plain link to the decision: it grants nothing by itself.
      link: { path: link.pathname, search: link.search },
      seen,
      answered,
      output: await outputOf(builder, run.id),
    }).toMatchObject({
      recipients: [{ userId: decider.userId, email: decider.person.email }],
      link: { path: `/decisions/${decision}`, search: "" },
      seen: {
        id: decision,
        run: run.id,
        workflow: "approval",
        description: "Approve the invoice",
        status: "open",
      },
      answered: {
        status: "approved",
        decided: { by: { userId: decider.userId } },
      },
      output: {
        timedOut: false,
        approved: true,
        by: decider.userId,
        payload: { comment: "Matches the PO" },
      },
    });
    const audited = await vi.waitFor(async () => {
      const events = await eventsOf(decision);
      expect(events.map(({ action }) => action)).toContain(
        "workflow.decision.approved"
      );
      return events;
    });
    const [opened, asked, approved] = audited;
    expect({
      actions: audited.map(({ action }) => action),
      openedBy: opened?.actor,
      opened: opened?.detail,
      askedBy: asked?.actor,
      asked: asked?.detail,
      // Whom the ask went to, by ID: never their names or emails.
      askedWhom: asked?.provenance,
      approvedBy: approved?.actor,
      approved: approved?.detail,
    }).toMatchObject({
      actions: [
        "workflow.decision.opened",
        "workflow.decision.asked",
        "workflow.decision.approved",
      ],
      openedBy: { type: "workflow", runId: run.id },
      opened: { run: run.id, step: "review", from: `person:${decider.userId}` },
      askedBy: { type: "workflow", runId: run.id },
      asked: { recipients: 1, reminder: false },
      askedWhom: [decider.userId],
      approvedBy: { type: "person", userId: decider.userId },
      approved: { run: run.id, step: "review" },
    });
    // Who, never what they wrote (R16).
    expect(Object.keys(approved?.detail ?? {}).toSorted()).toStrictEqual([
      "app",
      "run",
      "step",
      "version",
      "workflow",
    ]);
    // The row still names a channel, so the release before this one reads
    // it as answered after a rollback.
    const row = await env.DB.prepare(
      "SELECT decided_via FROM workflow_decisions WHERE id = ?"
    )
      .bind(decision)
      .first<{ decided_via: string | null }>();
    expect(row?.decided_via).toBe("rpc");
  });

  it("refuse anyone the decision isn't from", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const outsider = await personApi("admin");
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });

    await expect(
      Promise.all([
        outcome(outsider.api.decisions.get(decision)),
        outcome(outsider.api.decisions.answer(decision, { approved: true })),
        // Starting the run doesn't make its starter a decider.
        outcome(builder.api.decisions.answer(decision, { approved: true })),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 3 }, () => "decision.forbidden")
    );
    // Still open: the decider answers.
    await decider.api.decisions.answer(decision, { approved: false });
    await expect(outputOf(builder, run.id)).resolves.toMatchObject({
      approved: false,
      by: decider.userId,
    });
  });

  it("take the first answer only, whether someone answers twice or two people at once", async () => {
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const ben = await personApi("user");
    const team = await newTeam(admin, [anna, ben]);
    const { run, decision } = await asking(admin, {
      from: `team:${team}`,
      timeout: week,
    });
    const racing = await Promise.all([
      outcome(anna.api.decisions.answer(decision, { approved: true })),
      outcome(ben.api.decisions.answer(decision, { approved: false })),
    ]);
    const winner = racing[0] === "ok" ? anna : ben;
    const again = await Promise.all([
      outcome(anna.api.decisions.answer(decision, { approved: true })),
      outcome(ben.api.decisions.answer(decision, { approved: true })),
    ]);
    const output = await outputOf(admin, run.id);
    const answers = await vi.waitFor(async () => {
      const events = await eventsOf(decision);
      const decided = events.filter(({ action }) =>
        ["workflow.decision.approved", "workflow.decision.rejected"].includes(
          action
        )
      );
      expect(decided).toHaveLength(1);
      return decided;
    });

    expect({
      racing: racing.toSorted(),
      again,
      output,
      auditedBy: answers.map(({ actor }) => actor),
    }).toStrictEqual({
      racing: ["decision.closed", "ok"],
      again: ["decision.closed", "decision.closed"],
      output: {
        timedOut: false,
        approved: winner === anna,
        by: winner.userId,
        payload: null,
      },
      auditedBy: [{ type: "person", userId: winner.userId }],
    });
  });

  it("time out, and refuse an answer after the timeout", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: 1500,
    });
    const output = await outputOf(builder, run.id);

    expect({
      output,
      late: await outcome(
        decider.api.decisions.answer(decision, { approved: true })
      ),
      seen: await decider.api.decisions.get(decision),
    }).toMatchObject({
      output: { timedOut: true },
      late: "decision.closed",
      seen: { status: "timed_out" },
    });
    await vi.waitFor(async () => {
      const events = await eventsOf(decision);
      expect(
        events.map(({ action, actor }) => [action, actor.type])
      ).toContainEqual(["workflow.decision.timed_out", "workflow"]);
    });
  });

  it("refuse an answer once the run is cancelled", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    await builder.api.workflows.cancel(run.id);

    const answer = await outcome(
      decider.api.decisions.answer(decision, { approved: true })
    );
    const { status } = await decider.api.decisions.get(decision);

    expect({ answer, status }).toStrictEqual({
      answer: "decision.closed",
      status: "closed",
    });
  });

  it("refuse an answer past the deadline, even before the run closed the decision", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    // The run hasn't come round to closing it yet; the deadline has passed.
    await env.DB.prepare(
      "UPDATE workflow_decisions SET expires_at = ? WHERE id = ?"
    )
      .bind(Date.now() - 1000, decision)
      .run();

    await expect(
      outcome(decider.api.decisions.answer(decision, { approved: true }))
    ).resolves.toBe("decision.closed");
  });

  it("don't let whoever started the run answer it, unless it names exactly them", async () => {
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const otherAdmin = await personApi("admin");
    const team = await newTeam(admin, [admin, anna]);
    const byTeam = await asking(admin, { from: `team:${team}`, timeout: week });
    const byRole = await asking(admin, { from: "role:admin", timeout: week });
    const byThemselves = await asking(admin, {
      from: `person:${admin.userId}`,
      timeout: week,
    });

    expect({
      team: {
        asked: askedTo(byTeam.ask),
        starter: await outcome(
          admin.api.decisions.answer(byTeam.decision, { approved: true })
        ),
      },
      role: {
        askedStarter: askedTo(byRole.ask).includes(admin.userId),
        askedOther: askedTo(byRole.ask).includes(otherAdmin.userId),
        starter: await outcome(
          admin.api.decisions.answer(byRole.decision, { approved: true })
        ),
      },
      themselves: {
        asked: askedTo(byThemselves.ask),
        starter: await outcome(
          admin.api.decisions.answer(byThemselves.decision, { approved: true })
        ),
      },
    }).toStrictEqual({
      team: { asked: [anna.userId], starter: "decision.forbidden" },
      role: {
        askedStarter: false,
        askedOther: true,
        starter: "decision.forbidden",
      },
      themselves: { asked: [admin.userId], starter: "ok" },
    });
    // Anyone else the decision is from still answers, and the audit log
    // has their answer, never one under the starter.
    await otherAdmin.api.decisions.answer(byRole.decision, { approved: false });
    await expect(outputOf(admin, byRole.run.id)).resolves.toMatchObject({
      approved: false,
      by: otherAdmin.userId,
    });
    const answers = await vi.waitFor(async () => {
      const events = await eventsOf(byRole.decision);
      const decided = events.filter(({ action }) =>
        ["workflow.decision.approved", "workflow.decision.rejected"].includes(
          action
        )
      );
      expect(decided).toHaveLength(1);
      return decided;
    });
    expect(
      answers.map(({ action, actor }) => ({ action, actor }))
    ).toStrictEqual([
      {
        action: "workflow.decision.rejected",
        actor: { type: "person", userId: otherAdmin.userId },
      },
    ]);
  });

  it("hold back nobody on a run a trigger started, so its App's owner is asked and answers", async () => {
    const owner = await personApi("builder");
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const team = await newTeam(admin, [owner, anna]);
    const app = await approvalApp(owner);
    // As a trigger starts it: no starter, and it acts for the App's owner.
    const run = await startRun(env, {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("approval"),
      input: { from: `team:${team}`, timeout: week },
      startedBy: null,
      actor: { type: "system" },
    });
    const [ask] = await asksOf(app);
    if (!ask) {
      throw new Error("No ask");
    }
    const { decision } = linkOf(ask, owner.userId);

    expect({
      asked: askedTo(ask).toSorted(),
      answer: await outcome(
        owner.api.decisions.answer(decision, { approved: true })
      ),
    }).toStrictEqual({
      asked: [owner.userId, anna.userId].toSorted(),
      answer: "ok",
    });
    await expect(outputOf(owner, run.id)).resolves.toMatchObject({
      approved: true,
      by: owner.userId,
    });
  });

  it("count only who may answer toward the cap, so a starter in a team of 51 leaves it within it", async () => {
    const admin = await personApi("admin");
    const fits = await newTeam(admin, [admin]);
    await addMembers(fits, maxDeciders);
    const tooMany = await newTeam(admin, [admin]);
    await addMembers(tooMany, maxDeciders + 1);

    const { ask } = await asking(admin, {
      from: `team:${fits}`,
      timeout: week,
    });
    const app = await approvalApp(admin);
    const refused = await admin.api.workflows.start(app, "approval", {
      from: `team:${tooMany}`,
      timeout: week,
    });
    await finished(refused.id);
    const { status, failure } = await admin.api.workflows.status(refused.id);

    expect({
      asked: askedTo(ask).length,
      askedStarter: askedTo(ask).includes(admin.userId),
      refused: { status, code: failure?.error.code },
    }).toStrictEqual({
      asked: maxDeciders,
      askedStarter: false,
      refused: { status: "failed", code: "decision.too_many_deciders" },
    });
  });

  it("never take an answer from Grasp staff, even on an admins' decision", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { ask, decision } = await asking(builder, {
      from: "role:admin",
      timeout: week,
    });
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staff = await whoami(staffSession);
    const { core } = await openRpc(staffSession);
    const { decisions } = core.authenticate();

    expect({
      role: staff.role,
      // The decision is the client admins' to answer.
      asked: askedTo(ask).includes(admin.userId),
      get: await outcome(decisions.get(decision)),
      answer: await outcome(decisions.answer(decision, { approved: true })),
    }).toStrictEqual({
      role: "admin",
      asked: true,
      get: "decision.forbidden",
      answer: "decision.forbidden",
    });
  });

  it("bring the person back to the decision's page after signing in", async () => {
    const page = "/decisions/some-decision";
    const person = entraPerson(acmeTenant);
    const { location } = await signIn(idp, "microsoft", person, {
      callbackURL: page,
    });

    expect(location?.endsWith(page)).toBeTruthy();
  });

  it("remind by asking again, whoever is in the team then", async () => {
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const ben = await personApi("user");
    const team = await newTeam(admin, [anna]);
    const { app, run } = await asking(admin, {
      from: `team:${team}`,
      ...reminding,
    });
    // Ben joins the team before the reminder goes out.
    await joinTeam(admin, team, ben);
    const asks = await asksOf(app, 2);

    expect({
      asks: asks.map(({ recipients, reminder }) => ({
        reminder,
        to: recipients.map(({ userId }) => userId).toSorted(),
      })),
      output: await outputOf(admin, run.id),
    }).toStrictEqual({
      asks: [
        { reminder: false, to: [anna.userId] },
        { reminder: true, to: [anna.userId, ben.userId].toSorted() },
      ],
      output: { timedOut: true },
    });
  });

  it("check who may answer as they are when they answer, not when they were asked", async () => {
    const admin = await personApi("admin");
    const leaves = await personApi("user");
    const joins = await personApi("user");
    const team = await newTeam(admin, [leaves]);
    const inTeam = await asking(admin, { from: `team:${team}`, timeout: week });
    const demoted = await personApi("builder");
    const byRole = await asking(admin, { from: "role:builder", timeout: week });
    const removed = await personApi("user");
    const byPerson = await asking(admin, {
      from: `person:${removed.userId}`,
      timeout: week,
    });

    await leaveTeam(admin, team, leaves);
    await joinTeam(admin, team, joins);
    await admin.api.members.setRole(demoted.userId, "user");
    await admin.api.members.remove(removed.userId);

    expect({
      leftTheTeam: await outcome(
        leaves.api.decisions.answer(inTeam.decision, { approved: true })
      ),
      demoted: await outcome(
        demoted.api.decisions.answer(byRole.decision, { approved: true })
      ),
      removed: await outcome(
        removed.api.decisions.answer(byPerson.decision, { approved: true })
      ),
      // Asked before they joined, so they weren't asked, but may answer.
      joinedTheTeam: await outcome(
        joins.api.decisions.answer(inTeam.decision, { approved: true })
      ),
    }).toStrictEqual({
      leftTheTeam: "decision.forbidden",
      demoted: "decision.forbidden",
      removed: "auth.unauthenticated",
      joinedTheTeam: "ok",
    });
    await expect(outputOf(admin, inTeam.run.id)).resolves.toMatchObject({
      by: joins.userId,
    });
  });

  it("don't take an answer from workflow code or from an event sent to the run", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    // Workflow code can't wait for core's decision events.
    const { id: rogue } = await builder.api.apps.create({ name: "Rogue" });
    await release(builder, rogue, {
      "workflows/rogue.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("rogue", { params: {}, input: z.unknown() }, async (step) => {
  try {
    await step.waitFor("forge", { description: "Forge", type: "grasp-decision-x", timeout: 1000 });
    return "waited";
  } catch (error) {
    return error.code;
  }
});
`,
      "workflows/rogue.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";
import rogue from "./rogue.ts";
export default workflowTests(rogue, [{ name: "runs", expect: {} }]);
`,
    });
    const rogueRun = await builder.api.workflows.start(rogue, "rogue");
    // Approving events sent straight to a waiting run, again and again
    // until it ends, as anyone with the Workflows API could send them,
    // wake it, but answer nothing.
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: 3000,
    });
    await finished(run.id, {
      type: `grasp-decision-${decision}`,
      payload: { answered: true, approved: true, by: builder.userId },
    });

    const { output } = await builder.api.workflows.status(run.id);

    expect({
      rogue: await outputOf(builder, rogueRun.id),
      output,
    }).toStrictEqual({
      rogue: "workflow.invalid",
      output: { timedOut: true },
    });
  });

  it("refuse an answer that is too large or not of the right shape", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const answer = async (value: unknown) =>
      await outcome(
        decider.api.decisions.answer(
          decision,
          // SAFETY: invalid on purpose: anything a client can send, as Cap'n
          // Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          value as never
        )
      );

    expect({
      tooLarge: await answer({
        approved: true,
        payload: { note: "x".repeat(5000) },
      }),
      // Who answers comes from the session, never from the request.
      naming: await answer({ approved: true, by: builder.userId }),
      notYesOrNo: await answer({ approved: "yes" }),
      missing: await answer({}),
      notAnObject: await answer("approve"),
      unknownDecision: await outcome(
        decider.api.decisions.answer(crypto.randomUUID(), { approved: true })
      ),
    }).toStrictEqual({
      tooLarge: "decision.invalid",
      naming: "decision.invalid",
      notYesOrNo: "decision.invalid",
      missing: "decision.invalid",
      notAnObject: "decision.invalid",
      unknownDecision: "decision.not_found",
    });
    // None of it counted: the decision is still open.
    await decider.api.decisions.answer(decision, {
      approved: true,
      payload: ["a", 1, null, { nested: true }],
    });
    await expect(outputOf(builder, run.id)).resolves.toMatchObject({
      payload: ["a", 1, null, { nested: true }],
    });
  });
});
