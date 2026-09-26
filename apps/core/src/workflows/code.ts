import {
  appModuleName,
  compilerVersion,
  kitModuleName,
  sdkModules,
  workflowIdOf,
  workflowPaths,
} from "@grasp-os/compiler";
import type { AppFiles } from "@grasp-os/shared/apps";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RpcTarget } from "cloudflare:workers";

import { sandbox } from "../sandbox.ts";
import { buildWorkflows } from "../screens.ts";

// An App's workflows are its code, written by the agent: they run as its
// server code does, in a Worker Loader isolate with no network, no
// importable env and an env of stubs only (dispatcher.ts builds it). Each
// isolate loads one version's workflows and the SDK's modules, and a main
// module of core's that connects the one workflow it runs to the engine
// (host.ts) over RPC. Everything in the isolate is untrusted, core's main
// module too: every check is on core's side of the RPC.
//
// A run is pinned to its App version's workflow code. The SDK's modules
// come from the release that runs it, and so does the engine contract
// between them (step names, `$params`, `$state:…`): that contract must stay
// the same across releases, or runs started before a release replay
// differently after it. `env.APP` calls the App's current server version,
// as every caller of the App does.
//
// A version's workflows ship with their tests, which run in an isolate of
// their own before the version can be made current. That is a quality
// gate, not a security boundary: code can tell it runs under test.

/**
 * An error as it crosses between core and a workflow's isolate: plain data,
 * so nothing of it depends on how RPC carries errors.
 */
export interface StepError {
  name: string;
  message: string;
  /** An expected error's code, such as `permission.denied`. */
  code?: string;
  /** Trying again can't fix it (the SDK's `nonRetryable`). */
  nonRetryable?: boolean;
}

/** How a call across the isolate's boundary ended. */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: StepError };

/**
 * What the run's main module takes from core: the run, the parameter
 * values people set, and its input.
 */
export interface RunStart {
  runId: RunId;
  params: Record<string, string | number>;
  input: unknown;
}

/** The run's main module, as core calls it. */
export interface RunEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: (host: RpcTarget, start: RunStart) => Promise<Settled<unknown>>;
}

/** A workflow's tests as `runWorkflowTests` reports them. */
interface TestReport {
  passed: boolean;
  results: { name: string; passed: boolean; failures: string[] }[];
}

interface TestsEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: () => Promise<Settled<TestReport>>;
}

/**
 * How workflow code runs: as App server code does, with more CPU. One load
 * runs the workflow from its start (finished steps replayed) to its next
 * wait, where one App call runs one method.
 */
