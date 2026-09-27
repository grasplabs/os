import type { Upload, UploadInput, UploadsApi } from "@grasp-os/shared/uploads";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { getUpload, uploadFile } from "./uploads.ts";

/** Uploads for a signed-in person over `/rpc`, as `KnowledgeRpc` is. */
export class UploadsRpc extends RpcTarget implements UploadsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async upload(input: UploadInput): Promise<Upload> {
    return await withPerson(
      this.#check,
      async (person) => await uploadFile(this.#env, person, input)
    );
  }

  async get(uploadId: string): Promise<Upload> {
    return await withPerson(
      this.#check,
      async (person) => await getUpload(this.#env, person, uploadId)
    );
  }
}
