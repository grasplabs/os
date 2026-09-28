import {
  appModuleName,
  compilerVersion,
  kitModuleName,
  sdkModules,
  workflowIdOf,
  workflowPaths,
} from "@grasp-os/compiler";
import { paramValueSchemas } from "@grasp-os/sdk/params";
import type { ParamKind } from "@grasp-os/sdk/params";
import type { AppFiles } from "@grasp-os/shared/apps";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import {
  paramDeclarationSchema,
  paramDeclarationsSchema,
  triggerDeclarationsSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { TriggerDeclaration } from "@grasp-os/shared/workflows";
import type { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import { sandbox } from "../sandbox.ts";
import { buildWorkflows } from "../screens.ts";
import { fromIsolate } from "./host.ts";

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
}

/** How a call across the isolate's boundary ended. */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: StepError };

/**
 * What the run's main module takes from core: the run, the parameter
 * values people set, its input, and the binding names of its connections,
 * which it calls through the host (host.ts).
 */
export interface RunStart {
  runId: RunId;
  params: Record<string, string | number>;
  input: unknown;
  connections: string[];
}

/** The run's main module, as core calls it. */
export interface RunEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: (host: RpcTarget, start: RunStart) => Promise<Settled<unknown>>;
}

/**
 * A workflow's tests as `runWorkflowTests` reports them, as far as core
 * reads it; the isolate sends it, so it is checked, and bounded.
 */
const testReportSchema = z.object({
  passed: z.boolean(),
  results: z
    .array(
      z.object({
        name: z.string().max(200),
        failures: z.array(z.string().max(2000)).max(50),
      })
    )
    .max(500),
});

interface TestsEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: () => Promise<Settled<unknown>>;
}

/**
 * A workflow's parameters as its code declares them (the SDK's
 * `ParamMetadata`), within the bounds the SDK checks too. The isolate
 * sends them, so they are checked again here.
 */
const declaredParamsSchema = paramDeclarationsSchema(
  paramDeclarationSchema.extend({
    kind: z.custom<ParamKind>(
      (kind) =>
        typeof kind === "string" && Object.hasOwn(paramValueSchemas, kind)
    ),
  })
).superRefine((params, context) => {
  for (const param of params) {
    if (!paramValueSchemas[param.kind].safeParse(param.default).success) {
      context.addIssue({
        code: "custom",
        message: `The default of ${param.name} isn't a ${param.kind}`,
      });
    }
  }
});

/** A parameter as a workflow's code declares it. */
export type DeclaredParam = z.infer<typeof declaredParamsSchema>[number];

/** A workflow's metadata as its isolate sends it; its readers check each part. */
const declaredMetadataSchema = z.object({
  params: z.unknown().optional(),
  triggers: z.unknown().optional(),
});

interface MetadataEntrypoint extends Rpc.WorkerEntrypointBranded {
  read: () => Promise<Settled<unknown>>;
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
const metadataModule = "grasp-metadata.js";
const dryRunModule = "grasp-dry-run.js";

/** Most of a workflow's tests one dry run runs. */
const maxDryRuns = 50;

/** The most of one dry run's report core keeps, in characters. */
const maxDryRunReport = 20_000;

/** Each test's dry run, as `dryRunMain` reports it; checked, and bounded. */
const dryRunsSchema = z
  .array(
    z.object({
      name: z.string().max(200),
      status: z.enum(["completed", "failed"]),
      report: z.string().max(maxDryRunReport),
    })
  )
  .max(maxDryRuns);

/** Each test's dry run of a workflow. */
export type DryRuns = z.infer<typeof dryRunsSchema>;

interface DryRunsEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: (params: Record<string, string | number>) => Promise<Settled<unknown>>;
}

/**
 * The shared part of both main modules: settling a call into plain data
 * and back.
 */
