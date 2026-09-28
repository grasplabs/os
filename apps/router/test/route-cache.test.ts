import { describe, expect, it } from "vite-plus/test";

import { routeCache } from "../src/route-cache.ts";

describe("route cache", () => {
  it("forgets an entry once its time is up", () => {
    const cache = routeCache<string>(10, 1000);
    cache.set("a", "one", 0);

    expect(cache.get("a", 999)).toStrictEqual({ value: "one" });
    expect(cache.get("a", 1000)).toBeUndefined();
  });

  it("remembers a miss as well as a hit", () => {
    const cache = routeCache<string | null>(10, 1000);
    cache.set("unknown", null, 0);

    expect(cache.get("unknown", 1)).toStrictEqual({ value: null });
  });

  it("drops the oldest entry when full, counting a refreshed one as new", () => {
    const cache = routeCache<number>(2, 1000);
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("a", 3, 0);
    cache.set("c", 4, 0);

    expect(cache.get("b", 1)).toBeUndefined();
    expect(cache.get("a", 1)).toStrictEqual({ value: 3 });
    expect(cache.get("c", 1)).toStrictEqual({ value: 4 });
  });
});
