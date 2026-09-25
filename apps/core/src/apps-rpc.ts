import type {
  App,
  AppFilesApi,
  AppsApi,
  AppVersionsApi,
  NewApp,
} from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import {
  commitFiles,
  createApp,
  diffVersions,
  getApp,
  getVersion,
  listApps,
  listVersions,
  proposeVersion,
  readFiles,
  setCurrentVersion,
  writeFiles,
} from "./apps.ts";
import type { SessionCheck } from "./session-rpc.ts";

/**
 * A signed-in person's `apps`, with `apps.files` and `apps.versions`
 * (Cap'n Web passes their functions as stubs). Like SessionRpc, every call
 * checks the session first and hands the identity that check returned to
 * the App functions, which check the person's role and validate what the
 * client sent.
 */
export class AppsRpc extends RpcTarget implements AppsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async #asPerson<T>(
    run: (env: Env, identity: Identity) => Promise<T>
  ): Promise<T> {
    return await run(this.#env, await this.#check());
  }

  get files(): AppFilesApi {
    return {
      read: async (app, version) =>
        await this.#asPerson(
          async (env, by) => await readFiles(env, by, app, version)
        ),
      write: async (app, changes) => {
        await this.#asPerson(async (env, by) => {
          await writeFiles(env, by, app, changes);
        });
      },
      commit: async (app, message) =>
        await this.#asPerson(
          async (env, by) => await commitFiles(env, by, app, message)
        ),
    };
  }

  get versions(): AppVersionsApi {
    return {
      list: async (app, before) =>
        await this.#asPerson(
          async (env, by) => await listVersions(env, by, app, before)
        ),
      get: async (app, version) =>
        await this.#asPerson(
          async (env, by) => await getVersion(env, by, app, version)
        ),
      diff: async (app, from, to) =>
        await this.#asPerson(
          async (env, by) => await diffVersions(env, by, app, from, to)
        ),
      propose: async (app, version) =>
        await this.#asPerson(
          async (env, by) => await proposeVersion(env, by, app, version)
        ),
      setCurrent: async (app, version) =>
        await this.#asPerson(
          async (env, by) => await setCurrentVersion(env, by, app, version)
        ),
    };
  }

  async create(app: NewApp): Promise<App> {
    return await this.#asPerson(
      async (env, by) => await createApp(env, by, app)
    );
  }

  async list(): Promise<App[]> {
    return await this.#asPerson(async (env, by) => await listApps(env, by));
  }

  async get(app: string): Promise<App> {
    return await this.#asPerson(async (env, by) => await getApp(env, by, app));
  }
}
