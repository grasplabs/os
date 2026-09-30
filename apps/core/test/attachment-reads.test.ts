import { toHex } from "@grasp-os/shared/encoding";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Settled } from "../src/workflows/code.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import { keepMessage } from "../src/workflows/kept-email.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// A run's reads of a kept message's attachments where the outside systems
// fail: R2 (a fetch that fails once) and the database the audit record is
// written to. On the host a run's code calls, with an engine of the
// test's own that runs each step once, as the platform's does; the email
// tests read attachments in real runs.

const idp = mockIdp();

/** A message from Ben with one PDF attachment, `%PDF-`. */
const mail = [
  "From: Ben <ben@acme.test>",
  "To: scans@grasp.test",
  "Subject: Scan",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Attached.",
  "--b",
  'Content-Type: application/pdf; name="scan.pdf"',
  'Content-Disposition: attachment; filename="scan.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0=",
  "--b--",
  "",
].join("\r\n");

/** The engine's `step`, running each step's function once. */
const step: RunStep = {
  do: async (_name, _config, fn) => await fn(),
  sleep: async () => {
    await Promise.resolve();
  },
  waitForEvent: async () => await Promise.reject(new Error("No waits here")),
};

const hooks: HostHooks = {
  stepFailed: () => {},
  engineStopped: () => false,
  waiting: async () => {
    await Promise.resolve();
  },
  callApp: () => {
    throw new Error("A read calls no App");
  },
};

/**
 * A new App, a message kept for it, and a run of it acting for a person
 * who is there, on `changes` to the env.
 */
const runReading = async (changes: Partial<Env> = {}) => {
  const { userId } = await signedInWithRole(idp, "builder");
  const app = appIdSchema.parse(crypto.randomUUID());
  const raw = new TextEncoder().encode(mail);
  const id = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  const stored = await keepMessage(env, [app], id, raw);
  const runId = runIdSchema.parse(crypto.randomUUID());
  const host = new RunHost(
    { ...env, ...changes },
    step,
    {
      app,
      workflow: workflowIdSchema.parse("scans"),
      version: 1,
      runId,
      authority: authoritySchema.parse({
        subject: { type: "app", appId: app },
        onBehalfOf: userId,
        mode: "workflow",
        appVersion: 1,
      }),
      connections: {},
      apps: {},
      collections: {},
      calls: { steps: null, all: [] },
    },
    hooks
  );
  return { host, stored, runId };
};

/** Runs `reads` as the function of one step, and returns what it read. */
const inStep = async (
  host: RunHost,
  reads: () => Promise<unknown>
): Promise<unknown> => {
  const done = await host.do("read", { description: "Read" }, async () => ({
    ok: true,
    value: await reads(),
  }));
  if (!done.ok) {
    throw new Error(`The step failed: ${done.error.message}`);
  }
  return done.value;
};

/** How a read ended: its content as text, or its error's code. */
const outcome = (read: Settled<Uint8Array>): string =>
  read.ok
    ? new TextDecoder().decode(read.value)
    : (read.error.code ?? read.error.message);

/** The audit log's reads of kept messages by run `runId`, their detail. */
const auditedReads = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.email.read" && target?.id === runId
    )
    .map(({ detail }) => detail);
};

describe("reads of a kept message's attachments", () => {
  it("fetch the message again in the same step after a fetch that failed", async () => {
    let failures = 1;
    const files = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "get" && failures > 0) {
          return async () => {
            failures -= 1;
            return await Promise.reject(new Error("R2 unavailable"));
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const { host, stored } = await runReading({ FILES: files });

    const read = await inStep(host, async () => [
      outcome(await host.readAttachment(stored, 0)),
      outcome(await host.readAttachment(stored, 0)),
    ]);

    expect(read).toStrictEqual(["internal.unexpected", "%PDF-"]);
  });

  it("fail as one to try again, not as their refusal, when the refusal can't be recorded", async () => {
    const { host, runId } = await runReading({
      DB: new Proxy(env.DB, {
        get: (target, property) => {
          if (property === "batch") {
            return async () =>
              await Promise.reject(new Error("D1 unavailable"));
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      }),
    });

    const read = await inStep(host, async () =>
      outcome(await host.readAttachment("2026-09-29/../x", 0))
    );

    expect({ read, audited: await auditedReads(runId) }).toStrictEqual({
      read: "internal.unexpected",
      audited: [],
    });
  });

  it("are refused and recorded outside a step, and for a message that isn't kept", async () => {
    const { host, runId } = await runReading();

    const outside = outcome(await host.readAttachment(null, 0));
    const unkept = await inStep(host, async () =>
      outcome(await host.readAttachment(null, 0))
    );

    expect({
      outside,
      unkept,
      audited: await auditedReads(runId),
    }).toMatchObject({
      outside: "workflow.outside_step",
      unkept: "workflow.attachment_not_found",
      audited: [
        { step: null, message: null, errorCode: "workflow.outside_step" },
        {
          step: "read",
          message: null,
          errorCode: "workflow.attachment_not_found",
        },
      ],
    });
  });
});
