/**
 * The fake IdP (fake-idp.ts) answering core's outbound calls in the workerd
 * tests, at Microsoft's and Google's real URLs, so core runs unchanged with
 * the endpoints it would use in production.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { createIdp } from "./fake-idp.ts";
import type { Idp } from "./fake-idp.ts";

export type { Claims, Idp } from "./fake-idp.ts";

/** An IdP that answers core's outbound calls, for each test in the file. */
export const mockIdp = (): Idp => {
  const idp = createIdp();
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(idp.fetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return idp;
};
