import { describe, expect, it } from "vite-plus/test";

import { capabilityErrors } from "../src/capability.ts";
import { connectErrors } from "../src/connect.ts";
import {
  defineErrorFamily,
  errorPayloadSchema,
  internalErrors,
  isExpectedError,
  requestErrors,
  toOpaqueError,
} from "../src/errors.ts";
import { modelErrors } from "../src/models.ts";

describe("error payload", () => {
  it("rejects details that wouldn't survive a trip through JSON", () => {
    for (const value of [new Date(0), 1n, Number.NaN, undefined]) {
      const payload = { code: "x", message: "", details: { value } };
      expect(errorPayloadSchema.safeParse(payload).success).toBeFalsy();
    }
  });

  it("rejects an empty code, since callers branch on it", () => {
    const payload = { code: "", message: "Something went wrong" };
    expect(errorPayloadSchema.safeParse(payload).success).toBeFalsy();
  });
});

describe("error families", () => {
  it("reads back the code of an error it created, details included", () => {
    const error = requestErrors.create("request.not_found", { path: "/x" });
    expect(error).toBeInstanceOf(Error);
    expect(requestErrors.codeOf(error)).toBe("request.not_found");
    // Own properties are what Cap'n Web sends along with the message.
    expect(Object.keys(error)).toStrictEqual(["code", "details"]);
    expect(error.details).toStrictEqual({ path: "/x" });
  });

  it("reads the code from a plain object, as an error arrives over RPC", () => {
    const received = { message: "Forbidden.", code: "request.forbidden" };
    expect(requestErrors.codeOf(received)).toBe("request.forbidden");
  });

  it("doesn't claim codes from another family or from outside Grasp", () => {
    const internal = internalErrors.create("internal.unexpected");
    const system = Object.assign(new Error("no such file"), { code: "ENOENT" });
    for (const error of [internal, system, "request.forbidden", null, 1]) {
      expect(requestErrors.codeOf(error)).toBeUndefined();
    }
  });
});

describe("errors a caller outside core may see", () => {
  it("are the errors of every family, and pass as they are", () => {
    const own = defineErrorFamily({ "own.refused": "Refused." });
    const expected = [
      requestErrors.create("request.forbidden"),
      connectErrors.create("connect.invalid"),
      capabilityErrors.create("capability.invalid"),
      modelErrors.create("model.not_allowed"),
      own.create("own.refused"),
    ];
    for (const error of expected) {
      expect(isExpectedError(error)).toBeTruthy();
      expect(toOpaqueError(error)).toBe(error);
    }
  });

  it("replace anything else, keeping only the details given", () => {
    const secret = new Error("Bucket grasp-internal unreachable");
    const unknownCode = Object.assign(new Error("no such file"), {
      code: "ENOENT",
    });
    // An error's code alone isn't enough: it has to be an Error.
    const lookalike = { message: "Forbidden.", code: "request.forbidden" };
    for (const error of [secret, unknownCode, lookalike, "boom", undefined]) {
      const sent = toOpaqueError(error, { requestId: "request-1" });
      expect(isExpectedError(error)).toBeFalsy();
      expect(internalErrors.codeOf(sent)).toBe("internal.unexpected");
      expect(sent.message).not.toContain("grasp-internal");
      expect(sent.stack).toBeUndefined();
      expect(sent).toMatchObject({ details: { requestId: "request-1" } });
    }
  });
});
