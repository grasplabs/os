import type { App, AppsApi, NewApp } from "@grasp-os/shared/apps";
import { RpcTarget } from "capnweb";

import { AppFilesRpc } from "./app-files-rpc.ts";
import { AppVersionsRpc } from "./app-versions-rpc.ts";
import { createApp, getApp, listApps } from "./apps.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Like SessionRpc, every call checks the session first and hands the
// identity that check returned to the App functions, which check the
// person's role and validate what the client sent.

/** A signed-in person's `apps`, with `apps.files` and `apps.versions`. */
export class AppsRpc extends RpcTarget implements AppsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #files: AppFilesRpc;
  readonly #versions: AppVersionsRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#files = new AppFilesRpc(env, check);
    this.#versions = new AppVersionsRpc(env, check);
  }

  get files(): AppFilesRpc {
    return this.#files;
  }

  get versions(): AppVersionsRpc {
    return this.#versions;
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
