import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

/** Checks the connection's session again; throws when it has ended. */
export type SessionCheck = () => Promise<Identity>;

/**
 * What a signed-in person reaches over `/rpc`. It holds no identity: every
 * method runs through `#asPerson`, which checks the session first and hands
 * over the identity that check returned, so a method can't reach the person
 * without the check, or use one kept from an earlier call.
 */
export class SessionRpc extends RpcTarget implements SessionApi {
  readonly #check: SessionCheck;

  constructor(check: SessionCheck) {
    super();
    this.#check = check;
  }

  async #asPerson<T>(run: (identity: Identity) => T | Promise<T>): Promise<T> {
    return await run(await this.#check());
  }

  async whoami(): Promise<Identity> {
    return await this.#asPerson((identity) => identity);
  }
}
