import type { Identity } from "@grasp-os/shared/rpc";

/**
 * Who is behind the connection, as its latest reading says (at most
 * {@link sessionRecheckMs} old); throws once the session has ended.
 */
export type SessionCheck = () => Promise<Identity>;

/**
 * Runs `run` as the person behind the session: checks it first and hands
 * over the identity that check returned, so nothing reaches the person
 * without the check, or with an identity a method kept for itself.
 */
export const withPerson = async <T>(
  check: SessionCheck,
  run: (person: Identity) => T | Promise<T>
): Promise<T> => await run(await check());

/**
 * How long one reading of who is behind a connection holds. It is read
 * again at most this often, whatever the connection does (rpc.ts): a
 * revoked or expired session, a removal, a changed role or team, or a
 * closed staff window reaches an open connection within this long, its
 * calls and what is pushed to it alike. A new connection always reads now.
 */
export const sessionRecheckMs = 5000;

/**
 * `read`, run again at most every `ms` and shared by everyone who asks
 * meanwhile: so a stream of calls or pushes costs a reading every few
 * seconds, not one each. A reading that fails isn't kept: the next ask
 * reads again.
 */
export const recheckedEvery = <T>(
  ms: number,
  read: () => Promise<T>
): (() => Promise<T>) => {
  let latest: { value: Promise<T>; until: number } | undefined;
  return async () => {
    const now = Date.now();
    if (latest !== undefined && latest.until > now) {
      return await latest.value;
    }
    const reading = { value: read(), until: now + ms };
    latest = reading;
    try {
      return await reading.value;
    } catch (error) {
      if (latest === reading) {
        latest = undefined;
      }
      throw error;
    }
  };
};
