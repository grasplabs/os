import { describe, expect, it } from "vite-plus/test";

import { addressesOf } from "../src/mime.ts";

// Address headers as senders write them: parsed in full, in one pass, so
// no header is cut short or stalls whatever reads it.

describe(addressesOf, () => {
  it("reads a To list of any length in full", () => {
    const addresses = Array.from(
      { length: 400 },
      (_, n) => `"Person ${n}" <person-${n}@example.com>`
    );
    const parsed = addressesOf(addresses.join(", "));

    expect({
      count: parsed.length,
      last: parsed.at(-1),
    }).toStrictEqual({
      count: 400,
      last: { name: "Person 399", address: "person-399@example.com" },
    });
  });

  it("unescapes a quoted name, and takes a bare or bracketed address", () => {
    expect(
      addressesOf(
        String.raw`"Billing \"Dept\"" <billing@example.com>, bare@example.com, <only@example.com>`
      )
    ).toStrictEqual([
      { name: 'Billing "Dept"', address: "billing@example.com" },
      { name: null, address: "bare@example.com" },
      { name: null, address: "only@example.com" },
    ]);
  });
});