const settling = `
const described = (error) => ({
  name: String(error?.name ?? "Error"),
  message: String(error?.message ?? error),
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
 * data both ways. Its connections and its App go through the host too,
 * which knows the step running. A binding the run doesn't have (a permission revoked
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

const withConnections = (env, host, connections) => ({
  ...env,
  APP: {
    call: async (method, ...args) => unwrapped(await host.callApp(method, args)),
  },
  ...Object.fromEntries(
    connections.map((name) => [
      name,
      {
        call: async (action, input, options) =>
          unwrapped(await host.callConnection(name, [action, input, options])),
      },
    ])
  ),
});

export class Run extends WorkerEntrypoint {
  async run(host, { runId, params, input, connections }) {
    return await settled(async () => {
      if (definition?.metadata?.id !== ${JSON.stringify(id)} || typeof definition.run !== "function") {
        throw new Error(${JSON.stringify(`workflows/${id}.ts must export the workflow "${id}" as its default export.`)});
      }
      const engine = {
        runId,
        params,
        env: bindings(withConnections(this.env, host, connections)),
        do: async (name, options, fn) => unwrapped(await host.do(name, options, async () => await settled(fn))),
        sleep: async (name, milliseconds) => unwrapped(await host.sleep(name, milliseconds)),
        waitForEvent: async (name, options) => unwrapped(await host.waitForEvent(name, options)),
        callModel: async (request) => unwrapped(await host.callModel(request)),
        openDecision: async (request) => unwrapped(await host.openDecision(request)),
        decisionRecipients: async (decision, reminder) => unwrapped(await host.decisionRecipients(decision, reminder)),
        waitForDecision: async (name, options) => unwrapped(await host.waitForDecision(name, options)),
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

/**
 * The main module that dry-runs each of workflow `id`'s tests
 * (`dryRun`), with the parameter values core passes over each test's own.
 * Each report is cut to what core keeps of it.
 */
const dryRunMain = (
  id: WorkflowId
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { dryRun } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/testing"))};
import tests from ${JSON.stringify(appModuleName(workflowPaths(id).tests))};
${settling}
export class DryRuns extends WorkerEntrypoint {
  async run(params) {
    return await settled(async () => {
      if (tests?.definition?.metadata?.id !== ${JSON.stringify(id)}) {
        throw new Error(${JSON.stringify(`workflows/${id}.workflow-tests.ts must export the tests of "${id}" as its default export.`)});
      }
      const runs = [];
      for (const { name, expect: _expect, ...options } of tests.tests.slice(0, ${maxDryRuns})) {
        const run = await dryRun(tests.definition, { ...options, params: { ...options.params, ...params } });
        runs.push({ name: String(name).slice(0, 200), status: run.status, report: run.report.slice(0, ${maxDryRunReport}) });
      }
      return runs;
    });
  }
}
`;

/**
 * The main module that reads workflow `id`'s metadata from its code: its
 * parameters and its triggers.
 */
const metadataMain = (
  id: WorkflowId
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import definition from ${JSON.stringify(appModuleName(workflowPaths(id).workflow))};
${settling}
export class Metadata extends WorkerEntrypoint {
  async read() {
    return await settled(async () => {
      if (definition?.metadata?.id !== ${JSON.stringify(id)}) {
        throw new Error(${JSON.stringify(`workflows/${id}.ts must export the workflow "${id}" as its default export.`)});
      }
      const { params, triggers } = definition.metadata;
      return JSON.parse(JSON.stringify({ params, triggers }));
    });
  }
}
`;

/** The workflows in an App version's files, by ID. */
export const workflowIdsIn = (files: AppFiles): WorkflowId[] =>
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
  version: number,
  files: AppFiles
): Promise<Record<string, string>> => {
  const build = await buildWorkflows(env, files);
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
  { version, workflow, files, env: runEnv }: RunCode
) =>
  env.LOADER.get(null, async () => ({
    ...workflowSandbox,
    mainModule: runModule,
    modules: {
      ...(await modulesOf(env, version, files)),
      [runModule]: runMain(workflow),
    },
    env: runEnv,
  })).getEntrypoint<RunEntrypoint>("Run");

/** The most of why an isolate didn't start that a failure keeps. */
const maxLoadFailure = 500;

/**
 * workerd's "Failed to start Worker" message: first line, and what threw.
 * Should workerd word it otherwise, a start failure no longer matches, and
 * shows as the platform's error (`internal.unexpected`), never as passing.
 */
const failedStart = /^Failed to start Worker:\n(?:Uncaught )?(?<cause>.*)/u;

/**
 * What threw as an isolate's code loaded, without the stack, when `error`
 * is workerd's "Failed to start Worker"; nothing for any other error.
 */
const startFailure = (error: unknown): string | undefined => {
  const cause =
    error instanceof Error
      ? failedStart.exec(error.message)?.groups?.cause
      : undefined;
  return cause?.slice(0, maxLoadFailure);
};

/**
 * What workflow `id` declares at an App version (with its `files`), read
 * from its code in an isolate of their own, kept by the loader for that
 * version: a version's code never changes. Each part is checked by
 * whoever reads it, so a part one reader doesn't know stops only that
 * reader. `workflow.invalid` for code that doesn't load or say.
 */
const declaredMetadata = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles
): Promise<{ params?: unknown; triggers?: unknown }> => {
  const code = env.LOADER.get(
    `workflow-metadata:${app}:${version}:${id}:${compilerVersion}`,
    async () => ({
      ...workflowSandbox,
      mainModule: metadataModule,
      modules: {
        ...(await modulesOf(env, version, files)),
        [metadataModule]: metadataMain(id),
      },
      env: {},
    })
  ).getEntrypoint<MetadataEntrypoint>("Metadata");
  let outcome: Settled<unknown>;
  try {
    outcome = fromIsolate(await code.read());
  } catch (error) {
    // A module threw as it loaded (a definition the SDK refuses): the
    // code's failure, as `workflow.invalid`. Anything else is the
    // platform's.
    if (startFailure(error) === undefined) {
      throw error;
    }
    throw workflowErrors.create("workflow.invalid");
  }
  const metadata = outcome.ok
    ? declaredMetadataSchema.safeParse(outcome.value)
    : undefined;
  if (metadata?.success !== true) {
    throw workflowErrors.create("workflow.invalid");
  }
  return metadata.data;
};

/** The parameters workflow `id` declares at an App version. */
export const declaredParams = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles
): Promise<DeclaredParam[]> => {
  const { params } = await declaredMetadata(env, app, version, id, files);
  const parsed = declaredParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data;
};

/**
 * The triggers workflow `id` declares at an App version; none for a
 * definition that doesn't say (one not written with the SDK).
 */
export const declaredTriggers = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles
): Promise<TriggerDeclaration[]> => {
  const { triggers } = await declaredMetadata(env, app, version, id, files);
  const parsed = triggerDeclarationsSchema.optional().safeParse(triggers);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data ?? [];
};

/**
 * Why workflow `id`'s tests fail on a version's `modules`, one line each;
 * none if they pass. They run App code, once, as the version is made
 * current, in an isolate with no name, which nothing else shares and which
 * goes once they are done: workerd keeps a named isolate, the SDK's
 * modules in it, for as long as the process runs.
 */
const testFailures = async (
  env: Env,
  id: WorkflowId,
  modules: Record<string, string>
): Promise<string[]> => {
  const tests = env.LOADER.get(null, () => ({
    ...workflowSandbox,
    mainModule: testsModule,
    modules: { ...modules, [testsModule]: testsMain(id) },
    env: {},
  })).getEntrypoint<TestsEntrypoint>("Tests");
  let outcome: Settled<unknown>;
  try {
    outcome = fromIsolate(await tests.run());
  } catch (error) {
    // The isolate didn't start because a module threw as it loaded, such
    // as a workflow whose definition the SDK refuses: the code's failure,
    // reported as its tests'. Anything else is the platform's.
    const cause = startFailure(error);
    if (cause === undefined) {
      throw error;
    }
    return [`${id}: its code doesn't load: ${cause}`];
  }
  if (!outcome.ok) {
    return [`${id}: ${outcome.error.message}`];
  }
  const report = testReportSchema.safeParse(outcome.value);
  if (!report.success) {
    return [`${id}: its tests didn't report as the test harness does`];
  }
  const { passed, results } = report.data;
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
 * Dry-runs each of workflow `id`'s tests at an App version (with its
 * `files`), with `params` over each test's own values, in an isolate of
 * their own with an empty env: nothing a dry run does leaves it. The
 * loader keeps the isolate for that version, whose code never changes;
 * the values go with each call. A current version's workflows all have
 * tests (`requireWorkflowTestsPass`).
 */
