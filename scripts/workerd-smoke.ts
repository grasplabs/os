/**
 * On-prem smoke run: bundles core and serves it on plain workerd (no
 * Wrangler, no Miniflare), then checks it answers. Keeps the code on-prem
 * ready: only platform APIs that also run on workerd.
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { routerSecretHeader } from "../packages/shared/src/router.ts";

const ROUTER_SECRET = "smoke-router-secret";
const ATTEMPTS = 50;
const core = path.join(import.meta.dirname, "../apps/core");
const out = mkdtempSync(path.join(tmpdir(), "grasp-os-workerd-"));

// The same build core's deploy runs, so the bundle below is what ships.
execFileSync("vp", ["run", "build"], { cwd: core, stdio: "inherit" });
execFileSync("wrangler", ["deploy", "--dry-run", "--outdir", out], {
  cwd: core,
  stdio: "inherit",
});

// A port nothing listens on now, picked by the OS and closed again for
// workerd to take, so no other server answers the health check.
const freePort = async (): Promise<number> => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  if (address === null || typeof address === "string") {
    throw new Error("no free port for workerd");
  }
  return address.port;
};
const PORT = await freePort();

// Durable Object migrations are bundled next to index.js as text modules.
const modules = [
  `(name = "index.js", esModule = embed "index.js")`,
  ...readdirSync(out)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => `(name = "${file}", text = embed "${file}")`),
];

writeFileSync(
  path.join(out, "config.capnp"),
  `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "core", worker = .core)],
  sockets = [(name = "http", address = "127.0.0.1:${PORT}", http = (), service = "core")],
);

const core :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "ROUTER_SECRET", text = "${ROUTER_SECRET}"),
    (name = "DURABLE_OBJECT_JURISDICTION", text = "none"),
  ],
  durableObjectNamespaces = [
    (className = "Workspace", uniqueKey = "workspace", enableSql = true),
    (className = "App", uniqueKey = "app", enableSql = true),
    (className = "AuditLog", uniqueKey = "audit-log", enableSql = true),
  ],
  durableObjectStorage = (inMemory = void),
);
`
);

const server = spawn("workerd", ["serve", path.join(out, "config.capnp")], {
  stdio: "inherit",
});

// workerd exits at once when it can't start, e.g. when its port is taken:
// the smoke fails then, rather than polling whatever else listens there.
const exited = async (): Promise<string> => {
  await once(server, "exit");
  const how = server.signalCode ?? server.exitCode;
  return `workerd exited (${String(how)}) before core answered`;
};

// Core's own health answer: exactly `{"ok":true}`, with the request ID core
// puts on every response.
const isCore = async (response: Response): Promise<boolean> =>
  response.ok &&
  response.headers.has("x-request-id") &&
  (await response.text()) === JSON.stringify({ ok: true });

// Polls until workerd is listening; attempts are sequential by design.
const waitForCore = async (attempt = 0): Promise<string | undefined> => {
  if (attempt >= ATTEMPTS) {
    return "core did not answer on workerd";
  }
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${PORT}/health`, {
      headers: { [routerSecretHeader]: ROUTER_SECRET },
    });
  } catch {
    await sleep(100);
    return await waitForCore(attempt + 1);
  }
  return (await isCore(response))
    ? undefined
    : `something other than core answers on port ${PORT}`;
};

try {
  const failure = await Promise.race([waitForCore(), exited()]);
  if (failure !== undefined) {
    throw new Error(failure);
  }
  console.info("core runs on workerd");
} finally {
  server.kill();
  rmSync(out, { force: true, recursive: true });
}
