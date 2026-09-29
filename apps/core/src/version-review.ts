import {
  compilerVersion,
  serverFiles,
  workflowPaths,
} from "@grasp-os/compiler";
import { describeWorkflow } from "@grasp-os/sdk/describe";
import type {
  AppExports,
  AppFiles,
  ReviewChange,
  VersionReview,
} from "@grasp-os/shared/apps";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type {
  OutlineNode,
  StepOutline,
  TriggerDeclaration,
} from "@grasp-os/shared/workflows";
import { z } from "zod";

import { appFor, findVersion, toVersion, versionFiles } from "./apps.ts";
import type { VersionRow } from "./apps.ts";
import type { Member } from "./auth/identity.ts";
import { workspace } from "./durable-objects.ts";
import { permissionsOpenTo } from "./permissions-open.ts";
import { askedAgainBy } from "./permissions.ts";
import {
  declaredParams,
  declaredTriggers,
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
// the App's bindings may change things whether it says so or not, a step
// counts as changed when its code as written does, and every step when
// shared code changed), what
// the App asks for that no admin granted yet, what it holds and which of
// that making it current would ask an admin for again, and its workflows'
// tests, kept per version's files so they run once.

/** Most test failures a review lists. */
const maxFailures = 50;

/**
 * How an App's server code changed, from its files that did (`changes`)
 * and how many there were before and are now: added from none, removed
 * to none, modified otherwise; null when none changed.
 */
const serverChangeOf = (
  changes: readonly unknown[],
  before: number,
  now: number
): ReviewChange | null => {
  if (changes.length === 0) {
    return null;
  }
  if (before === 0) {
    return "added";
  }
  return now === 0 ? "removed" : "modified";
};

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

/** A workflow's triggers, by canonical JSON: each, and how many of it. */
type Triggers = Map<string, { trigger: TriggerDeclaration; count: number }>;

/**
 * A workflow's triggers at a version, counted by canonical JSON (two
 * identical ones both register, so both count): none where it has no such
 * workflow; null when they can't be read (code that doesn't build or
 * declare).
 */
const triggersOf = async (
  env: Env,
  app: AppId,
  at: { version: number; files: AppFiles } | undefined,
  id: WorkflowId
): Promise<Triggers | null> => {
  if (at === undefined || !workflowIdsIn(at.files).includes(id)) {
    return new Map();
  }
  try {
    const triggers = await declaredTriggers(env, app, at.version, id, at.files);
    const counted: Triggers = new Map();
    for (const trigger of triggers) {
      const key = canonicalJson(trigger);
      counted.set(key, {
        trigger,
        count: (counted.get(key)?.count ?? 0) + 1,
      });
    }
    return counted;
  } catch (error) {
    if (workflowErrors.codeOf(error) !== undefined) {
      return null;
    }
    throw error;
  }
};

/**
 * A workflow's triggers added and removed, with how many of each: what
 * makes it run on its own, counted as a multiset, so a second identical
 * trigger shows as one added.
 */
const triggerChanges = (
  before: Triggers,
  now: Triggers
): NonNullable<VersionReview["workflows"][number]["triggers"]> => {
  const keys = [...new Set([...now.keys(), ...before.keys()])];
  return keys.flatMap((key) => {
    const was = before.get(key);
    const is = now.get(key);
    const trigger = is?.trigger ?? was?.trigger;
    const difference = (is?.count ?? 0) - (was?.count ?? 0);
    if (trigger === undefined || difference === 0) {
      return [];
    }
    return [
      difference > 0
        ? { trigger, change: "added" as const, count: difference }
        : { trigger, change: "removed" as const, count: -difference },
    ];
  });
};

/**
 * How a version's exports (what other Apps may call, `app/exports.json`)
 * differ from the current version's: each by name, with its access now
 * and before.
 */
const exportChanges = (
  before: AppExports,
  now: AppExports
): VersionReview["exports"] =>
  differences(
    new Map(Object.entries(before)),
    new Map(Object.entries(now)),
    sameJson
  ).map(({ name, change, now: after, before: was }) => ({
    name,
    change,
    access: after?.access ?? null,
    accessBefore: was?.access ?? null,
  }));

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
 * compiler), run the first time only. A failure kept is shown as it was,
 * never run again: making the version current runs its tests anyway
 * (`requireWorkflowTestsPass`), so a kept result can't let one through.
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
  const ownChat = by.userId === proposedBy.onBehalfOf;
  const chatTitle =
    ownChat && workspaceId.success
      ? await workspace(env, workspaceId.data).chatTitle(
          proposedBy.chatId,
          by.userId
        )
      : null;
  return { ...proposedBy, ownChat, chatTitle };
};

/**
 * How a workflow's steps differ, by name, each compared as its code is
 * written. When code outside screens it may import changed (`shared`),
 * any step may do something else through it, whether its own code
 * changed or not, and whether or not it reads the App's bindings itself
 * (a helper may): every step is then listed, `sharedCode`, and said to
 * possibly change things outside Grasp if the workflow calls bindings at
 * all.
 */