const workflowSandbox = {
  ...sandbox,
  limits: { cpuMs: 30_000 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

const runModule = "grasp-run.js";
const testsModule = "grasp-tests.js";

/**
 * The shared part of both main modules: settling a call into plain data
 * and back.
 */
const settling = `
const described = (error) => ({
  name: String(error?.name ?? "Error"),
  message: String(error?.message ?? error),
  nonRetryable: error?.nonRetryable === true,
  ...(typeof error?.code === "string" ? { code: error.code } : {}),
});
const settled = async (run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: described(error) };
  }
};
`;

/**
 * The main module of a run of workflow `id`: the engine the SDK runs on,
 * each of its calls sent to core's host (host.ts), and each error in plain
 * data both ways. A binding the run doesn't have (a permission revoked
 * since, or never granted) fails with a permission error, not `undefined`.
 */
const runMain = (
  id: WorkflowId
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import definition from ${JSON.stringify(appModuleName(workflowPaths(id).workflow))};
${settling}
const unwrapped = (result) => {
  if (result.ok) {
    return result.value;
  }
  const error = new Error(result.error.message);
  error.name = result.error.name;
  if (result.error.code !== undefined) {
    error.code = result.error.code;
  }
  error.nonRetryable = result.error.nonRetryable === true;
  throw error;
};

const bindings = (env) =>
  new Proxy(env, {
    get: (target, name) => {
      if (typeof name !== "string" || name === "then" || Object.hasOwn(target, name)) {
        return target[name];
      }
      const error = new Error(\`This workflow has no permission named \${name}: it was never granted, or it was revoked.\`);
      error.name = "PermissionError";
      error.code = "permission.denied";
      throw error;
    },
  });

export class Run extends WorkerEntrypoint {
  async run(host, { runId, params, input }) {
    return await settled(async () => {
      if (definition?.metadata?.id !== ${JSON.stringify(id)} || typeof definition.run !== "function") {
        throw new Error(${JSON.stringify(`workflows/${id}.ts must export the workflow "${id}" as its default export.`)});
      }
      const engine = {
        runId,
        params,
        env: bindings(this.env),
        do: async (name, options, fn) => unwrapped(await host.do(name, options, async () => await settled(fn))),
        sleep: async (name, milliseconds) => unwrapped(await host.sleep(name, milliseconds)),
        waitForEvent: async (name, options) => unwrapped(await host.waitForEvent(name, options)),
        callModel: async (request) => unwrapped(await host.callModel(request)),
        openDecision: async (request) => unwrapped(await host.openDecision(request)),
        getState: async (key) => unwrapped(await host.getState(key)),
        setState: async (key, value, idempotencyKey) => unwrapped(await host.setState(key, value, idempotencyKey)),
      };
      return await definition.run(engine, input);
    });
  }
}
`;

/** The main module that runs workflow `id`'s tests (`runWorkflowTests`). */
const testsMain = (
  id: WorkflowId
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { runWorkflowTests } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/testing"))};
import tests from ${JSON.stringify(appModuleName(workflowPaths(id).tests))};
${settling}
export class Tests extends WorkerEntrypoint {
  async run() {
    return await settled(async () => {
      if (tests?.definition?.metadata?.id !== ${JSON.stringify(id)}) {
        throw new Error(${JSON.stringify(`workflows/${id}.workflow-tests.ts must export the tests of "${id}" as its default export.`)});
      }
      return JSON.parse(JSON.stringify(await runWorkflowTests(tests)));
    });
  }
}
`;

/** The workflows in an App version's files, by ID. */
const workflowIdsIn = (files: AppFiles): WorkflowId[] =>
  Object.keys(files).flatMap((path) => {
    const id = workflowIdOf(path);
    return id === undefined ? [] : [workflowIdSchema.parse(id)];
  });

/** Whether `id` is one of the workflows in `files`. */
export const hasWorkflow = (files: AppFiles, id: string): boolean =>
  workflowIdsIn(files).some((workflow) => workflow === id);

/**
 * An App version's workflows built into modules (cached in R2), with the
 * SDK's modules they import.
 */
const modulesOf = async (
  env: Env,
  app: AppId,
  version: number,
  files: AppFiles
): Promise<Record<string, string>> => {
  const build = await buildWorkflows(env, {
    app,
    version: String(version),
    files,
  });
  if (!build.ok) {
    throw workflowErrors.create("workflow.build_failed", {
      version,
      diagnostics: build.diagnostics.map(({ file, line, message }) => ({
        file: file ?? null,
        line: line ?? null,
        message,
      })),
    });
  }
  const sdk = await sdkModules(env.ASSETS);
  return { ...sdk.modules, ...build.modules };
};

/** What a run's isolate is loaded for: its code, and its env. */
export interface RunCode {
  app: AppId;
  /** The version the run is pinned to. */
  version: number;
  workflow: WorkflowId;
  /** The version's files (`versionFiles`). */
  files: AppFiles;
  /** The run's env, from the permissions as they are now. */
  env: Record<string, unknown>;
}

/**
 * The run's main module, in an isolate of its own running the run's
 * pinned version. Each load is a new isolate, which the loader keeps for
 * no other (it has no name): its env is the one just built, never one kept
 * warm from before a revoke, and no two runs, or loads of one run, share
 * memory. Loads are few: a run's start, and each resume after a wait.
 */
export const loadRun = (
  env: Env,
  { app, version, workflow, files, env: runEnv }: RunCode
) =>
  env.LOADER.get(null, async () => ({
    ...workflowSandbox,
    mainModule: runModule,
    modules: {
      ...(await modulesOf(env, app, version, files)),
      [runModule]: runMain(workflow),
    },
    env: runEnv,
  })).getEntrypoint<RunEntrypoint>("Run");

/** Why workflow `id`'s tests at `version` fail, one line each; none if they pass. */
const testFailures = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  modules: Record<string, string>
): Promise<string[]> => {
  const tests = env.LOADER.get(
    `workflow-tests:${app}:${version}:${id}:${compilerVersion}`,
    () => ({
      ...workflowSandbox,
      mainModule: testsModule,
      modules: { ...modules, [testsModule]: testsMain(id) },
      env: {},
    })
  ).getEntrypoint<TestsEntrypoint>("Tests");
  const outcome = await tests.run();
  if (!outcome.ok) {
    return [`${id}: ${outcome.error.message}`];
  }
  const { passed, results } = outcome.value;
  if (results.length === 0) {
    return [`${id}: has no tests`];
  }
  return passed
    ? []
    : results.flatMap(({ name, failures }) =>
        failures.map((failure) => `${id}, "${name}": ${failure}`)
      );
};

/**
 * Refuses a version (with its `files`) whose workflows don't build, or
 * whose workflows' tests fail or are missing (`workflow.tests_failed`), so
 * no such version is made current. A version without workflows passes.
 */
export const requireWorkflowTestsPass = async (
  env: Env,
  app: AppId,
  version: number,
  files: AppFiles
): Promise<void> => {
  const ids = workflowIdsIn(files);
  if (ids.length === 0) {
    return;
  }
  const modules = await modulesOf(env, app, version, files);
  const failures: string[] = [];
  for (const id of ids) {
    if (Object.hasOwn(files, workflowPaths(id).tests)) {
      // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
      failures.push(...(await testFailures(env, app, version, id, modules)));
    } else {
      failures.push(`${id}: has no tests (${workflowPaths(id).tests})`);
    }
  }
  if (failures.length > 0) {
    throw workflowErrors.create("workflow.tests_failed", {
      version,
      failures,
    });
  }
};
