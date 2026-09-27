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

import { routerSecretHeader } from "../packages/shared/src/router.ts";
import { coreStarted } from "./workerd-smoke-start.ts";

const ROUTER_SECRET = "smoke-router-secret";
const ATTEMPTS = 50;
const RETRY_DELAY_MS = 100;
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

// Durable Object migrations and the Grasp skills are bundled next to
// index.js as text modules.
const textModule = /(?:\.sql|SKILL\.md)$/u;
const modules = [
  `(name = "index.js", esModule = embed "index.js")`,
  ...readdirSync(out)
    .filter((file) => textModule.test(file))
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
    # No LOADER (experimental in workerd) and no WORKFLOWS (no engine):
    # apps and screens stay off on-prem unless workerd runs with
    # --experimental, and workflows stay off (apps/core/src/workflows/engine.ts).
  ],
  durableObjectNamespaces = [
    (className = "Workspace", uniqueKey = "workspace", enableSql = true),
    (className = "App", uniqueKey = "app", enableSql = true),
    (className = "AuditLog", uniqueKey = "audit-log", enableSql = true),
  ],
  # In-memory storage aborts workerd when a Durable Object alarm fires, so
  # the smoke run must not write audit events or run the 15-minute cron
  # trigger: either arms the audit log's retention alarm
  # (apps/core/src/audit-log.ts). That alarm is a day out, so it wouldn't
  # fire within one smoke run, but anything left running that long would
  # abort. On-prem runs use localDisk storage, where alarms work.
  durableObjectStorage = (inMemory = void),
);
`
);

const server = spawn("workerd", ["serve", path.join(out, "config.capnp")], {
  stdio: "inherit",
});

try {
  await coreStarted(server, {
    url: `http://127.0.0.1:${PORT}/health`,
    headers: { [routerSecretHeader]: ROUTER_SECRET },
    fetch,
    attempts: ATTEMPTS,
    retryDelayMs: RETRY_DELAY_MS,
  });
  console.info("core runs on workerd");
} finally {
  server.kill();
  rmSync(out, { force: true, recursive: true });
}
