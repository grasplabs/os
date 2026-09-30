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
import { runCron } from "./cron.ts";
import { auditedDuring, routed } from "./sign-in.ts";

// What ships with the release, installed once per release on the first
// request (src/builtins.ts). These tests start from the ways that can
// fail: the first request never starts the install, or a failed start is
// never tried again; an unchanged release writes again; callers arriving
// together each install, and write twice or refuse each other; a partial
// install is recorded as done, stranding what failed; switching a part's
// flag on installs nothing because the release didn't change; and the
// cron trigger still syncs the skills, flipping them back and forth
// during a rollout.
//
// The tests of a file share their storage, the singleton's included, so
// each test that needs an install forgets the last one first.

const features = {
  knowledge: true,
  skills: true,
  apps: true,
  app_blueprints: true,
  // The collections built-in blueprints declare are installed with it.
  record_types: true,
};

/** Core's env with `builtins` on, and the flags the built-ins need. */
const on: Env = { ...env, FEATURES: { ...features, builtins: true } };

/** This release's fingerprint, as an isolate of it works it out. */
const thisRelease = async (): Promise<string> =>
  await fingerprintOf(env, release);

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
const request = async (coreEnv: Env): Promise<void> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://core/health", {
      headers: { [routerSecretHeader]: env.ROUTER_SECRET },
    }),
    coreEnv,
    ctx
  );
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
};

describe("the built-ins", () => {
  // First in the file: the isolate counts at most one install as done.
  // Other files share this isolate (`isolate: false` in vite.config.ts)
  // and its module state, which start-each-file.ts doesn't reset: none may
  // switch `builtins` on, or this finds an install already counted.
  it("are installed by the first request, and after a failed start, or one of another release, by the first request a minute later", async () => {
    const changed = otherRelease(...firstPaths(1));
    await forgetInstall(...firstPaths(1));
    // An isolate whose release differs from the object's: without skills.
    const otherIsolate: Env = {
      ...env,
      FEATURES: { ...features, skills: false, builtins: true },
    };
    const calls = vi
      .spyOn(env.BUILTINS, "getByName")
      .mockImplementationOnce(() => {
        throw new Error("Durable Objects unavailable");
      });
    const later = async (coreEnv: Env): Promise<void> => {
      vi.setSystemTime(Date.now() + builtinsRetryMs);
      await request(coreEnv);
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await request(on);
      // Not tried again before the minute is up.
      await request(on);
      expect([
        calls.mock.calls.length,
        await installed(),
        await storedSkills(),
      ]).toStrictEqual([1, undefined, releaseSkills(changed)]);

      // The object installs its own release, which isn't this isolate's:
      // not done for this isolate, which asks again a minute later.
      await later(otherIsolate);
      await request(on);
      expect([calls.mock.calls.length, await storedSkills()]).toStrictEqual([
        2,
        releaseSkills(),
      ]);

      await later(on);
      // Done: the isolate asks no more.
      await later(on);
      expect(calls).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      calls.mockRestore();
    }
    await expect(installed()).resolves.toBe(await thisRelease());
  });

  it("aren't installed by a request while builtins is off", async () => {
    await forgetInstall(...firstPaths(1));
    await routed("/health");
    await expect(installed()).resolves.toBeUndefined();
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

  it("install the skills once skills is switched on, though the release didn't change", async () => {
    await forgetInstall(...firstPaths(1));
    const off: Env = { ...env, FEATURES: { knowledge: true } };
    await runInDurableObject(builtins(env), async (_instance, state) => {
      await expect(
        installBuiltins(off, state.storage, release)
      ).resolves.toBeTruthy();
    });
    await expect(storedSkills()).resolves.not.toStrictEqual(releaseSkills());

    await expect(
      builtins(env).ensureInstalled(await thisRelease())
    ).resolves.toBeTruthy();
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
  });
});

describe("the cron trigger", () => {
  it("leaves the Grasp skills alone while builtins is on, and syncs them while it's off", async () => {
    const changed = otherRelease(...firstPaths(1));
    await syncGraspSkills(env, changed);

    await runCron({ FEATURES: { ...features, builtins: true } });
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills(changed));

    await runCron();
    await expect(storedSkills()).resolves.toStrictEqual(releaseSkills());
  });
});
