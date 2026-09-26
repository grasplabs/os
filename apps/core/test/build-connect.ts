/**
 * Bundles the connect Worker the way its deploy does, so core's tests call
 * the real one over the CONNECT service binding.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildConnectors,
  connectorEntries,
  connectorsFile,
} from "../../connect/build.ts";

const connect = path.join(import.meta.dirname, "../../connect");
const wrangler = path.join(connect, "node_modules/.bin/wrangler");

/** Where core's global setup writes the bundle for its tests. */
export const connectBundle = path.join(
  import.meta.dirname,
  "../dist/test-connect/index.js"
);

/** The connect Worker's bundle, as one ES module, its connectors in it. */
export const bundleConnect = async (): Promise<string> => {
  await buildConnectors(connectorEntries(), connectorsFile);
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