export const dryRunTests = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles,
  params: Record<string, string | number>
): Promise<DryRuns> => {
  const code = env.LOADER.get(
    `workflow-dry-run:${app}:${version}:${id}:${compilerVersion}`,
    async () => ({
      ...workflowSandbox,
      mainModule: dryRunModule,
      modules: {
        ...(await modulesOf(env, version, files)),
        [dryRunModule]: dryRunMain(id),
      },
      env: {},
    })
  ).getEntrypoint<DryRunsEntrypoint>("DryRuns");
  let outcome: Settled<unknown>;
  try {
    outcome = fromIsolate(await code.run(params));
  } catch (error) {
    // As for parameters: a module that threw as it loaded is the code's
    // failure, anything else the platform's.
    if (startFailure(error) === undefined) {
      throw error;
    }
    throw workflowErrors.create("workflow.invalid");
  }
  const runs = outcome.ok ? dryRunsSchema.safeParse(outcome.value) : undefined;
  if (runs?.success !== true) {
    throw workflowErrors.create("workflow.invalid");
  }
  return runs.data;
};

/**
 * Refuses a version (with its `files`) whose workflows don't build, or
 * whose workflows' tests fail or are missing (`workflow.tests_failed`), so
 * no such version is made current. A version without workflows passes.
 */
export const requireWorkflowTestsPass = async (
  env: Env,
  version: number,
  files: AppFiles
): Promise<void> => {
  const ids = workflowIdsIn(files);
  if (ids.length === 0) {
    return;
  }
  const modules = await modulesOf(env, version, files);
  const failures: string[] = [];
  for (const id of ids) {
    if (Object.hasOwn(files, workflowPaths(id).tests)) {
      // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
      failures.push(...(await testFailures(env, id, modules)));
    } else {
      // Often a helper, not a workflow: say where shared code goes.
      failures.push(
        `${id}: has no tests (${workflowPaths(id).tests}). Only \`workflows/<id>.ts\` (an id without dots) is a workflow: put shared code in a folder under workflows/, such as workflows/lib/.`
      );
    }
  }
  if (failures.length > 0) {
    throw workflowErrors.create("workflow.tests_failed", {
      version,
      failures,
    });
  }
};
