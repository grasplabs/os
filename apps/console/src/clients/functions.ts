/**
 * A client's settings and history, as its page reads and changes them,
 * behind the Access check every request passes (src/access.ts). The
 * changes act as the verified staff member the request comes from, and
 * answer a refusal as its code (`SettingsErrorCode`), which the page
 * words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import { applySettings } from "./apply.ts";
import { clientGrid, gridLive } from "./grid.ts";
import { clientHistory, clientSettings } from "./queries.ts";
import {
  ringInputSchema,
  setRing,
  setSignIn,
  SettingsError,
  signInInputSchema,
} from "./settings.ts";
import type { SettingsErrorCode } from "./settings.ts";

const clientSchema = z.object({ clientId: z.string().min(1) });

/** What a change answers: whether it changed anything, or why it was refused. */
export type SettingsChange =
  | { changed: boolean; refused: null }
  | { changed: null; refused: SettingsErrorCode };

/** Runs `task`, a refusal answered as its code. */
const change = async (
  task: () => Promise<boolean>
): Promise<SettingsChange> => {
  try {
    return { changed: await task(), refused: null };
  } catch (error) {
    if (error instanceof SettingsError) {
      return { changed: null, refused: error.code };
    }
    throw error;
  }
};

/** Every client, as the grid shows it at once: what the console recorded. */
export const fetchClientGrid = createServerFn({ method: "GET" }).handler(
  async () => await clientGrid(env)
);

/**
 * Each active client's live columns, by id, read after the grid shows
 * (`gridLive`): a few at a time, each within a deadline, kept a minute
 * unless anything in them is unknown.
 */
export const fetchGridLive = createServerFn({ method: "GET" }).handler(
  async () => await gridLive(env, new Date())
);

/** A client's settings and its latest console actions; null settings for no such client. */
export const fetchClientSettings = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }) => {
    const db = consoleDatabase(env.DB);
    return {
      settings: await clientSettings(db, data.clientId),
      history: await clientHistory(db, data.clientId),
    };
  });

export const setRingFn = createServerFn({ method: "POST" })
  .validator(ringInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => await setRing(env, context.staff, data))
  );

/** Applies a client's settings now: a deploy of the release it runs, live at once. */
export const applySettingsFn = createServerFn({ method: "POST" })
  .validator(clientSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await applySettings(env, context.staff, data.clientId);
        return true;
      })
  );

export const setSignInFn = createServerFn({ method: "POST" })
  .validator(signInInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => await setSignIn(env, context.staff, data))
  );
