import { describe, expect, it } from "vite-plus/test";

import { clientIdProblem } from "../src/provision/client-id.ts";

describe("a client id the form checks", () => {
  it("is refused, in words, where the server would refuse it", () => {
    const shape =
      "A client id is its hostname: lowercase letters, digits and dashes, at most 50, starting and ending with a letter or digit.";
    expect({
      uppercase: clientIdProblem("Acme"),
      underscore: clientIdProblem("acme_eu"),
      edgeDash: clientIdProblem("-acme"),
      tooLong: clientIdProblem("a".repeat(51)),
      reserved: clientIdProblem("www"),
      fine: clientIdProblem("acme-eu-2"),
    }).toStrictEqual({
      uppercase: shape,
      underscore: shape,
      edgeDash: shape,
      tooLong: shape,
      reserved:
        "www is reserved for the platform's own hostnames (console, internal, staging, www, api): pick another.",
      fine: null,
    });
  });
});
