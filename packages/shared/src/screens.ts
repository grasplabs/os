import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { AppId } from "./ids.ts";

// An App's screens run in a sandboxed frame in the frontend (apps/web):
// the page builds the frame's import map from a screen's modules, the kit
// modules they need and their CSS, and connects the frame to its App's
// server through core. Core checks the person's session and role on every
// call; the frame only ever talks to the page.

/** Where the frontend frames screens from: a document core serves. */
export const screenFramePath = "/screen-frame";

/**
 * What the frame posts to the page once it listens for its screen:
 * `{ type, load }`, with the `load` its address carried, so the page can
 * tell this load of the frame from an earlier one.
 */
export const screenFrameReady = "grasp:screen-ready";

/**
 * What the page posts the frame, with a `MessagePort`, to start the
 * screen: `{ type, imports, css, runtime, entry }`.
 */
export const screenFrameMessage = "grasp:screen";

/** A screen's name: `desk` for `screens/desk.tsx`. */
export const screenNameSchema = z
  .string()
  .regex(/^[\w-]{1,64}$/u, "a screen's file name, without .tsx");

/** One of an App's screens at its current version, ready for a frame. */
export interface ScreenBundle {
  app: AppId;
  /** The App's name, which the page shows around the frame. */
  name: string;
  /** The App's current version, which the screen was built from. */
  version: number;
  screen: string;
  /** The module to render: its default export is the screen. */
  entry: string;
  /** The kit module that renders it in the frame (@grasp-os/sdk/screen-runtime). */
  runtime: string;
  /** The App's modules by flat name. */
  modules: Record<string, string>;
  /** The kit's modules the App's modules need, by flat name, with their code. */
  kit: Record<string, string>;
  css: string;
}

/** The most one problem report may carry, in characters. */
const reportLimits = { message: 2000, stack: 8000 } as const;

/**
 * A problem in a screen, as the frame reports it: an uncaught error, an
 * unhandled rejection or a `console.error` call. Written by App code, so
 * it is held to size and never counts as more than text.
 */
export const screenProblemSchema = z.strictObject({
  kind: z.enum(["error", "rejection", "console"]),
  message: z.string().transform((text) => text.slice(0, reportLimits.message)),
  stack: z
    .string()
    .transform((text) => text.slice(0, reportLimits.stack))
    .optional(),
});
export type ScreenProblem = z.output<typeof screenProblemSchema>;

/** One entry of an App's error log. Times are ISO 8601. */
export interface AppErrorEntry extends ScreenProblem {
  at: string;
  source: "screen";
  version: number;
  screen: string;
}

/** A signed-in person's way to an App's screens. Admins and builders. */
export interface ScreensApi {
  /** A screen of the App, built from its current version. */
  open: (app: string, screen: string) => Promise<ScreenBundle>;
  /**
   * Calls `method` of the App's server with `args`, as the person. Plain
   * data, and functions (callbacks the server may keep and call later
   * with plain data). The answer is plain data, whatever it holds.
   */
  call: (app: string, method: string, args: unknown[]) => Promise<unknown>;
  /** The App's current version; null while it has none. */
  version: (app: string) => Promise<number | null>;
  /** Adds a problem in a screen at `version` to the App's error log. */
  report: (
    app: string,
    at: { version: number; screen: string },
    problem: ScreenProblem
  ) => Promise<void>;
  /** The App's error log, newest first. */
  errors: (app: string) => Promise<AppErrorEntry[]>;
}

/** Why a call to an App's screens was refused. */
export const screenErrors = defineErrorFamily({
  "screen.not_found": "The App has no such screen.",
  "screen.build_failed": "The App's screens don't build.",
  "screen.invalid": "That isn't a valid request for a screen.",
});
