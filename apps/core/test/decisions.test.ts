import { toBase64Url, fromBase64Url } from "@grasp-os/shared/encoding";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { signDecisionLink } from "../src/decisions/links.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { asking, asksOf, linkOf, outputOf, week } from "./decisions.ts";
import type { Ask, Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, resumed, stopped } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  callAuth,
  entraPerson,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  signIn,
  staffPerson,
  unique,
  whoami,
} from "./sign-in.ts";

// `step.decision`, from its threat model (R8, WF1 to WF4): a run waits for
// a person's answer, which only the people the decision is from can give,
// signed in, as they are when they answer. A decision link only leads them
// there. Each case below is a way it could go wrong, most of them on
// purpose: someone else answering, with or without a link, a link
// forwarded, forged, reused or out of date, two answers, a late one,
// people who changed since they were asked, and workflow code or anyone
// with the Workflows API trying to answer in their place.

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

/** A team with `people` in it, made by `admin`. */
const teamOf = async (admin: Person, people: Person[]): Promise<string> => {
  const created = await callAuth("/organization/create-team", admin.session, {
    name: `Team ${unique()}`,
  });
  const { id } = z.object({ id: z.string() }).parse(await created.json());
  for (const person of people) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await joinTeam(admin, id, person);
  }
  return id;
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
    const { token } = linkOf(ask, decider.userId);
    const seen = await decider.api.decisions.get(decision, token);
    // The run is stopped while it waits, as a deploy or a crash does, and
    // the answer comes in while it's down, days before the deadline.
    await stopped(run.id);
    const answered = await decider.api.decisions.answer(
      decision,
      { approved: true, payload: { comment: "Matches the PO" } },
      token
    );
    await resumed(run.id);

    expect({
      recipients: ask.recipients.map(({ userId, email }) => ({
        userId,
        email,
      })),
      seen,
      answered,
      output: await outputOf(builder, run.id),
    }).toMatchObject({
      recipients: [{ userId: decider.userId, email: decider.person.email }],
      seen: {
        id: decision,
        run: run.id,
        workflow: "approval",
        description: "Approve the invoice",
        status: "open",
      },
      answered: {
        status: "approved",
        decided: { by: { userId: decider.userId }, via: "link" },
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
      approved: { run: run.id, step: "review", via: "link" },
    });
    // Who and how, never what they wrote (R16).
    expect(Object.keys(approved?.detail ?? {}).toSorted()).toStrictEqual([
      "app",
      "run",
      "step",
      "version",
      "via",
      "workflow",
    ]);
  });

  it("refuse anyone the decision isn't from, with the decider's link too", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const outsider = await personApi("admin");
    const { run, ask, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const { token } = linkOf(ask, decider.userId);

    await expect(
      Promise.all([
        outcome(outsider.api.decisions.get(decision)),
        outcome(outsider.api.decisions.get(decision, token)),
        outcome(outsider.api.decisions.answer(decision, { approved: true })),
        outcome(
          outsider.api.decisions.answer(decision, { approved: true }, token)
        ),
        // The run's own starter is no decider either.
        outcome(builder.api.decisions.answer(decision, { approved: true })),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 5 }, () => "decision.forbidden")
    );
    // Still open: the decider answers.
    await decider.api.decisions.answer(decision, { approved: false });
    await expect(outputOf(builder, run.id)).resolves.toMatchObject({
      approved: false,
      by: decider.userId,
    });
  });

  it("refuse a link forwarded to someone else, even someone the decision is also from", async () => {
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const ben = await personApi("user");
    const team = await teamOf(admin, [anna, ben]);
    const { ask, decision } = await asking(admin, {
      from: `team:${team}`,
      timeout: week,
    });
    const annasLink = linkOf(ask, anna.userId).token;

    expect({
      recipients: ask.recipients.map(({ userId }) => userId).toSorted(),
      bensWithAnnasLink: await outcome(
        ben.api.decisions.answer(decision, { approved: true }, annasLink)
      ),
      bensGetWithAnnasLink: await outcome(
        ben.api.decisions.get(decision, annasLink)
      ),
    }).toStrictEqual({
      recipients: [anna.userId, ben.userId].toSorted(),
      bensWithAnnasLink: "decision.link_invalid",
      bensGetWithAnnasLink: "decision.link_invalid",
    });
  });

  it("refuse a link that was tampered with, is out of date, belongs to another decision or isn't one", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const first = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const other = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: week,
    });
    const { token } = linkOf(first.ask, decider.userId);
    const [payload = "", mac = ""] = token.split(".");
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload))
    );
    const reencoded = (changes: Record<string, unknown>): string =>
      `${toBase64Url(
        new TextEncoder().encode(
          JSON.stringify({
            ...z.record(z.string(), z.unknown()).parse(claims),
            ...changes,
          })
        )
      )}.${mac}`;
    const flipped = `${payload}.${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
    // Made with core's own key, so only its date is wrong.
    const expired = await signDecisionLink(
      env,
      first.decision,
      decider.userId,
      Date.now() - 1
    );
    const links = {
      flipped,
      longerDeadline: reencoded({ exp: Date.now() + 10 * week }),
      otherPerson: reencoded({ p: builder.userId }),
      expired,
      otherDecision: linkOf(other.ask, decider.userId).token,
      garbage: "not-a-link",
      huge: `${"a".repeat(5000)}.${mac}`,
    };
    const results = Object.fromEntries(
      await Promise.all(
        Object.entries(links).map(
          async ([name, link]): Promise<[string, string]> => [
            name,
            await outcome(
              decider.api.decisions.answer(
                first.decision,
                { approved: true },
                link
              )
            ),
          ]
        )
      )
    );

    expect(results).toStrictEqual(
      Object.fromEntries(
        Object.keys(links).map((name) => [name, "decision.link_invalid"])
      )
    );
    // The real link still works: nothing above used the decision up.
    await expect(
      outcome(
        decider.api.decisions.answer(first.decision, { approved: true }, token)
      )
    ).resolves.toBe("ok");
  });

  it("take the first answer only, whether someone answers twice or two people at once", async () => {
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const ben = await personApi("user");
    const team = await teamOf(admin, [anna, ben]);
    const { run, ask, decision } = await asking(admin, {
      from: `team:${team}`,
      timeout: week,
    });
    const racing = await Promise.all([
      outcome(
        anna.api.decisions.answer(
          decision,
          { approved: true },
          linkOf(ask, anna.userId).token
        )
      ),
      outcome(ben.api.decisions.answer(decision, { approved: false })),
    ]);
    const winner = racing[0] === "ok" ? anna : ben;
    const again = await Promise.all([
      outcome(anna.api.decisions.answer(decision, { approved: true })),
      outcome(ben.api.decisions.answer(decision, { approved: true })),
      // The link, used once, answers nothing more.
      outcome(
        anna.api.decisions.answer(
          decision,
          { approved: false },
          linkOf(ask, anna.userId).token
        )
      ),
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
      again: ["decision.closed", "decision.closed", "decision.closed"],
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
    const { run, ask, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: 1500,
    });
    const output = await outputOf(builder, run.id);

    expect({
      output,
      late: await outcome(
        decider.api.decisions.answer(decision, { approved: true })
      ),
      // A link lasts until the decision's deadline, and no longer.
      lateWithLink: await outcome(
        decider.api.decisions.answer(
          decision,
          { approved: true },
          linkOf(ask, decider.userId).token
        )
      ),
      seen: await decider.api.decisions.get(decision),
    }).toMatchObject({
      output: { timedOut: true },
      late: "decision.closed",
      lateWithLink: "decision.link_invalid",
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
    const team = await teamOf(admin, [admin, anna]);
    const byTeam = await asking(admin, { from: `team:${team}`, timeout: week });
    const byRole = await asking(admin, { from: "role:admin", timeout: week });
    const byThemselves = await asking(admin, {
      from: `person:${admin.userId}`,
      timeout: week,
    });
    // A link to the starter, made with core's own key, doesn't help either.
    const ownLink = await signDecisionLink(
      env,
      byTeam.decision,
      admin.userId,
      Date.now() + week
    );

    expect({
      team: {
        asked: askedTo(byTeam.ask),
        starter: await outcome(
          admin.api.decisions.answer(byTeam.decision, { approved: true })
        ),
        starterWithLink: await outcome(
          admin.api.decisions.answer(
            byTeam.decision,
            { approved: true },
            ownLink
          )
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
      team: {
        asked: [anna.userId],
        starter: "decision.forbidden",
        starterWithLink: "decision.forbidden",
      },
      role: {
        askedStarter: false,
        askedOther: true,
        starter: "decision.forbidden",
      },
      themselves: { asked: [admin.userId], starter: "ok" },
    });
    // Anyone else the decision is from still answers.
    await otherAdmin.api.decisions.answer(byRole.decision, { approved: false });
    await expect(outputOf(admin, byRole.run.id)).resolves.toMatchObject({
      approved: false,
      by: otherAdmin.userId,
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
    const staffLink = await signDecisionLink(
      env,
      decision,
      staff.userId,
      Date.now() + week
    );

    expect({
      role: staff.role,
      get: await outcome(decisions.get(decision)),
      answer: await outcome(decisions.answer(decision, { approved: true })),
      withAdminsLink: await outcome(
        decisions.answer(
          decision,
          { approved: true },
          linkOf(ask, admin.userId).token
        )
      ),
      withOwnLink: await outcome(
        decisions.answer(decision, { approved: true }, staffLink)
      ),
    }).toStrictEqual({
      role: "admin",
      get: "decision.forbidden",
      answer: "decision.forbidden",
      withAdminsLink: "decision.forbidden",
      withOwnLink: "decision.forbidden",
    });
  });

  it("bring the person back to the link's page after signing in, and send it no referrer", async () => {
    const page = "/decisions/some-decision?link=some-token";
    const person = entraPerson(acmeTenant);
    const { location } = await signIn(idp, "microsoft", person, {
      callbackURL: page,
    });
    const served = await routed(page);

    expect({
      back: location?.endsWith(page),
      referrer: served.headers.get("referrer-policy"),
    }).toStrictEqual({ back: true, referrer: "no-referrer" });
  });

  it("remind by asking again, with fresh links for who is in the team then", async () => {
    const admin = await personApi("admin");
    const anna = await personApi("user");
    const ben = await personApi("user");
    const team = await teamOf(admin, [anna]);
    const { app, run } = await asking(admin, {
      from: `team:${team}`,
      timeout: 4000,
      remindAfter: 1000,
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
    const team = await teamOf(admin, [leaves]);
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
        leaves.api.decisions.answer(
          inTeam.decision,
          { approved: true },
          linkOf(inTeam.ask, leaves.userId).token
        )
      ),
      demoted: await outcome(
        demoted.api.decisions.answer(
          byRole.decision,
          { approved: true },
          linkOf(byRole.ask, demoted.userId).token
        )
      ),
      removed: await outcome(
        removed.api.decisions.answer(
          byPerson.decision,
          { approved: true },
          linkOf(byPerson.ask, removed.userId).token
        )
      ),
      // Asked before they joined, so they have no link, but may answer.
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
    const answer = async (value: unknown, link?: unknown) =>
      await outcome(
        decider.api.decisions.answer(
          decision,
          // SAFETY: invalid on purpose: anything a client can send, as Cap'n
          // Web checks no types, so core must.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          value as never,
          // SAFETY: as above.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          link as never
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
      badLink: await answer({ approved: true }, 42),
      unknownDecision: await outcome(
        decider.api.decisions.answer(crypto.randomUUID(), { approved: true })
      ),
    }).toStrictEqual({
      tooLarge: "decision.invalid",
      naming: "decision.invalid",
      notYesOrNo: "decision.invalid",
      missing: "decision.invalid",
      notAnObject: "decision.invalid",
      badLink: "decision.link_invalid",
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
