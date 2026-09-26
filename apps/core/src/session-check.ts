import type { Identity } from "@grasp-os/shared/rpc";

/** Checks the connection's session again; throws when it has ended. */
export type SessionCheck = () => Promise<Identity>;

/**
 * Runs `run` as the person behind the session: checks it first and hands
 * over the identity that check returned, so nothing reaches the person
 * without the check, or with an identity kept from an earlier call.
 */
export const withPerson = async <T>(
  check: SessionCheck,
  run: (person: Identity) => T | Promise<T>
): Promise<T> => await run(await check());
