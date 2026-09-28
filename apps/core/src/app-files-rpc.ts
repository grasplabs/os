import type {
  AppFiles,
  AppFilesApi,
  CommittedVersion,
  FileChanges,
} from "@grasp-os/shared/apps";
import { RpcTarget } from "capnweb";

import { commitFiles, readFiles, writeFiles } from "./apps.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/** A signed-in person's `apps.files`. */
export class AppFilesRpc extends RpcTarget implements AppFilesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async read(app: string, version?: number): Promise<AppFiles> {
    return await withPerson(
      this.#check,
      async (by) => await readFiles(this.#env, by, app, version)
    );
  }

  async write(app: string, changes: FileChanges): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await writeFiles(this.#env, by, app, changes);
    });
  }

  async commit(app: string, message: string): Promise<CommittedVersion> {
    return await withPerson(
      this.#check,
      async (by) => await commitFiles(this.#env, by, app, message)
    );
  }
}
