import { describe, expect, it } from "vite-plus/test";

import {
  adminUnreachable,
  clientSignInSchema,
  signInProblem,
} from "../src/deploy/core-config.ts";

const entra = {
  domains: ["acme.test", "acme-group.test"],
  entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
};

/** The codes of the issues `signIn` is refused with; empty when it's taken. */
const codesOf = (signIn: unknown): unknown[] => {
  const parsed = clientSignInSchema.safeParse(signIn);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue): unknown =>
        issue.code === "custom" ? issue.params?.code : issue.code
      );
};

describe("a client's sign-in", () => {
  it("takes first admins whose emails are in the email domains, whatever their case", () => {
    expect([
      codesOf({ ...entra, admins: ["ada@acme.test"] }),
      codesOf({ ...entra, admins: ["Ada@ACME-Group.test", "bo@acme.test"] }),
      codesOf({
        domains: ["acme.test"],
        googleHostedDomain: "acme.test",
        admins: ["ada@acme.test"],
      }),
    ]).toStrictEqual([[], [], []]);
  });

  it("refuses a sign-in no first admin could ever sign in with", () => {
    expect({
      none: codesOf({ ...entra, admins: [] }),
      outside: codesOf({ ...entra, admins: ["ada@elsewhere.test"] }),
      // A subdomain isn't the domain: core matches domains exactly.
      subdomain: codesOf({ ...entra, admins: ["ada@eu.acme.test"] }),
      // One admin who can sign in doesn't cover one who can't.
      mixed: codesOf({
        ...entra,
        admins: ["ada@acme.test", "bo@gmail.test"],
      }),
    }).toStrictEqual({
      none: [adminUnreachable],
      outside: [adminUnreachable],
      subdomain: [adminUnreachable],
      mixed: [adminUnreachable],
    });
  });

  it("says who can't sign in, and why, as the new-client form shows it", () => {
    expect(
      signInProblem({ ...entra, admins: ["ada@acme.test", "bo@gmail.test"] })
    ).toBe(
      "bo@gmail.test can't sign in: every first admin's email must be in the email domains (acme.test, acme-group.test)."
    );
  });
});
