/**
 * What an isolate remembers per hostname, each entry for `ttlMs`. Bounded:
 * the wildcard route sends any subdomain to the router, unknown ones
 * included, so past `maxEntries` the oldest entry goes.
 */
export const routeCache = <T>(maxEntries: number, ttlMs: number) => {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  return {
    /** The value remembered for `key`, or undefined if none or expired. */
    get: (key: string, now: number): { value: T } | undefined => {
      const entry = entries.get(key);
      if (entry === undefined || entry.expiresAt <= now) {
        return undefined;
      }
      return { value: entry.value };
    },
    set: (key: string, value: T, now: number): void => {
      entries.delete(key);
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) {
          entries.delete(oldest.value);
        }
      }
      entries.set(key, { value, expiresAt: now + ttlMs });
    },
  };
};
