import type {
  App,
  AppContents,
  AppsApi,
  CurrentExports,
  NewApp,
} from "@grasp-os/shared/apps";
import { RpcTarget } from "capnweb";

import { AppBlueprintsRpc } from "./app-blueprints.ts";
import { AppFilesRpc } from "./app-files-rpc.ts";
import { AppMembersRpc } from "./app-members.ts";
import { AppVersionsRpc } from "./app-versions-rpc.ts";
import {
  appContents,
  appExports,
  createApp,
  getApp,
  listApps,
} from "./apps.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `apps`, with `apps.files`, `apps.versions`,
 * `apps.members` and `apps.blueprints`, in SessionRpc's form. The App
 * functions check the person's role in the App and validate what the
 * client sent.
 */
export class AppsRpc extends RpcTarget implements AppsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #files: AppFilesRpc;
  readonly #versions: AppVersionsRpc;
  readonly #members: AppMembersRpc;
  readonly #blueprints: AppBlueprintsRpc;

  /**
   * `sharing` is the check for `members`, which sharing Apps turns on, and
   * `blueprints` the one for `blueprints`.
   */
  constructor(
    env: Env,
    check: SessionCheck,
    sharing: SessionCheck,
    blueprints: SessionCheck
  ) {
    super();
    this.#env = env;
    this.#check = check;
    this.#files = new AppFilesRpc(env, check);
    this.#versions = new AppVersionsRpc(env, check);
    this.#members = new AppMembersRpc(env, sharing);
    this.#blueprints = new AppBlueprintsRpc(env, blueprints);
  }

  get files(): AppFilesRpc {
    return this.#files;
  }

  get versions(): AppVersionsRpc {
    return this.#versions;
  }

  get members(): AppMembersRpc {
    return this.#members;
  }

  get blueprints(): AppBlueprintsRpc {
    return this.#blueprints;
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

  async contents(app: string): Promise<AppContents> {
    return await withPerson(
      this.#check,
      async (by) => await appContents(this.#env, by, app)
    );
  }

  async exports(app: string): Promise<CurrentExports> {
    return await withPerson(
      this.#check,
      async (by) => await appExports(this.#env, by, app)
    );
  }
}
