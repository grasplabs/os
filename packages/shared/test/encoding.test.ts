import { describe, expect, it } from "vite-plus/test";

import { fromBase64Url, sha256Hex, toBase64Url } from "../src/encoding.ts";

describe("encoding", () => {
  it("hashes UTF-8 text with SHA-256, as lowercase hex", async () => {
    // FIPS 180-2's test vector, and one with non-ASCII text.
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    await expect(sha256Hex("é")).resolves.toMatch(/^[0-9a-f]{64}$/u);
  });

  it("round-trips bytes through unpadded base64url", () => {
    const bytes = Uint8Array.from([0, 251, 255, 62, 63, 1]);
    const text = toBase64Url(bytes);
    expect(text).toBe("APv_Pj8B");
    expect(fromBase64Url(text)).toStrictEqual(bytes);
  });

  it("refuses text that isn't unpadded base64url", () => {
    for (const text of ["a+b", "a/b", "YQ==", "a b"]) {
      expect(() => fromBase64Url(text)).toThrow(TypeError);
    }
  });
});
