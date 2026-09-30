import type {
  GuestChat,
  GuestInvitation,
  GuestTranscript,
} from "@grasp-os/shared/guests";
import { guestErrors } from "@grasp-os/shared/guests";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { callerOf } from "./app-bindings.ts";
import { forSandbox } from "./bindings.ts";
import { inviteGuest, listGuests, readGuest, revokeGuest } from "./guests.ts";

/**
 * Guest chats, as an App's server code holds them under the permission an
 * admin granted it (`{ type: "platform" }`, `guests`), by that
 * permission's name: `await this.env.GUESTS.invite(caller, { name, skill
 * })` (guests.ts). Like every stub, each call passes the caller of the App
 * method it runs in, and acts for them, only while that call runs. Only
 * a person using the App invites (`guest.invalid` for a workflow run's
 * call, or one through another App's export): the member a chat is made
 * for, and spends the budget of, is always the one who asked for it. The
 * permission is checked again on every call.
 */
export class AppGuestsBinding extends WorkerEntrypoint<
  Env,
  { app: AppId; permissionId: PermissionId }
> {
  /** Invites a guest: the answer holds the link, shown once. */
  async invite(caller: unknown, input: unknown): Promise<GuestInvitation> {
    return await this.#run(
      caller,
      async (authority, permissionId) =>
        await inviteGuest(this.env, authority, permissionId, input),
      { personOnly: true }
    );
  }

  /** The App's guest chats, newest first. */
  async list(caller: unknown): Promise<GuestChat[]> {
    return await this.#run(
      caller,
      async (authority, permissionId) =>
        await listGuests(this.env, authority, permissionId)
    );
  }

  /** A guest chat of the App, with what was written: untrusted text. */
  async read(caller: unknown, id: unknown): Promise<GuestTranscript> {
    return await this.#run(
      caller,
      async (authority, permissionId) =>
        await readGuest(this.env, authority, permissionId, id)
    );
  }

  /** Stops a guest chat's link. */
  async revoke(caller: unknown, id: unknown): Promise<GuestChat> {
    return await this.#run(
      caller,
      async (authority, permissionId) =>
        await revokeGuest(this.env, authority, permissionId, id)
    );
  }

  /** Runs `run` for `caller`, with errors as the sandbox sees them. */
  async #run<T>(
    caller: unknown,
    run: (authority: Authority, permissionId: PermissionId) => Promise<T>,
    { personOnly = false }: { personOnly?: boolean } = {}
  ): Promise<T> {
    const { app, permissionId } = this.ctx.props;
    try {
      const { authority, path } = await callerOf(this.env, app, caller);
      const person =
        authority.mode === "interactive" && path.chain.length === 1;
      if (personOnly && !person) {
        throw guestErrors.create("guest.invalid");
      }
      return await run(authority, permissionId);
    } catch (error) {
      throw forSandbox(error);
    }
  }
}
