import { workflowPaths } from "@grasp-os/compiler";
import { describeWorkflow } from "@grasp-os/sdk/describe";
import type {
  AppFiles,
  ReviewChange,
  VersionReview,
} from "@grasp-os/shared/apps";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { OutlineNode, StepOutline } from "@grasp-os/shared/workflows";

import {
  appFor,
  appsListedFor,
  findVersion,
  toVersion,
  versionFiles,
} from "./apps.ts";
import type { Member } from "./auth/identity.ts";
import { listPermissions } from "./permissions.ts";
import {
  declaredParams,
  workflowIdsIn,
  workflowTestFailures,
} from "./workflows/code.ts";

// What a version changes, for the builder who reviews it before making
// it current: worked out here from the version and the App as they are
// now, never taken from whoever proposed it (the chat's agent, say), so a
// proposal can't describe itself as less than it is. Against the current
// version: its files, its workflows with the steps and parameters that
// differ, what the App asks for that no admin granted yet, and its
// workflows' tests, run now.

/** Most test failures a review lists. */
const maxFailures = 50;

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

/** A version's workflows' tests, run now. */
const testsOf = async (
  env: Env,
  version: number,
  files: AppFiles
): Promise<VersionReview["tests"]> => {
  if (workflowIdsIn(files).length === 0) {
    return { status: "none", failures: [] };
  }
  try {
    const failures = await workflowTestFailures(env, version, files);
    return {
      status: failures.length === 0 ? "passed" : "failed",
      failures: failures.slice(0, maxFailures),
    };
  } catch (error) {
    if (workflowErrors.codeOf(error) === "workflow.build_failed") {
      return { status: "failed", failures: ["The workflows don't build."] };
    }
    throw error;
  }
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
  const workflows: VersionReview["workflows"] = [];
  for (const id of workflowIds) {
    const paths = workflowPaths(id);
    const change = changeOf(
      before === undefined || !workflowIdsIn(before.files).includes(id)
        ? undefined
        : true,
      workflowIdsIn(files).includes(id) ? true : undefined,
      () => !changedPaths.has(paths.workflow) && !changedPaths.has(paths.tests)
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
      steps:
        stepsBefore === null || stepsNow === null
          ? null
          : differences(stepsBefore, stepsNow, (one, other) =>
              sameJson(withoutLine(one), withoutLine(other))
            ).map(({ name, change: stepChange, now, before: was }) => ({
              name,
              change: stepChange,
              sideEffect: (now ?? was)?.sideEffect ?? false,
            })),
      params:
        paramsBefore === null || paramsNow === null
          ? null
          : differences(paramsBefore, paramsNow, sameJson).map(
              ({ name, change: paramChange }) => ({ name, change: paramChange })
            ),
    });
  }
  return {
    version: toVersion(row),
    current,
    files: fileChanges.map(({ name, change }) => ({ path: name, change })),
    workflows,
    permissions: await listPermissions(
      env,
      by,
      { type: "app", appId: found.id },
      appsListedFor(env, by),
      "requested"
    ),
    tests: await testsOf(env, row.version, files),
  };
};
