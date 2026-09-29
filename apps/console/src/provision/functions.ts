/**
 * The client pages' server functions, behind the Access check every request
 * passes (src/access.ts). The changes act as the verified staff member the
 * request comes from, and answer a refusal as its code
 * (`ProvisionErrorCode`), which the page words; anything else fails.
 */
import { newClientIdSchema } from "@grasp-os/shared/router";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import { listReleases } from "../releases/queries.ts";
import {
  confirmWorkersPaid,
  ProvisionError,
  provisionInputSchema,
  retryProvisioning,
  startProvisioning,
} from "./control.ts";
import type { ProvisionErrorCode } from "./control.ts";
import { getProvisioning, listClients } from "./queries.ts";

const clientSchema = z.object({ clientId: newClientIdSchema });

/** What a change answers: the client it was for, or why it was refused. */
export type ChangeResult =
  | { clientId: string; refused: null }
  | { clientId: null; refused: ProvisionErrorCode };

/** Runs `task`, which answers the client it changed, a refusal as its code. */
const change = async (task: () => Promise<string>): Promise<ChangeResult> => {
  try {
    return { clientId: await task(), refused: null };
  } catch (error) {
    if (error instanceof ProvisionError) {
      return { clientId: null, refused: error.code };
    }
    throw error;
  }
};

export const fetchClients = createServerFn({ method: "GET" }).handler(
  async () => await listClients(env)
);

/** What the new-client form offers: the imported releases, newest first. */
export const fetchNewClientOptions = createServerFn({ method: "GET" }).handler(
  async () => {
    const { releases } = await listReleases(consoleDatabase(env.DB));
    return { releases: releases.map(({ id, notes }) => ({ id, notes })) };
  }
);

export const fetchProvisioning = createServerFn({ method: "GET" })
  .validator(clientSchema)
  .handler(async ({ data }) => await getProvisioning(env, data.clientId));

export const startClient = createServerFn({ method: "POST" })
  .validator(provisionInputSchema)
  .handler(
    async ({ data, context }) =>
      await change(
        async () => await startProvisioning(env, context.staff, data)
      )
  );

export const confirmClientWorkersPaid = createServerFn({ method: "POST" })
  .validator(clientSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await confirmWorkersPaid(env, context.staff, data.clientId);
        return data.clientId;
      })
  );

export const retryClient = createServerFn({ method: "POST" })
  .validator(clientSchema)
  .handler(
    async ({ data, context }) =>
      await change(async () => {
        await retryProvisioning(env, context.staff, data.clientId);
        return data.clientId;
      })
  );
