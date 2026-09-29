import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { act, consoleDatabase } from "../src/db/act.ts";
import { clients, rollouts, rolloutTargets } from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { publishRelease } from "./releases.ts";

mockAccess();

const origin = "https://console.grasp.test";
const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

const scripts = /<script\b[^>]*>[\s\S]*?<\/script>/gu;

/**
 * The page at `path`, as a staff member sees it: its markup without its
 * scripts, so the data sent along for hydration doesn't count as shown.
 */
const page = async (path: string) => {
  const response = await exports.default.fetch(`${origin}${path}`, {
    headers: {
      "cf-access-jwt-assertion": await accessJwt(staff.email),
    },
  });
  const html = await response.text();
  return { status: response.status, html: html.replaceAll(scripts, "") };
};

/** A release, published and imported. */
const importedRelease = async (): Promise<string> => {
  const release = await publishRelease({ notes: "feat(core): roll out" });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/** An active client in `ring`, pinned to `pinnedReleaseId` if given. */
const recordClient = async (ring: number, pinnedReleaseId?: string) => {
  const id = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id,
        name: `Acme ${id}`,
        accountId: crypto.randomUUID().replaceAll("-", ""),
        ring,
        status: "active",
        pinnedReleaseId: pinnedReleaseId ?? null,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId: id }
  );
  return id;
};

/**
 * A rollout of `releaseId` (a secrets rollout for null) waiting for
 * approval after ring 0, which it reached `reached` in, with `pending` in
 * ring 1: as its run leaves it.
 */
const waitingRollout = async (
  releaseId: string | null,
  reached: string,
  pending: string
): Promise<string> => {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(rollouts).values({
      id,
      kind: releaseId === null ? "secrets" : "release",
      releaseId,
      status: "waiting",
      ring: 0,
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(rolloutTargets).values([
      {
        rolloutId: id,
        clientId: reached,
        ring: 0,
        status: "done",
        updatedAt: now,
      },
      {
        rolloutId: id,
        clientId: pending,
        ring: 1,
        status: "pending",
        updatedAt: now,
      },
    ]),
  ]);
  return id;
};

/** How many times `text` appears in `html`. */
const count = (html: string, text: string): number =>
  html.split(text).length - 1;

describe("the rollout pages", () => {
  it("list rollouts, with the form to start one on the newest release", async () => {
    const release = await importedRelease();
    const reached = await recordClient(0);
    const pending = await recordClient(1);
    const rolloutId = await waitingRollout(release, reached, pending);

    const { status, html } = await page("/rollouts");

    expect({
      status,
      listed: html.includes(`href="/rollouts/${rolloutId}"`),
      release: html.includes(release),
      form: html.includes("Start rollout"),
      newest: html.includes(`value="${release}"`),
    }).toStrictEqual({
      status: 200,
      listed: true,
      release: true,
      form: true,
      newest: true,
    });
  });

  it("offer only rings past ring 0, with how many clients each has, and say when ring 0 is all there is", async () => {
    await importedRelease();
    // Only this test's clients are active.
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
    await recordClient(0);
    await recordClient(0);
    const ringZeroOnly = await page("/rollouts");
    await recordClient(2);
    const withRingTwo = await page("/rollouts");

    expect({
      ringZeroOnly: {
        says: ringZeroOnly.html.includes("reaches only our own deployments"),
        choice: ringZeroOnly.html.includes("One ring"),
      },
      withRingTwo: {
        says: withRingTwo.html.includes("reaches only our own deployments"),
        choice: withRingTwo.html.includes("One ring"),
        ringTwo: withRingTwo.html.includes("Ring 2 (1 client)"),
        // Ring 0 comes first whatever's chosen, so it isn't offered.
        ringZero: withRingTwo.html.includes("Ring 0 ("),
      },
    }).toStrictEqual({
      ringZeroOnly: { says: true, choice: false },
      withRingTwo: {
        says: false,
        choice: true,
        ringTwo: true,
        ringZero: false,
      },
    });
  });

  it("show a rollout waiting for approval, its clients ring by ring, and what staff can do", async () => {
    const release = await importedRelease();
    const reached = await recordClient(0);
    const pending = await recordClient(1);
    const rolloutId = await waitingRollout(release, reached, pending);

    const { status, html } = await page(`/rollouts/${rolloutId}`);

    expect({
      status,
      waiting: html.includes("waiting for approval after ring 0"),
      approve: html.includes("Approve the next ring"),
      cancel: html.includes("Cancel"),
      rings: html.includes("Ring 0") && html.includes("Ring 1"),
      clients:
        html.includes(`href="/clients/${reached}"`) &&
        html.includes(`href="/clients/${pending}"`),
      // Only the client the rollout reached, and its ring, can be rolled back.
      rollBackClient: count(html, ">Roll back<"),
      rollBackRing: [
        html.includes("Roll back ring 0"),
        html.includes("Roll back ring 1"),
      ],
    }).toStrictEqual({
      status: 200,
      waiting: true,
      approve: true,
      cancel: true,
      rings: true,
      clients: true,
      rollBackClient: 1,
      rollBackRing: [true, false],
    });
  });

  it("offer a secrets rollout, and show one as secrets only in the list and on its page", async () => {
    await importedRelease();
    const reached = await recordClient(0);
    const pending = await recordClient(1);
    const rolloutId = await waitingRollout(null, reached, pending);

    const [list, own] = await Promise.all([
      page("/rollouts"),
      page(`/rollouts/${rolloutId}`),
    ]);

    expect({
      // The form's choice, and the listed rollout: the only secrets
      // rollout this file starts.
      shown: count(list.html, ">Secrets only<"),
      listed: list.html.includes(`href="/rollouts/${rolloutId}"`),
      own: {
        says: own.html.includes(
          "Secrets only, on each client&#x27;s own release"
        ),
        approve: own.html.includes("Approve the next ring"),
      },
    }).toStrictEqual({
      shown: 2,
      listed: true,
      own: { says: true, approve: true },
    });
  });

  it("answer 404 for a rollout that doesn't exist, or can't be one", async () => {
    const pages = await Promise.all([
      page(`/rollouts/${crypto.randomUUID()}`),
      page("/rollouts/not-a-rollout"),
    ]);

    expect(
      pages.map(({ status, html }) => ({
        status,
        says: html.includes("No such rollout"),
      }))
    ).toStrictEqual([
      { status: 404, says: true },
      { status: 404, says: true },
    ]);
  });

  it("show a live client's pin, with a drift check, and none of it for one being provisioned", async () => {
    const release = await importedRelease();
    const pinned = await recordClient(1, release);
    const unpinned = await recordClient(1);

    const [pinnedPage, unpinnedPage] = await Promise.all([
      page(`/clients/${pinned}`),
      page(`/clients/${unpinned}`),
    ]);

    expect({
      pinned: {
        status: pinnedPage.status,
        says: pinnedPage.html.includes(`Pinned to ${release}`),
        unpin: pinnedPage.html.includes("Unpin"),
        drift: pinnedPage.html.includes("Check drift"),
      },
      unpinned: {
        says: unpinnedPage.html.includes("Not pinned"),
        unpin: unpinnedPage.html.includes("Unpin"),
      },
    }).toStrictEqual({
      pinned: { status: 200, says: true, unpin: true, drift: true },
      unpinned: { says: true, unpin: false },
    });
  });
});
