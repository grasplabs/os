import type { RunSubscriptionApi } from "@grasp-os/shared/screens";
import { RpcTarget } from "capnweb";

/**
 * A screen's hold on its App's runs of one workflow (`watchRuns`): until
 * it's released, by `release` or once the screen lets go of it, it counts
 * toward the connection's subscriptions, and the App's host keeps its
 * callback. Releasing it twice does nothing.
 */
export class RunSubscription extends RpcTarget implements RunSubscriptionApi {
  readonly #release: () => Promise<void>;
  #released = false;

  constructor(release: () => Promise<void>) {
    super();
    this.#release = release;
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await this.#release();
  }

  [Symbol.dispose](): void {
    void this.release();
  }
}
