/**
 * On-prem smoke run: bundles core and serves it on plain workerd (no
 * Wrangler, no Miniflare), then checks it answers. Keeps the code on-prem
 * ready: only platform APIs that also run on workerd.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { routerSecretHeader } from "../packages/shared/src/router.ts";

const PORT = 8790;
const ROUTER_SECRET = "smoke-router-secret";
const ATTEMPTS = 50;
const core = path.join(import.meta.dirname, "../apps/core");
const out = mkdtempSync(path.join(tmpdir(), "grasp-os-workerd-"));

execFileSync("wrangler", ["deploy", "--dry-run", "--outdir", out], {
  cwd: core,
  stdio: "inherit",
});

writeFileSync(
  path.join(out, "config.capnp"),
  `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "core", worker = .core)],
  sockets = [(name = "http", address = "127.0.0.1:${PORT}", http = (), service = "core")],
);

const core :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "index.js")],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [(name = "ROUTER_SECRET", text = "${ROUTER_SECRET}")],
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

// Polls until workerd is listening; attempts are sequential by design.
const waitForCore = async (attempt = 0): Promise<boolean> => {
  if (attempt >= ATTEMPTS) {
    return false;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, {
      headers: { [routerSecretHeader]: ROUTER_SECRET },
    });
    return response.ok;
  } catch {
    await sleep(100);
    return await waitForCore(attempt + 1);
  }
};

try {
  if (!(await waitForCore())) {
    throw new Error("core did not answer on workerd");
  }
  console.info("core runs on workerd");
} finally {
  server.kill();
  rmSync(out, { force: true, recursive: true });
}
