import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  builtins,
  builtinsInstaller,
  builtinsRetryMs,
  fingerprintOf,
  installBuiltins,
  release,
} from "../src/builtins.ts";
import worker from "../src/index.ts";
import {
  graspSkills,
  graspSkillsCollectionId,
  syncGraspSkills,
} from "../src/knowledge/grasp-skills.ts";
import type { GraspSkill } from "../src/knowledge/grasp-skills.ts";
import { auditedDuring } from "./sign-in.ts";

// What ships with the release, installed once per release on the first
// request (src/builtins.ts). These tests start from the ways that can
// fail: a failed start is never tried again, or tried on every request; an
// isolate of another release counts the object's install as its own; a
// request starts another install once the isolate's is done; an unchanged
// release writes again; callers arriving together each install, and write
// twice or refuse each other; and a partial install is recorded as done,
// stranding what failed. That the first request starts it, every file's
// setup checks (builtins-first.ts).
//
// The tests of a file share their storage, the singleton's included, so
// each test that needs an install forgets the last one first.

/** This release's fingerprint, as an isolate of it works it out. */
const thisRelease = async (): Promise<string> => await fingerprintOf(release);

/** Each Grasp skill's current text, by path. */
const storedSkills = async (): Promise<Record<string, string>> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT d.path, v.text FROM documents d JOIN versions v ON v.document_id = d.id AND v.number = d.current_version WHERE d.collection_id = ?"
  )
    .bind(graspSkillsCollectionId)
    .all<{ path: string; text: string }>();
  return Object.fromEntries(results.map(({ path, text }) => [path, text]));
};

/** This release's skills, by path. */
const releaseSkills = (skills: readonly GraspSkill[] = graspSkills) =>
  Object.fromEntries(skills.map(({ path, text }) => [path, text]));

/** This release's skills, with those at `paths` changed: another release. */
const otherRelease = (...paths: string[]): GraspSkill[] =>
  graspSkills.map(({ path, text }) => ({
    path,
    text: paths.includes(path) ? `${text}\nFrom another release.\n` : text,
  }));

/** The first `count` Grasp skills' paths. */
const firstPaths = (count: number): string[] => {
  const paths = graspSkills.slice(0, count).map(({ path }) => path);
  if (paths.length < count) {
    throw new Error(`This release ships fewer than ${count} Grasp skills`);
  }
  return paths;
};

/** What the singleton stored as installed. */
/**
 * The singleton, reached without `getByName`, which the first test
 * counts the calls of.
 */
const singleton = () => env.BUILTINS.get(env.BUILTINS.idFromName("builtins"));

const installed = async (): Promise<unknown> =>
  await runInDurableObject(
    singleton(),
    async (_instance, state) => await state.storage.get("installed")
  );

/**
 * Makes the singleton forget what it installed, and the skills at `paths`
 * another release's text, so the next install has them to write.
 */
const forgetInstall = async (...paths: string[]): Promise<void> => {
  await syncGraspSkills(env, otherRelease(...paths));
  await runInDurableObject(singleton(), async (_instance, state) => {
    await state.storage.delete("installed");
  });
};

const skillSaves = (events: { action: string }[]) =>
  events.filter(({ action }) => action === "knowledge.document.saved");

const insertsVersion = /^insert into "versions"/iu;

/**
 * The Knowledge database, but the first batch that writes a version
 * fails: an outage in the middle of an install.
 */
const knowledgeFailingOnce = (): D1Database => {
  const real = env.KNOWLEDGE;
  let writing = false;
  let failed = false;
  return {
    prepare: (query) => {
      writing ||= insertsVersion.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (writing && !failed) {
        failed = true;
        throw new Error("D1 unavailable");
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** A request that passed the router's check, handled to the end. */
const request = async (): Promise<void> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://core/health", {
      headers: { [routerSecretHeader]: env.ROUTER_SECRET },
    }),
    env,
    ctx
  );
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
};

/** An isolate's installer started as a request would, run to the end. */
const started = async (
  install: ReturnType<typeof builtinsInstaller>
): Promise<void> => {
  const ctx = createExecutionContext();
  install(env, ctx);
  await waitOnExecutionContext(ctx);
};

