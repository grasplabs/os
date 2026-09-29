/**
 * The rollout pages' server functions, behind the Access check every
 * request passes (src/access.ts). The changes act as the verified staff
 * member the request comes from, and answer a refusal as its code
 * (`RolloutErrorCode`), which the page words; anything else fails.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import {
  deployerApi,
  deploySecrets,
  MissingStoreSecretError,
} from "../deploy/context.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import {
  approveRollout,
  cancelRollout,
  pauseRollout,
  pinClient,
  pinSchema,
  resumeRollout,
  startRollout,
  startRolloutSchema,
} from "./control.ts";
import { driftOf } from "./drift.ts";
import type { ClientDrift } from "./drift.ts";
import { RolloutError } from "./errors.ts";
import type { RolloutErrorCode } from "./errors.ts";
import { getRollout, listRollouts, rolloutOptions } from "./queries.ts";
import { rollbackClientAndWait, rollbackRingAndWait } from "./rollback.ts";
import type { RingRollback } from "./rollback.ts";
import { checkRevocation, runsSharedSecrets } from "./shared-secrets.ts";

const rolloutSchema = z.object({ rolloutId: z.uuid() });
const clientSchema = z.object({ clientId: z.string().min(1) });

/** What a change answers: what it made, or why it was refused. */
export type RolloutChange<T> =
  | { done: T; refused: null }
  | { done: null; refused: RolloutErrorCode };

/** Runs `task`, a refusal answered as its code. */
const change = async <T>(task: () => Promise<T>): Promise<RolloutChange<T>> => {
  try {
    return { done: await task(), refused: null };
  } catch (error) {
    if (error instanceof RolloutError) {
      return { done: null, refused: error.code };
    }
    throw error;
  }
};

export const fetchRollouts = createServerFn({ method: "GET" }).handler(
  async () => {
    const db = consoleDatabase(env.DB);
    return {
      rollouts: await listRollouts(db),
      options: await rolloutOptions(db),
    };
  }
);

export const fetchRollout = createServerFn({ method: "GET" })
  .validator(rolloutSchema)
  .handler(async ({ data }) => await getRollout(env, data.rolloutId));

export const startRolloutFn = createServerFn({ method: "POST" })
  .validator(startRolloutSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => await startRollout(env, context.staff, data))
  );

export const approveRolloutFn = createServerFn({ method: "POST" })
  .validator(rolloutSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await approveRollout(env, context.staff, data.rolloutId);
        return data.rolloutId;
      })
  );

export const pauseRolloutFn = createServerFn({ method: "POST" })
  .validator(rolloutSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await pauseRollout(env, context.staff, data.rolloutId);
        return data.rolloutId;
      })
  );

export const resumeRolloutFn = createServerFn({ method: "POST" })
  .validator(rolloutSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await resumeRollout(env, context.staff, data.rolloutId);
        return data.rolloutId;
      })
  );

export const cancelRolloutFn = createServerFn({ method: "POST" })
  .validator(rolloutSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await cancelRollout(env, context.staff, data.rolloutId);
        return data.rolloutId;
      })
  );

export const rollbackClientFn = createServerFn({ method: "POST" })
  .validator(rolloutSchema.extend(clientSchema.shape))
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await rollbackClientAndWait(
          env,
          context.staff,
          data.rolloutId,
          data.clientId
        );
        return data.clientId;
      })
  );

export const rollbackRingFn = createServerFn({ method: "POST" })
  .validator(rolloutSchema.extend({ ring: z.int().nonnegative() }))
  .handler(
    async ({ data, context }) =>
      await change(
        async (): Promise<RingRollback[]> =>
          await rollbackRingAndWait(
            env,
            context.staff,
            data.rolloutId,
            data.ring
          )
      )
  );

export const pinClientFn = createServerFn({ method: "POST" })
  .validator(pinSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await pinClient(env, context.staff, data);
        return data.clientId;
      })
  );

/**
 * A client's drift, read live from its account, with whether it runs the
 * shared secrets in Secrets Store now (null while the store can't be
 * read).
 */
export type DriftCheck = ClientDrift & { sharedSecretsCurrent: boolean | null };

/** A client's drift, read live from its account when staff ask. */
export const fetchDrift = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }): Promise<DriftCheck | null> => {
    const db = consoleDatabase(env.DB);
    const drift = await driftOf(await deployerApi(env), db, data.clientId);
    if (drift === null) {
      return null;
    }
    let store: DeploySecrets | null = null;
    try {
      store = await deploySecrets(env);
    } catch (error) {
      if (!(error instanceof MissingStoreSecretError)) {
        throw error;
      }
    }
    return {
      ...drift,
      sharedSecretsCurrent:
        store === null ? null : await runsSharedSecrets(db, drift, store),
    };
  });

/**
 * Whether secrets rollout `rolloutId`'s old shared secrets can be
 * revoked, read live from every active client's account when staff ask.
 */
export const checkRevocationFn = createServerFn({ method: "GET" })
  .validator(rolloutSchema)
  .handler(async ({ data }) => await checkRevocation(env, data.rolloutId));
