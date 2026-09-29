import { compilerVersion, workflowPaths } from "@grasp-os/compiler";
import { describeWorkflow } from "@grasp-os/sdk/describe";
import type {
  AppFiles,
  ReviewChange,
  VersionReview,
} from "@grasp-os/shared/apps";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { OutlineNode, StepOutline } from "@grasp-os/shared/workflows";
import { z } from "zod";

import {
  appFor,
  appsListedFor,
  findVersion,
  toVersion,
  versionFiles,
} from "./apps.ts";
import type { VersionRow } from "./apps.ts";
import type { Member } from "./auth/identity.ts";
import { workspace } from "./durable-objects.ts";
import { activeGrants, listPermissions } from "./permissions.ts";
import {
  declaredParams,
  workflowIdsIn,
  workflowTestFailures,
} from "./workflows/code.ts";

// What a version changes, for the builder who reviews it before making
// it current: worked out here from the version and the App as they are
// now, never taken from whoever proposed it (the chat's agent, say), so a
// proposal can't describe itself as less than it is. Against the current
// version: who proposed it, its files and server code, its workflows with
// the steps and parameters that differ (a workflow counts as changed when
// code outside screens changed, which it may import; a step that calls
// the App's bindings may change things whether it says so or not), what
// the App asks for that no admin granted yet, what it holds and which of
// that making it current would ask an admin for again, and its workflows'
// tests, kept per version's files so they run once.

/** Most test failures a review lists. */
const maxFailures = 50;

/** The App's server code, which acts for whoever uses the App. */
const serverPath = "app/server.ts";

/** How `now` differs from `before`, or undefined when it doesn't. */
const changeOf = <T>(
  before: T | undefined,
  now: T | undefined,
  same: (one: T, other: T) => boolean
): ReviewChange | undefined => {
  if (before === undefined) {
    return now === undefined ? undefined : "added";
  }
  if (now === undefined) {
    return "removed";
  }
  return same(before, now) ? undefined : "modified";
};

/** The keys of both maps, sorted, with how each differs. */
const differences = <T>(
  before: ReadonlyMap<string, T>,
  now: ReadonlyMap<string, T>,
  same: (one: T, other: T) => boolean
): {
  name: string;
  change: ReviewChange;
  now: T | undefined;
  before: T | undefined;
}[] =>
  [...new Set([...before.keys(), ...now.keys()])].toSorted().flatMap((name) => {
    const change = changeOf(before.get(name), now.get(name), same);
    return change === undefined
      ? []
      : [{ name, change, now: now.get(name), before: before.get(name) }];
  });

const sameJson = (one: unknown, other: unknown): boolean =>
  JSON.stringify(one) === JSON.stringify(other);

/** A workflow's steps by name, wherever they are in its branches and loops. */
const stepsIn = (nodes: readonly OutlineNode[]): Map<string, StepOutline> => {
  const steps = new Map<string, StepOutline>();
  const walk = (list: readonly OutlineNode[]): void => {
    for (const node of list) {
      if (node.type === "step") {
        steps.set(node.name, node);
      } else if (node.type === "loop") {
        walk(node.steps);
      } else {
        walk(node.steps);
        walk(node.otherwise);
      }
    }
  };
  walk(nodes);
  return steps;
};

/** A workflow's steps as its code reads; null when it can't be read. */
const stepsOf = (
  files: AppFiles | undefined,
  id: string
): Map<string, StepOutline> | null => {
  const source = files?.[workflowPaths(id).workflow];
  if (source === undefined) {
    return new Map();
  }
  try {
    return stepsIn(describeWorkflow(source).steps);
  } catch {
    return null;
  }
};

/** A step without where it is written, to compare. */
const withoutLine = ({ line: _line, ...step }: StepOutline) => step;

/** A workflow's parameters at a version; null when they can't be read. */
const paramsOf = async (
  env: Env,
  app: AppId,
  at: { version: number; files: AppFiles } | undefined,
  id: WorkflowId
) => {
  if (at === undefined || !workflowIdsIn(at.files).includes(id)) {
    return new Map<string, unknown>();
  }
  try {
    const params = await declaredParams(env, app, at.version, id, at.files);
    return new Map<string, unknown>(params.map((param) => [param.name, param]));
  } catch (error) {
    // Workflow code that doesn't build or declare: said as unreadable.
    if (workflowErrors.codeOf(error) !== undefined) {
      return null;
    }
    throw error;
  }
};

/** Where a version's tests are kept, by its files' hash and the compiler. */
const testsKey = (app: AppId, tree: string): string =>
  `apps/${app}/tests/${tree}-${compilerVersion}.json`;

/** Test results as they are kept; anything else is run again. */
const keptTestsSchema = z.object({
  status: z.enum(["passed", "failed", "none"]),
  failures: z.array(z.string()).max(maxFailures),
});

/**
 * Keeps the test results of files with hash `tree`: what a check that
 * ran them found (agent-builds.ts), so a review doesn't run them again.
 */
export const keepTests = async (
  env: Env,
  app: AppId,
  tree: string,
  tests: { status: string; failures: string[] }
): Promise<void> => {
  const kept = keptTestsSchema.safeParse({
    ...tests,
    failures: tests.failures.slice(0, maxFailures),
  });
  if (kept.success) {
    await env.FILES.put(testsKey(app, tree), JSON.stringify(kept.data));
  }
};

