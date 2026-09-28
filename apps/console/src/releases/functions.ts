/**
 * The release pages' server functions: read-only, behind the Access check
 * every request passes (src/access.ts).
 */
import { releaseIdSchema } from "@grasp-os/shared/release";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import { compareReleases, getRelease, listReleases } from "./queries.ts";

export const fetchReleases = createServerFn({ method: "GET" }).handler(
  async () => await listReleases(consoleDatabase(env.DB))
);

export const fetchRelease = createServerFn({ method: "GET" })
  .validator(z.object({ id: releaseIdSchema }))
  .handler(
    async ({ data }) => await getRelease(consoleDatabase(env.DB), data.id)
  );

export const fetchComparison = createServerFn({ method: "GET" })
  .validator(z.object({ from: releaseIdSchema, to: releaseIdSchema }))
  .handler(
    async ({ data }) =>
      await compareReleases(consoleDatabase(env.DB), data.from, data.to)
  );
