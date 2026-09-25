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

/** A JSON value, as audit events are made of. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

// `Array.isArray` doesn't narrow a readonly array type.
const isJsonArray = (value: Json): value is readonly Json[] =>
  Array.isArray(value);

/**
 * JSON with object keys sorted by UTF-16 code unit and no whitespace, so equal
 * values always give the same text. For the values audit events hold (no
 * special number forms) this matches RFC 8785 (JCS), so anyone can recompute
 * a hash from the event. Keys whose value is `undefined` are left out, as
 * `JSON.stringify` does.
 */
export const canonicalJson = (value: Json): string => {
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const members: string[] = [];
    // Keys are unique, so no two compare equal.
    for (const [key, member] of Object.entries(value).toSorted(([a], [b]) =>
      a < b ? -1 : 1
    )) {
      if (member !== undefined) {
        members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
      }
    }
    return `{${members.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("JSON has no representation for this number");
  }
  return JSON.stringify(value);
};

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

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** The hash an entry must have. */
export const chainHash = async (
  entry: Omit<ChainEntry, "hash">
): Promise<string> => {
  const { version, seq, prevHash, receivedAt, event } = entry;
  const input = `v${version}\n${seq}\n${prevHash}\n${receivedAt}\n${event}`;
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  );
};

/**
 * Why the chain breaks at a position: an entry is missing there, its link
 * doesn't match the hash before it, or its content doesn't match its hash.
 */
export type ChainBreak = "missing" | "unlinked" | "altered";

export type ChainVerification =
  | { ok: true; length: number; head: string }
  | { ok: false; brokenAt: number; reason: ChainBreak };

/**
 * Checks a chain from its first entry to its last, given in position order,
 * and reports the first position where it breaks. Stops there: everything
 * after a break is unverified.
 */
export const verifyChain = async (
  entries: Iterable<ChainEntry> | AsyncIterable<ChainEntry>
): Promise<ChainVerification> => {
  let expected = 1;
  let prevHash = genesisHash;
  for await (const entry of entries) {
    // Entries come in position order, so one that doesn't follow on means
    // the entry expected here is gone.
    if (entry.seq !== expected) {
      return { ok: false, brokenAt: expected, reason: "missing" };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, brokenAt: expected, reason: "unlinked" };
    }
    // Only one format exists, so an entry claiming another was altered.
    if (
      entry.version !== chainVersion ||
      (await chainHash(entry)) !== entry.hash
    ) {
      return { ok: false, brokenAt: expected, reason: "altered" };
    }
    prevHash = entry.hash;
    expected += 1;
  }
  return { ok: true, length: expected - 1, head: prevHash };
};
