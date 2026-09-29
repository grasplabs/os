/**
 * Where the e2e stack runs, apart from `vp run dev`'s and from every other
 * checkout's, so a run always starts empty, as in CI, and never tests a
 * server another worktree started.
 */
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

/**
 * Ports from 20000 up, two per checkout, picked by its path: parallel
 * worktrees each get their own, and none is dev's (8787 and 8788). Two
 * checkouts that land on the same pair fail loudly, as Playwright never
 * reuses a server (playwright.config.ts); `E2E_PORT` then moves one.
 */
const firstPort = 20_000;
const portPairs = 5000;
const hashed =
  firstPort +
  2 * (createHash("sha256").update(root).digest().readUInt32BE(0) % portPairs);

const portOf = (value: string | undefined): number => {
  if (value === undefined) {
    return hashed;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_534) {
    throw new Error(
      `E2E_PORT must be a port from 1024 to 65534, not "${value}"`
    );
  }
  return port;
};

export const corePort = portOf(process.env.E2E_PORT);
export const idpPort = corePort + 1;

export const origin = `http://localhost:${corePort}`;
export const idpOrigin = `http://localhost:${idpPort}`;

/**
 * The stack's local state (D1, Durable Objects, R2, KV), for core and
 * connect together. Emptied each time the stack starts; `vp run dev` keeps
 * its own in `.wrangler/state`.
 */
export const stateDir = path.join(root, "apps/core/.wrangler/e2e-state");
