import type { FullConfig } from "@playwright/test";

import { seedConnections } from "./connections-seed.ts";
import { signInCast } from "./people.ts";

/**
 * Signs in everyone the tests need, and writes the connections they find,
 * for each attempt at a test. Playwright runs it once the web server is up
 * and before any test.
 */
const setup = async (config: FullConfig): Promise<void> => {
  const retries = config.projects.map((project) => project.retries);
  const cast = await signInCast(Math.max(0, ...retries) + 1);
  await seedConnections(cast);
};

export default setup;
