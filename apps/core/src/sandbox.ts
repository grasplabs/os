import { compatibilityDate } from "@grasp-os/shared/runtime";

/**
 * How App code runs (its server, app.ts, and its workflows,
 * workflows/code.ts): no network, no importable env, and a CPU limit per
 * call, enforced by the runtime (a busy loop ends there; memory is the
 * runtime's limit per isolate). Its env is only what its loader gives it.
 */
export const sandbox = {
  compatibilityDate,
  compatibilityFlags: ["disallow_importable_env"],
  globalOutbound: null,
  limits: { cpuMs: 10_000 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;