const stepChanges = (
  before: ReadonlyMap<string, StepOutline>,
  now: ReadonlyMap<string, StepOutline>,
  shared: boolean
): NonNullable<VersionReview["workflows"][number]["steps"]> => {
  const usesBindings = [...now.values()].some(
    ({ env }) => (env ?? []).length > 0
  );
  return differences(
    before,
    now,
    (one, other) => !shared && sameJson(withoutLine(one), withoutLine(other))
  ).map(({ name, change, now: step, before: was }) => {
    const found = step ?? was;
    return {
      name,
      change,
      // A step that calls the App's bindings may change things, whether it
      // says so (`sideEffect`) or not.
      sideEffect:
        (found?.sideEffect ?? false) ||
        (found?.env ?? []).length > 0 ||
        (shared && usesBindings),
      calls: found?.env ?? [],
      sharedCode: shared,
    };
  });
};

/** A version's files, and its number. */
interface VersionAt {
  version: number;
  files: AppFiles;
}

/** A version's workflows that differ from the current version's. */
const workflowsOf = async (
  env: Env,
  app: AppId,
  {
    before,
    proposed,
    changedPaths,
  }: {
    before: VersionAt | undefined;
    proposed: VersionAt;
    changedPaths: ReadonlySet<string>;
  }
): Promise<VersionReview["workflows"]> => {
  const workflowIds = [
    ...new Set([
      ...workflowIdsIn(proposed.files),
      ...workflowIdsIn(before?.files ?? {}),
    ]),
  ].toSorted();
  // Code outside screens a workflow may import, another workflow's and the
  // server's too: when it changes, the workflow may do something else.
  const changedCode = [...changedPaths].filter((path) => sharedCode.test(path));
  const workflows: VersionReview["workflows"] = [];
  for (const id of workflowIds) {
    const paths = workflowPaths(id);
    const shared = changedCode.filter(
      (path) => path !== paths.workflow && path !== paths.tests
    );
    const ownChanged =
      changedPaths.has(paths.workflow) || changedPaths.has(paths.tests);
    const change = changeOf(
      before === undefined || !workflowIdsIn(before.files).includes(id)
        ? undefined
        : true,
      workflowIdsIn(proposed.files).includes(id) ? true : undefined,
      () => !ownChanged && shared.length === 0
    );
    if (change === undefined) {
      continue;
    }
    const stepsBefore = stepsOf(before?.files, id);
    const stepsNow = stepsOf(proposed.files, id);
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const paramsBefore = await paramsOf(env, app, before, id);
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const paramsNow = await paramsOf(env, app, proposed, id);
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const triggersBefore = await triggersOf(env, app, before, id);
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const triggersNow = await triggersOf(env, app, proposed, id);
    const steps =
      stepsBefore === null || stepsNow === null
        ? null
        : stepChanges(stepsBefore, stepsNow, shared.length > 0);
    workflows.push({
      id,
      change,
      shared,
      // This workflow can change things: steps that can't be read may do
      // anything, and any step, changed or not, that says so or calls
      // the App's bindings may (a new trigger runs them all).
      sideEffect:
        steps === null ||
        steps.some(({ sideEffect }) => sideEffect) ||
        [...(stepsNow?.values() ?? [])].some(
          ({ sideEffect, env: calls }) => sideEffect || (calls ?? []).length > 0
        ),
      steps,
      triggers:
        triggersBefore === null || triggersNow === null
          ? null
          : triggerChanges(triggersBefore, triggersNow),
      params:
        paramsBefore === null || paramsNow === null
          ? null
          : differences(paramsBefore, paramsNow, sameJson).map(
              ({ name, change: paramChange }) => ({ name, change: paramChange })
            ),
    });
  }
  return workflows;
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
  const workflows = await workflowsOf(env, found.id, {
    before,
    proposed: { version: row.version, files },
    changedPaths,
  });
  const serverChanges = differences(
    new Map(Object.entries(serverFiles(before?.files ?? {}))),
    new Map(Object.entries(serverFiles(files))),
    (one, other) => one === other
  );
  // Asked for again only if not kept, as `madeCurrent` says: an App's
  // first version copied from a blueprint, made current for the first time.
  const keep = current === null && row.approved === 1;
  // What other Apps may call of the current version, from its row.
  const currentRow =
    before === undefined
      ? undefined
      : await findVersion(env, found.id, before.version);
  const exportsBefore = currentRow?.exports ?? {};
  // What the App holds, as the permissions API shows it to this reviewer.
  const held = await permissionsOpenTo(
    env,
    by,
    { type: "app", appId: found.id },
    "active"
  );
  return {
    version: toVersion(row),
    proposedBy: await proposerOf(env, by, row),
    current,
    files: fileChanges.map(({ name, change }) => ({ path: name, change })),
    server: serverChangeOf(
      serverChanges,
      Object.keys(serverFiles(before?.files ?? {})).length,
      Object.keys(serverFiles(files)).length
    ),
    exports: exportChanges(exportsBefore, row.exports),
    serverFiles: serverChanges.map(({ name, change }) => ({
      path: name,
      change,
    })),
    workflows,
    // As the permissions API shows them to this reviewer, no more.
    permissions: await permissionsOpenTo(
      env,
      by,
      { type: "app", appId: found.id },
      "requested"
    ),
    grants: held.map((permission) => ({
      permission,
      askedAgain: askedAgainBy(by, permission, keep),
    })),
    tests: await testsOf(env, found.id, row, files),
  };
};
