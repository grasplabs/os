import type {
  App,
  AppFilesApi,
  AppsApi,
  AppVersionsApi,
  NewApp,
} from "@grasp-os/shared/apps";
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
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

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

  get files(): AppFilesApi {
    return {
      read: async (app, version) =>
        await withPerson(
          this.#check,
          async (by) => await readFiles(this.#env, by, app, version)
        ),
      write: async (app, changes) => {
        await withPerson(this.#check, async (by) => {
          await writeFiles(this.#env, by, app, changes);
        });
      },
      commit: async (app, message) =>
        await withPerson(
          this.#check,
          async (by) => await commitFiles(this.#env, by, app, message)
        ),
    };
  }

  get versions(): AppVersionsApi {
    return {
      list: async (app, before) =>
        await withPerson(
          this.#check,
          async (by) => await listVersions(this.#env, by, app, before)
        ),
      get: async (app, version) =>
        await withPerson(
          this.#check,
          async (by) => await getVersion(this.#env, by, app, version)
        ),
      diff: async (app, from, to) =>
        await withPerson(
          this.#check,
          async (by) => await diffVersions(this.#env, by, app, from, to)
        ),
      propose: async (app, version) =>
        await withPerson(
          this.#check,
          async (by) => await proposeVersion(this.#env, by, app, version)
        ),
      setCurrent: async (app, version) =>
        await withPerson(
          this.#check,
          async (by) => await setCurrentVersion(this.#env, by, app, version)
        ),
    };
  }

  async create(app: NewApp): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await createApp(this.#env, by, app)
    );
  }

  async list(): Promise<App[]> {
    return await withPerson(
      this.#check,
      async (by) => await listApps(this.#env, by)
    );
  }

  async get(app: string): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await getApp(this.#env, by, app)
    );
  }
}
