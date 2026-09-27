/**
 * `vp run dev`: the frontend (localhost:5173) with core and connect behind
 * it (localhost:8787), and the fake IdP people sign in through, as the
 * client's Entra tenant (apps/core/test/idp-worker.ts). Any email at
 * acme.test signs in; admin@acme.test joins as an admin. When one of them
 * stops, or this script is stopped, all of them stop.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { localIdpPort, localSignIn } from "../apps/core/test/sign-in-config.ts";

const frontend = "http://localhost:5173";

const signInVars = Object.entries(localSignIn(frontend)).flatMap(
  ([name, value]) => [
    "--var",
    `${name}:${typeof value === "string" ? value : JSON.stringify(value)}`,
  ]
);

/**
 * Each command runs in a process group of its own, so stopping it stops
 * what it started too (wrangler's workerd, Vite's esbuild).
 */
const start = (command: string, args: string[]): ChildProcess =>
  spawn(command, args, { stdio: "inherit", detached: true });

const children = [
  start("vp", ["run", "--filter", "@grasp-os/core", "dev", ...signInVars]),
  start("vp", ["run", "--filter", "@grasp-os/web", "dev"]),
  start("wrangler", [
    "dev",
    "-c",
    "apps/core/test/idp.wrangler.jsonc",
    "--port",
    String(localIdpPort),
  ]),
];

/** Set once everything is being stopped: exits from then on are expected. */
let stopping = false;

const stopAll = (): void => {
  stopping = true;
  for (const { pid } of children) {
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // The group is already gone.
      }
    }
  }
};

/**
 * One that fails to start (not installed, say) takes the others down too,
 * so none is left holding its port.
 */
const failedToStart = (error: Error): void => {
  console.error(`A dev process failed to start: ${error.message}`);
  process.exitCode = 1;
  stopAll();
};

/**
 * One that stops by itself fails the whole with its code, or 1 when a
 * signal from elsewhere ended it; the rest, stopped here, don't count, so
 * a clean Ctrl+C exits 0.
 */
const exited = (code: number | null): void => {
  if (!stopping) {
    process.exitCode = code ?? 1;
  }
  stopAll();
};

for (const child of children) {
  child.on("error", failedToStart);
  child.on("exit", exited);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, stopAll);
}
