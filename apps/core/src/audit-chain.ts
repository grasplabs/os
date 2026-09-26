import type { ChainBreak } from "@grasp-os/shared/audit-log";
import { sha256Hex } from "@grasp-os/shared/encoding";

/**
 * The audit log's hash chain. Each entry's hash covers the hash format
 * version, its position, the hash of the entry before it, the time the log
 * received it and the event itself:
 *
 *   hash = hex(SHA-256(`v1\n${seq}\n${prevHash}\n${receivedAt}\n${event}`))
 *
 * where `event` is the event's canonical JSON, stored as it was hashed, and
 * `receivedAt` is set by the log, so the chain attests when the log saw an
 * event, whatever time its sender claims. Each entry stores its format
 * version, so a later format can be added without rehashing old entries. The
 * first entry links to {@link genesisHash}.
 *
 * Changing, removing or reordering an entry breaks the chain from that
 * position on, so {@link verifyChain} finds it. The head isn't anchored
 * outside the deployment, so someone who can deploy code could still rewrite
 * the chain from some point to its end.
 */

/** What the first entry links to: 64 zeros, the width of a SHA-256 hex hash. */
export const genesisHash = "0".repeat(64);

/** The hash format new entries use, described at the top of this file. */
export const chainVersion = 1;

/** One stored entry of the chain. */
export interface ChainEntry {
  /** The entry's hash format. */
  version: number;
  /** Position in the chain, from 1, without gaps. */
  seq: number;
  prevHash: string;
  /** When the log received the event (ISO 8601), set by the log. */
  receivedAt: string;
  /** The event's canonical JSON. */
  event: string;
  hash: string;
}

/** The hash an entry must have. */
export const chainHash = async (
  entry: Omit<ChainEntry, "hash">
): Promise<string> => {
  const { version, seq, prevHash, receivedAt, event } = entry;
  const input = `v${version}\n${seq}\n${prevHash}\n${receivedAt}\n${event}`;
  return await sha256Hex(input);
};

/**
 * Whether an entry's hash matches its content. Only one format exists, so
 * an entry claiming another was altered.
 */
export const hashMatches = async (entry: ChainEntry): Promise<boolean> =>
  entry.version === chainVersion && (await chainHash(entry)) === entry.hash;

/** A position in the chain and the hash of the entry there. */
export interface ChainLink {
  seq: number;
  hash: string;
}

/** Before the first entry: where the whole chain starts. */
export const chainOrigin: ChainLink = { seq: 0, hash: genesisHash };

/** How a stretch of the chain checked out: how far it got, or where it broke. */
export type StretchVerification =
  | { ok: true; through: number; head: string }
  | { ok: false; brokenAt: number; reason: ChainBreak };

/**
 * Checks a stretch of the chain, given in position order, that follows on
 * from `start` (by default the whole chain), and reports the first position
 * where it breaks: an entry is missing there, its link doesn't match the
 * hash before it, or its content doesn't match its hash. Stops there:
 * everything after a break is unverified.
 */
export const verifyChain = async (
  entries: Iterable<ChainEntry> | AsyncIterable<ChainEntry>,
  start: ChainLink = chainOrigin
): Promise<StretchVerification> => {
  let expected = start.seq + 1;
  let prevHash = start.hash;
  for await (const entry of entries) {
    // Entries come in position order, so one that doesn't follow on means
    // the entry expected here is gone.
    if (entry.seq !== expected) {
      return { ok: false, brokenAt: expected, reason: "missing" };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, brokenAt: expected, reason: "unlinked" };
    }
    if (!(await hashMatches(entry))) {
      return { ok: false, brokenAt: expected, reason: "altered" };
    }
    prevHash = entry.hash;
    expected += 1;
  }
  return { ok: true, through: expected - 1, head: prevHash };
};
