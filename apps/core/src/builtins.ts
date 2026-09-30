import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";

import builtinBlueprints from "#blueprints";
import type { BuiltinBlueprint } from "#blueprints";

import { installBuiltinBlueprint } from "./app-blueprints.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { graspSkills, syncGraspSkills } from "./knowledge/grasp-skills.ts";
import type { GraspSkill } from "./knowledge/grasp-skills.ts";

// What ships with the release, installed once per release on the first
// request: the built-in blueprints
// (apps/core/blueprints/, embedded by build-blueprints.ts, each the
// blueprint of an ordinary App, app-blueprints.ts), and the Grasp skills
// (knowledge/grasp-skills.ts). Workers have no deploy hook, so the first
// request core serves after the router's check starts the install, in the
// background (`installBuiltinsOnce`), once per isolate.
//
// One object does the installing, the `Builtins` singleton. It keeps the
// fingerprint of the release it last installed completely, a SHA-256 of
// everything the install writes; an unchanged release does nothing beyond
// comparing it. Callers who arrive while it installs share that install.
// The fingerprint is stored only once everything is in, so a partial
// install (a blueprint or a skill that failed, the object evicted
// halfway) is tried again by the next request that starts one. Each part
// compares what is stored before it writes (a blueprint its files, a
// skill its text), so trying again writes only what is still missing.
//
// Which release wins while two run side by side, during a gradual
// rollout: the one the object runs. It installs its own release, never
// the caller's, and a Durable Object runs one version at a time: each
// deployment assigns each object a version. As long as each gradual
// deployment lists the versions in the same order as the one before and
// only raises the new version's share, Cloudflare never moves an object
// back to a version it left, so the installed text changes once when the
// object moves to the new release, never back and forth. The console's
// rollouts must keep to that. A rollback installs the older release
// again, as it should. On-prem runs one version.
//
// An isolate counts the install as done only once the object has
// installed the isolate's own release (`ensureInstalled` compares the
// fingerprints): an isolate of the new release that reaches an object
// still on the old one asks again later, rather than never.

/** What a release installs: this one's unless a test passes another. */
export interface Release {
  blueprints: readonly BuiltinBlueprint[];
  skills: readonly GraspSkill[];
}

/** This release's built-ins. */
export const release: Release = {
  blueprints: builtinBlueprints,
  skills: graspSkills,
};

/** Where the singleton keeps the fingerprint of what it installed. */
const installedKey = "installed";

/**
 * Makes each built-in blueprint an App's blueprint, one at a time (each is
 * one batch, well within D1's limits). A blueprint that fails is logged,
 * and the others are still installed. Resolves whether all of them are.
 */
const installBlueprints = async (
  env: Env,
  blueprints: readonly BuiltinBlueprint[]
): Promise<boolean> => {
  let complete = true;
  for (const blueprint of blueprints) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
      await installBuiltinBlueprint(env, blueprint);
    } catch (error) {
      complete = false;
      log.error("builtins.blueprint_failed", {
        blueprint: blueprint.id,
        ...errorFields(error),
      });
    }
  }
  return complete;
};

/** The fingerprint of what installing `of` writes. */
export const fingerprintOf = async (of: Release): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      blueprints: of.blueprints.map(
        ({ id, name, description, collections, permissions, files }) => ({
          id,
          name,
          description,
          collections: [...collections],
          permissions: [...permissions],
          files: { ...files },
        })
      ),
      skills: of.skills.map(({ path, text }) => ({ path, text })),
    })
  );

/**
 * Installs `of` unless `storage` holds its fingerprint already, and stores
 * the fingerprint once all of it is in. Resolves whether it is all in.
 * The singleton runs it; tests run it on its storage with another env.
 */
export const installBuiltins = async (
  env: Env,
  storage: Pick<DurableObjectStorage, "get" | "put">,
  of: Release
): Promise<boolean> => {
  const fingerprint = await fingerprintOf(of);
  if ((await storage.get(installedKey)) === fingerprint) {
    return true;
  }
  const blueprints = await installBlueprints(env, of.blueprints);
  const skills = await syncGraspSkills(env, of.skills);
  const complete = blueprints && skills;
  if (complete) {
    await storage.put(installedKey, fingerprint);
  }
  log.info("builtins.installed", {
    outcome: complete ? "complete" : "partial",
  });
  return complete;
};

/** The singleton that installs the release's built-ins. */
export class Builtins extends DurableObject<Env> {
  #installing: Promise<boolean> | undefined;

  /**
   * Installs this object's release's built-ins if they aren't yet, sharing
   * an install already under way. Resolves whether what is installed now
   * is the caller's release, its fingerprint `expected`: `false` for a
   * partial install, or for an object running another release, and the
   * caller asks again later.
   */
  async ensureInstalled(expected: string): Promise<boolean> {
    this.#installing ??= this.#install();
    const complete = await this.#installing;
    return complete && (await this.ctx.storage.get(installedKey)) === expected;
  }

  async #install(): Promise<boolean> {
    try {
      return await installBuiltins(this.env, this.ctx.storage, release);
    } finally {
      this.#installing = undefined;
    }
  }
}

/** The one `Builtins` object. */
export const builtins = (
  env: Pick<Env, "BUILTINS" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectStub<Builtins> =>
  inJurisdiction(env, env.BUILTINS).getByName("builtins");

/**
 * How long an isolate waits after a partial or failed install before a
 * request starts another: a built-in that fails every time is tried once
 * a minute per isolate, not on every request.
 */
export const builtinsRetryMs = 60_000;

/**
 * An isolate's installer of release `of`'s built-ins: it starts installing
 * them in the background, once per isolate. After a partial or failed
 * install, or one of another release than `of`, the first request
 * `builtinsRetryMs` later starts another; the singleton makes that one
 * comparison once everything is in. Core has one, `installBuiltinsOnce`;
 * tests make others, each for an isolate of their own.
 */
export const builtinsInstaller = (of: Release = release) => {
  // `started` while an install is under way or `of` is in, and when the
  // next may start after one that wasn't.
  const isolate = { started: false, retryAt: 0 };
  return (env: Env, ctx: Pick<ExecutionContext, "waitUntil">): void => {
    if (isolate.started || Date.now() < isolate.retryAt) {
      return;
    }
    isolate.started = true;
    const install = async (): Promise<void> => {
      let complete = false;
      try {
        const expected = await fingerprintOf(of);
        complete = await builtins(env).ensureInstalled(expected);
      } catch (error) {
        log.error("builtins.install_failed", errorFields(error));
      }
      isolate.started = complete;
      if (!complete) {
        isolate.retryAt = Date.now() + builtinsRetryMs;
      }
    };
    ctx.waitUntil(install());
  };
};

/** This isolate's installer, which the first request core serves starts. */
export const installBuiltinsOnce = builtinsInstaller();
