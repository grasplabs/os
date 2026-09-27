import type { MemoryApi, MemoryCollections } from "@grasp-os/shared/memory";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { memoryCollections } from "./memory.ts";

/** Memory for a signed-in person over `/rpc`, as `KnowledgeRpc` is. */
export class MemoryRpc extends RpcTarget implements MemoryApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async collections(): Promise<MemoryCollections> {
    return await withPerson(
      this.#check,
      async (person) => await memoryCollections(this.#env, person)
    );
  }
}
