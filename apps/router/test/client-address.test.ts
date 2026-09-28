import { describe, expect, it } from "vite-plus/test";

import { clientAddress } from "../src/client-address.ts";

describe("client address", () => {
  it("keeps an IPv4 address whole", () => {
    expect(clientAddress("192.0.2.1")).toBe("192.0.2.1");
    expect(clientAddress("192.0.2.1")).not.toBe(clientAddress("192.0.2.2"));
  });

  it("reduces an IPv6 address to its /64", () => {
    expect(clientAddress("2001:db8:1:2:3:4:5:6")).toBe(
      "2001:0db8:0001:0002:0000:0000:0000:0000"
    );
  });

  it("gives every address in one /64 the same key, however it's written", () => {
    const keys = [
      "2001:db8:1:2::1",
      "2001:DB8:1:2:ffff:ffff:ffff:ffff",
      "2001:0db8:0001:0002:0000:0000:0000:0000",
      "2001:db8:1:2::",
    ].map(clientAddress);

    expect(new Set(keys).size).toBe(1);
  });

  it("tells neighbouring /64s apart", () => {
    expect(clientAddress("2001:db8:1:2::1")).not.toBe(
      clientAddress("2001:db8:1:3::1")
    );
  });

  it("expands `::` wherever it sits", () => {
    expect([clientAddress("::1"), clientAddress("fe80::1:2")]).toStrictEqual([
      "0000:0000:0000:0000:0000:0000:0000:0000",
      "fe80:0000:0000:0000:0000:0000:0000:0000",
    ]);
  });

  it("keys an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect([
      clientAddress("::ffff:192.0.2.1"),
      clientAddress("::ffff:c000:201"),
    ]).toStrictEqual(["192.0.2.1", "192.0.2.1"]);
  });
});
