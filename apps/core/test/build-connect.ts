/**
 * Bundles the connect Worker the way its deploy does, so core's tests call
 * the real one over the CONNECT service binding.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const connect = path.join(import.meta.dirname, "../../connect");
const wrangler = path.join(connect, "node_modules/.bin/wrangler");

/** The connect Worker's bundle, as one ES module. */
export const bundleConnect = (): string => {
  const out = mkdtempSync(path.join(tmpdir(), "grasp-os-connect-"));
  try {
    // Its output is only shown if bundling fails, in the error.
    execFileSync(wrangler, ["deploy", "--dry-run", "--outdir", out], {
      cwd: connect,
    });
    return readFileSync(path.join(out, "index.js"), "utf-8");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};