describe("the built-ins", () => {
  it("are installed after a failed start by the first request a minute later, not before, and then asked for no more", async () => {
    const changed = otherRelease(...firstPaths(1));
    await forgetInstall(...firstPaths(1));
    const install = builtinsInstaller();
    const calls = vi
      .spyOn(env.BUILTINS, "getByName")
      .mockImplementationOnce(() => {
        throw new Error("Durable Objects unavailable");
      });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await started(install);
      // Not tried again before the minute is up.
      await started(install);
      expect([
        calls.mock.calls.length,
        await installed(),
        await storedSkills(),
      ]).toStrictEqual([1, undefined, releaseSkills(changed)]);

      vi.setSystemTime(Date.now() + builtinsRetryMs);
      await started(install);
      // Done: the isolate asks no more.
      vi.setSystemTime(Date.now() + builtinsRetryMs);
      await started(install);
      expect([calls.mock.calls.length, await storedSkills()]).toStrictEqual([
        2,
        releaseSkills(),
      ]);
    } finally {
      vi.useRealTimers();
      calls.mockRestore();
    }
    await expect(installed()).resolves.toBe(await thisRelease());
  });

  it("aren't done for an isolate of another release, which asks again a minute later", async () => {
    await forgetInstall(...firstPaths(1));
    const install = builtinsInstaller({
      ...release,
      skills: otherRelease(...firstPaths(1)),
    });
    const calls = vi.spyOn(env.BUILTINS, "getByName");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The object installs its own release, which isn't this isolate's.
      await started(install);
      await started(install);
      expect([calls.mock.calls.length, await storedSkills()]).toStrictEqual([
        1,
        releaseSkills(),
      ]);
      vi.setSystemTime(Date.now() + builtinsRetryMs);
      await started(install);
      expect(calls).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      calls.mockRestore();
    }
  });

  it("aren't asked for by a request once the isolate's install is done", async () => {
    const calls = vi.spyOn(env.BUILTINS, "getByName");
    try {
      await request();
      expect(calls).not.toHaveBeenCalled();
    } finally {
      calls.mockRestore();
    }
  });

  it("write nothing when the release is installed already", async () => {
    await forgetInstall(...firstPaths(1));
    await expect(
      builtins(env).ensureInstalled(await thisRelease())
    ).resolves.toBeTruthy();

    const events = await auditedDuring(async () => {
      await expect(
        builtins(env).ensureInstalled(await thisRelease())
      ).resolves.toBeTruthy();
    });
    expect(skillSaves(events)).toStrictEqual([]);
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
  });

  it("are installed once for callers arriving together, who all see it done", async () => {
    await forgetInstall(...firstPaths(1));

    const events = await auditedDuring(async () => {
      await expect(
        Promise.all([
          builtins(env).ensureInstalled(await thisRelease()),
          builtins(env).ensureInstalled(await thisRelease()),
          builtins(env).ensureInstalled(await thisRelease()),
        ])
      ).resolves.toStrictEqual([true, true, true]);
    });
    // Two installs would both write the skill from the same version, and
    // the second would be refused: one of them would resolve false.
    expect(skillSaves(events)).toHaveLength(1);
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
  });

  it("aren't recorded as installed after a partial install, and the next install writes only what's missing", async () => {
    const paths = firstPaths(2);
    await forgetInstall(...paths);

    const failing: Env = { ...env, KNOWLEDGE: knowledgeFailingOnce() };
    const partial = await runInDurableObject(
      builtins(env),
      async (_instance, state) =>
        await installBuiltins(failing, state.storage, release)
    );
    // The first skill failed and the second was written, but nothing is
    // recorded as installed.
    const afterPartial = await storedSkills();
    expect([
      partial,
      await installed(),
      ...paths.map((path) => afterPartial[path] === releaseSkills()[path]),
    ]).toStrictEqual([false, undefined, false, true]);

    const events = await auditedDuring(async () => {
      await expect(
        builtins(env).ensureInstalled(await thisRelease())
      ).resolves.toBeTruthy();
    });
    expect(skillSaves(events)).toHaveLength(1);
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
    await expect(installed()).resolves.toStrictEqual(expect.any(String));
  });
});
