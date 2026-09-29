import { exports } from "cloudflare:workers";

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
 * modules more than the console alone (the Select's icon library is about
 * 2,000), workerd cancels that second request as hung. Built and dev
 * Workers load modules differently and render Selects concurrently fine.
 */
export const page = async (
  path: string,
  email = "staff@grasp.test"
): Promise<Page> => {
  const rendered = renderAfter(previous, path, email);
  previous = rendered;
  return await rendered;
};
