import {
  errorReportMaxBytes,
  errorReportPath,
} from "@grasp-os/shared/error-reports";
import type { ErrorReport } from "@grasp-os/shared/error-reports";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { errorReportsPerMinute } from "../src/error-reports.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin } from "./sign-in-config.ts";
import { entraPerson, routed, signedIn } from "./sign-in.ts";

const idp = mockIdp();

const report: ErrorReport = {
  kind: "render",
  message: "Cannot read properties of undefined (reading 'name')",
  stack: "TypeError: Cannot read properties of undefined\n    at Members",
  route: "/members",
  build: "abc123",
};

/** Sends `body` as a report, from the client's own page unless told otherwise. */
const send = async (
  body: string,
  { cookie, origin = clientOrigin }: { cookie?: string; origin?: string }
): Promise<Response> =>
  await routed(errorReportPath, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body,
  });

const codeOf = async (response: Response) => ({
  status: response.status,
  code: errorPayloadSchema.parse(await response.json()).code,
});

const logLineSchema = z.looseObject({ event: z.string() });

/** The `web.error` lines core logged while `run` ran. */
const loggedDuring = async (
  run: () => Promise<void>
): Promise<Record<string, unknown>[]> => {
  const error = vi.spyOn(console, "error").mockReturnValue();
  try {
    await run();
    return error.mock.calls.flatMap(([fields]: unknown[]) => {
      const line = logLineSchema.safeParse(fields);
      return line.success && line.data.event === "web.error" ? [line.data] : [];
    });
  } finally {
    error.mockRestore();
  }
};

describe("error reports", () => {
  it("logs a report from a signed-in page under the request ID it answers with, and nothing of who sent it", async () => {
    const person = entraPerson(acmeTenant);
    const cookie = await signedIn(idp, "microsoft", person);
    let response: Response | undefined;
    const lines = await loggedDuring(async () => {
      response = await send(JSON.stringify(report), { cookie });
    });

    expect(response?.status).toBe(204);
    expect(lines).toStrictEqual([
      {
        event: "web.error",
        requestId: response?.headers.get("x-request-id"),
        kind: report.kind,
        route: report.route,
        build: report.build,
        errorMessage: report.message,
        errorStack: report.stack,
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(person.email);
  });

  it("refuses an oversized report, whatever its length says, and logs nothing", async () => {
    const cookie = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const oversized = JSON.stringify({
      ...report,
      stack: "x".repeat(errorReportMaxBytes),
    });
    const lines = await loggedDuring(async () => {
      const refusals = [
        await codeOf(await send(oversized, { cookie })),
        // A body read as a stream, with no length to go by.
        await codeOf(
          await routed(errorReportPath, {
            method: "POST",
            headers: {
              origin: clientOrigin,
              "content-type": "application/json",
              cookie,
            },
            body: new Blob([oversized]).stream(),
          })
        ),
      ];
      expect(refusals).toStrictEqual([
        { status: 413, code: "error_report.too_large" },
        { status: 413, code: "error_report.too_large" },
      ]);
    });
    expect(lines).toStrictEqual([]);
  });

  it("refuses what isn't a report: another field, such as the page's URL, or no JSON", async () => {
    const cookie = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const refusals = [
      await codeOf(
        await send(
          JSON.stringify({ ...report, url: "/members?email=ann@acme.test" }),
          { cookie }
        )
      ),
      await codeOf(await send("not json", { cookie })),
    ];
    expect(refusals).toStrictEqual([
      { status: 400, code: "error_report.invalid" },
      { status: 400, code: "error_report.invalid" },
    ]);
  });

  it("takes a limited number a minute from each person, whatever the others sent", async () => {
    const cookie = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const other = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const body = JSON.stringify(report);
    const statuses: number[] = [];
    // All in one minute, however long the test takes.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await loggedDuring(async () => {
        for (let sent = 0; sent <= errorReportsPerMinute; sent += 1) {
          // oxlint-disable-next-line no-await-in-loop -- counted one at a time
          const response = await send(body, { cookie });
          statuses.push(response.status);
        }
        const another = await send(body, { cookie: other });
        statuses.push(another.status);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(statuses).toStrictEqual([
      ...Array.from({ length: errorReportsPerMinute }, () => 204),
      429,
      204,
    ]);
  });

  it("takes reports only from someone signed in, on the deployment's own page", async () => {
    const cookie = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const body = JSON.stringify(report);
    const refusals = [
      await codeOf(await send(body, {})),
      await codeOf(await send(body, { cookie, origin: "https://evil.test" })),
    ];
    expect(refusals).toStrictEqual([
      { status: 401, code: "auth.unauthenticated" },
      { status: 403, code: "request.forbidden" },
    ]);
  });
});
