import { exports } from "cloudflare:workers";
import { fromCrossJSON, toJSONAsync } from "seroval";
import { z } from "zod";

import { accessJwt } from "./access.ts";

const origin = "https://console.grasp.test";

const scripts = /<script\b[^>]*>[\s\S]*?<\/script>/gu;

interface Page {
  status: number;
  html: string;
}

/** The page most recently asked for, rendered or not. */
let previous: Promise<unknown> = Promise.resolve();

/** The page at `path` as `email` sees it, once `earlier` has settled. */
const renderAfter = async (
  earlier: Promise<unknown>,
  path: string,
  email: string
): Promise<Page> => {
  try {
    await earlier;
  } catch {
    // The test that asked for it sees why it failed.
  }
  const response = await exports.default.fetch(`${origin}${path}`, {
    headers: { "cf-access-jwt-assertion": await accessJwt(email) },
  });
  const html = await response.text();
  return { status: response.status, html: html.replaceAll(scripts, "") };
};

/**
 * The page at `path`, as `email` (a staff member) sees it: its markup without
 * its scripts, so the data sent along for hydration doesn't count as shown.
 *
 * Pages render one at a time, even when a test asks for several at once. In
 * the test pool, the Worker loads the app's modules on demand, over I/O owned
 * by the request that first needs each one, and a second request needing the
 * same module waits on that I/O. Once the pool has loaded a few hundred
 * modules more than the console alone (as the Select's icon library did
 * before vite.test.config.ts pre-bundled it), workerd cancels that second
 * request as hung. Built and dev Workers load modules differently and render
 * Selects concurrently fine.
 */
export const page = async (
  path: string,
  email = "staff@grasp.test"
): Promise<Page> => {
  const rendered = renderAfter(previous, path, email);
  previous = rendered;
  return await rendered;
};

/** What TanStack Start's route for server functions answers, deserialized. */
const answerSchema = z.object({
  result: z.unknown(),
  error: z.unknown().optional(),
});

/**
 * What server function `fn` answers `data` with, called as the console's
 * own pages call it: through the Worker's entry as `email` (a staff
 * member), at TanStack Start's route for server functions, in its wire
 * format.
 */
export const callServerFn = async <Data, Result>(
  fn: ((options: { data: Data }) => Promise<Result>) & {
    serverFnMeta?: { id: string };
  },
  data: Data,
  email = "staff@grasp.test"
): Promise<Result> => {
  const id = fn.serverFnMeta?.id;
  if (id === undefined) {
    throw new Error("Not a server function");
  }
  const response = await exports.default.fetch(`${origin}/_serverFn/${id}`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessJwt(email),
      origin,
      "x-tsr-serverFn": "true",
      "content-type": "application/json",
      accept: "application/json",
    },
    // Plain data needs none of the plugins the pages' client adds.
    body: JSON.stringify(await toJSONAsync({ data })),
  });
  if (!response.ok) {
    throw new Error(`The server function answered ${response.status}`);
  }
  // The entry answers `{ result }`, or `{ error }` for a function that threw.
  const answer = answerSchema.parse(
    fromCrossJSON(await response.json(), { refs: new Map() })
  );
  if (answer.error !== undefined) {
    throw new Error("The server function threw", { cause: answer.error });
  }
  // SAFETY: `result` is what `fn` returned, which is `Result`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return answer.result as Result;
};