/**
 * A version's workflows' tests: kept once per version's files (and
 * compiler), run the first time only.
 */
const testsOf = async (
  env: Env,
  app: AppId,
  { version, tree }: { version: number; tree: string },
  files: AppFiles
): Promise<VersionReview["tests"]> => {
  if (workflowIdsIn(files).length === 0) {
    return { status: "none", failures: [] };
  }
  const stored = await env.FILES.get(testsKey(app, tree));
  if (stored !== null) {
    const kept = keptTestsSchema.safeParse(JSON.parse(await stored.text()));
    if (kept.success) {
      return kept.data;
    }
  }
  let tests: VersionReview["tests"];
  try {
    const failures = await workflowTestFailures(env, version, files);
    tests = {
      status: failures.length === 0 ? "passed" : "failed",
      failures: failures.slice(0, maxFailures),
    };
  } catch (error) {
    if (workflowErrors.codeOf(error) !== "workflow.build_failed") {
      throw error;
    }
    tests = { status: "failed", failures: ["The workflows don't build."] };
  }
  await keepTests(env, app, tree, tests);
  return tests;
};

/** A path of code a workflow may import: anything outside `screens/`. */
const sharedCode = /^(?!screens\/).+\.(?:ts|tsx|js|mjs|json)$/u;

/** The chat's agent that proposed `row`, with its chat's title for them. */
const proposerOf = async (
  env: Env,
  by: Member,
  { proposedBy }: VersionRow
): Promise<VersionReview["proposedBy"]> => {
  if (proposedBy === null) {
    return null;
  }
  const workspaceId = workspaceIdSchema.safeParse(proposedBy.workspaceId);
  const chatTitle =
    by.userId === proposedBy.onBehalfOf && workspaceId.success
      ? await workspace(env, workspaceId.data).chatTitle(
          proposedBy.chatId,
          by.userId
        )
      : null;
  return { ...proposedBy, chatTitle };
};

/** What version `version` of App `app` changes, for its builders. */
export const reviewVersion = async (
  env: Env,
  by: Member,
  app: unknown,
  version: unknown
): Promise<VersionReview> => {
  const found = await appFor(env, by, app, "builder");
  const row = await findVersion(env, found.id, version);
  const files = await versionFiles(env, found.id, row.version);
  const { currentVersion: current } = found;
  // The current version itself changes nothing against itself.
  const before =
    current === null
      ? undefined
      : { version: current, files: await versionFiles(env, found.id, current) };
  const fileChanges = differences(
    new Map(Object.entries(before?.files ?? {})),
    new Map(Object.entries(files)),
    (one, other) => one === other
  );
  const changedPaths = new Set(fileChanges.map(({ name }) => name));
  const workflowIds = [
    ...new Set([
      ...workflowIdsIn(files),
      ...workflowIdsIn(before?.files ?? {}),
    ]),
  ].toSorted();
  const ownPaths = new Set(
    workflowIds.flatMap((id) => Object.values(workflowPaths(id)))
  );
  // Code outside screens a workflow may import, its server's too: when it
  // changes, every workflow may do something else.
  const shared = [...changedPaths].filter(
    (path) => sharedCode.test(path) && !ownPaths.has(path)
  );
  const workflows: VersionReview["workflows"] = [];
  for (const id of workflowIds) {
    const paths = workflowPaths(id);
    const ownChanged =
      changedPaths.has(paths.workflow) || changedPaths.has(paths.tests);
    const change = changeOf(
      before === undefined || !workflowIdsIn(before.files).includes(id)
        ? undefined
        : true,
      workflowIdsIn(files).includes(id) ? true : undefined,
      () => !ownChanged && shared.length === 0
    );
    if (change === undefined) {
      continue;
    }
    const stepsBefore = stepsOf(before?.files, id);
    const stepsNow = stepsOf(files, id);
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const paramsBefore = await paramsOf(env, found.id, before, id);
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const paramsNow = await paramsOf(
      env,
      found.id,
      { version: row.version, files },
      id
    );
    workflows.push({
      id,
      change,
      shared,
      steps:
        stepsBefore === null || stepsNow === null
          ? null
          : differences(
              stepsBefore,
              stepsNow,
              // A step that calls the App's bindings may do something else
              // once code it calls changed, its own unchanged.
              (one, other) =>
                sameJson(withoutLine(one), withoutLine(other)) &&
                (shared.length === 0 || (other.env ?? []).length === 0)
            ).map(({ name, change: stepChange, now, before: was }) => ({
              name,
              change: stepChange,
              sideEffect: (now ?? was)?.sideEffect ?? false,
              calls: (now ?? was)?.env ?? [],
            })),
      params:
        paramsBefore === null || paramsNow === null
          ? null
          : differences(paramsBefore, paramsNow, sameJson).map(
              ({ name, change: paramChange }) => ({ name, change: paramChange })
            ),
    });
  }
  const server = fileChanges.find(({ name }) => name === serverPath);
  return {
    version: toVersion(row),
    proposedBy: await proposerOf(env, by, row),
    current,
    files: fileChanges.map(({ name, change }) => ({ path: name, change })),
    server: server?.change ?? null,
    workflows,
    permissions: await listPermissions(
      env,
      by,
      { type: "app", appId: found.id },
      appsListedFor(env, by),
      "requested"
    ),
    grants: await activeGrants(env, by, found.id),
    tests: await testsOf(env, found.id, row, files),
  };
};
