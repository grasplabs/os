import { describe, expect, it } from "vite-plus/test";

import {
  assetContentKey,
  encodeAsset,
  mapConcurrently,
} from "../src/release.ts";

/** The platform's base64 of `bytes`, to compare with. */
const btoaOf = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

describe("asset encoding", () => {
  it("encodes contents of every length as base64, without the extension", async () => {
    // Short ones, and either side of the 24,576-byte chunks it encodes in.
    const lengths = [0, 1, 2, 3, 4, 5, 24_575, 24_576, 24_577, 49_153, 100_000];
    const samples = lengths.map((length) =>
      Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256)
    );
    const encoded = await Promise.all(
      samples.map(async (bytes) => {
        const { base64 } = await encodeAsset(bytes, "/file.bin");
        return new TextDecoder().decode(base64);
      })
    );
    expect(encoded).toStrictEqual(samples.map(btoaOf));
  });

  it("keys an asset by its contents and its extension as Wrangler reads it", async () => {
    const x = new TextEncoder().encode("x");
    // Worked out with Node: SHA-256 of the base64 and path.extname without
    // its dot, cut to 32 characters.
    const keys = await Promise.all(
      ["/.hidden", "/dir.d/noext", "/file.", "/a.tar.gz"].map(
        async (path) => await assetContentKey(x, path)
      )
    );
    expect(keys).toStrictEqual([
      "5e21d86b709b6aa2d5fff6d7cfed56ab",
      "5e21d86b709b6aa2d5fff6d7cfed56ab",
      "5e21d86b709b6aa2d5fff6d7cfed56ab",
      "c1a6faede032be6f91315fcad5b29e55",
    ]);
  });
});

describe("bounded concurrency", () => {
  it("runs at most the limit at once, and keeps the results in order", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapConcurrently(
      [5, 1, 4, 2, 3, 0],
      2,
      async (value) => {
        running += 1;
        peak = Math.max(peak, running);
        // Let the other worker start before this one finishes.
        await Promise.resolve();
        await Promise.resolve();
        running -= 1;
        return value * 10;
      }
    );

    expect({ results, peak }).toStrictEqual({
      results: [50, 10, 40, 20, 30, 0],
      peak: 2,
    });
  });

  it("takes no more after a failure, and throws it", async () => {
    const started: number[] = [];
    const run = mapConcurrently([1, 2, 3, 4, 5, 6], 2, async (value) => {
      started.push(value);
      await Promise.resolve();
      if (value === 2) {
        throw new Error("two failed");
      }
      return value;
    });

    await expect(run).rejects.toThrow("two failed");
    expect(started).toStrictEqual([1, 2, 3]);
  });
});
