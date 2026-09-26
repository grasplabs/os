import type {
  App,
  AppVersion,
  AppVersionsApi,
  FileDiff,
} from "@grasp-os/shared/apps";
import { RpcTarget } from "capnweb";

import {
  diffVersions,
  getVersion,
  listVersions,
  proposeVersion,
  setCurrentVersion,
} from "./apps.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/** A signed-in person's `apps.versions`. */
export class AppVersionsRpc extends RpcTarget implements AppVersionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(app: string, before?: number): Promise<AppVersion[]> {
    return await withPerson(
      this.#check,
      async (by) => await listVersions(this.#env, by, app, before)
    );
  }

  async get(app: string, version: number): Promise<AppVersion> {
    return await withPerson(
      this.#check,
      async (by) => await getVersion(this.#env, by, app, version)
    );
  }

  async diff(app: string, from: number, to: number): Promise<FileDiff[]> {
    return await withPerson(
      this.#check,
      async (by) => await diffVersions(this.#env, by, app, from, to)
    );
  }

  async propose(app: string, version: number): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await proposeVersion(this.#env, by, app, version)
    );
  }

  async setCurrent(app: string, version: number): Promise<App> {
    return await withPerson(
      this.#check,
      async (by) => await setCurrentVersion(this.#env, by, app, version)
    );
  }
}
