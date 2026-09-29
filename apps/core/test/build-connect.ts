/**
 * Bundles the connect Worker the way its deploy does, so core's tests call
 * the real one over the CONNECT service binding.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildConnectors,
  connectorEntries,
  connectorsFile,
} from "../../connect/build.ts";

const connect = path.join(import.meta.dirname, "../../connect");
const wrangler = path.join(connect, "node_modules/wrangler/bin/wrangler.js");

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
    // Its output is only shown if bundling fails, in the error. Wrangler's
    // launcher passes Node's flags on to the CLI it spawns: without
    // Sparkplug, Node 24's GC segfault (vite.config.ts) can't kill it.
    execFileSync(
      process.execPath,
      ["--no-sparkplug", wrangler, "deploy", "--dry-run", "--outdir", out],
      { cwd: connect }
    );
    const bundle = path.join(out, "index.js");
    // The launcher reports its CLI dying of a signal as success.
    if (!existsSync(bundle)) {
      throw new Error(
        "Wrangler exited without writing connect's bundle: its CLI was killed by a signal."
      );
    }
    return readFileSync(bundle, "utf-8");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
};
