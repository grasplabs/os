import { appErrors } from "@grasp-os/shared/apps";
import type {
  App,
  Blueprint,
  CreatedFromBlueprint,
  SavedBuild,
  VersionReview,
} from "@grasp-os/shared/apps";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Permission } from "@grasp-os/shared/permissions";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import { asPerson } from "./agent-person.ts";
import { chatAuthority, chatContext } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { createFromBlueprint, listBlueprints } from "./app-blueprints.ts";
import {
  appFor,
  applyChanges,
  createApp,
  draftOverLatest,
  latestVersion,
  proposeDraft,
  versionFiles,
} from "./apps.ts";
import type { Acting, Member } from "./auth/identity.ts";
import { workspace } from "./durable-objects.ts";
import { featureEnabled, requireFeature } from "./features.ts";
import { appsCollectionEnabled } from "./knowledge/access.ts";
import { appsCollectionId } from "./knowledge/app-entries.ts";
import { requestPermission } from "./permissions.ts";
import { isRestricted } from "./restricted.ts";
import { buildOnSave } from "./save-builds.ts";
import { keepTests, reviewVersion } from "./version-review.ts";
import {
  dryRunTests,
  hasWorkflow,
  workflowTestFailures,
} from "./workflows/code.ts";
import type { DryRuns } from "./workflows/code.ts";
import type { CheckOutcome, Draft } from "./workspace.ts";

// Building Apps from a chat: `await env.build.write(app, { ... })`. The
// chat's agent creates Apps (new, or from a blueprint the person may
// create from, by the rules people follow: app-blueprints.ts), and
// changes one in a draft of its own: one per chat and App, kept with the
// chat in its Workspace object (workspace.ts), over the App's latest
// version when it began. Builders'
// working copy never sees a draft, so the agent's edits and a builder's
// can't overwrite each other. It checks a draft as a save does (screens,
// server code and workflows: type errors, @shadcn/lint and build errors)
// and runs its workflows' tests, and dry-runs them with the values it
// gives. Tests and dry runs run in isolates with an empty env: nothing
// they do leaves them. Once a draft passes, the agent proposes it: it
// becomes the App's next version, pending review, with a review of what
// it changes worked out by core (version-review.ts). Nothing here makes a
// version current, or can: a builder of the App does, in Grasp, and what
// the App asks for waits for an admin to grant it.
//
// The repair loop is the agent loop itself: a check answers with what
// fails, the agent writes a fix and checks again, until it passes or
// `maxFailedChecks` checks of one draft failed in a row in one turn, when
// checking refuses and the agent tells the person what still fails. Each
// check takes its place against the limit before it runs (in the
// Workspace object, so checks started at once can't pass it). A draft
// takes at most `maxDryRunsPerTurn` dry runs a turn, and a turn creates at
// most `maxCreatesPerTurn` Apps.
//
// The person's rights bound every call, read again each time: creating an
// App needs a role that builds (and, from a blueprint, a role in its
// App), and changing one a builder's role in it.
// The agent needs a permission of its own too: `write` on the Apps
// collection, the company's catalog of Apps, which no one writes as
// Knowledge (it is read only), so granting it means only this. A chat
// that read restricted data writes no App code: what it read would reach
// everyone who builds the App. Every call is audited as `agent.call`, and
// what changes an App (`app.created`, `app.committed`,
// `app.version.proposed`, `permission.requested`) as the agent acting for
// the person.

/**
 * Most checks of one draft that may fail in a row in one turn: the repair
 * loop's step limit. Checks running at once count against it before they
 * run. A turn has at most 30 code runs (agent.ts), so this leaves it room
 * to answer.
 */
export const maxFailedChecks = 5;

/**
 * Most checks of one draft in one turn whose builds didn't finish in time
 * or couldn't run (`pending`): they don't count as failed, but each still
 * asks the compiler for work, so a build that never finishes can't be
 * checked without end.
 */
export const maxUnsettledChecks = 10;

/** Most dry runs of one draft in one turn, apart from its checks. */
export const maxDryRunsPerTurn = 10;

/** Most Apps the chat's agent may create in one turn. */
export const maxCreatesPerTurn = 3;

/**
 * How long a check waits for its builds. A code run has 30 seconds
 * (code-mode.ts), and the tests run after the builds.
 */
const checkWaitMs = 15_000;

/** Most diagnostics or test failures a check answers with, of each kind. */
const maxReported = 50;

/** Whether the agent may build Apps: `write` on the Apps collection. */
const buildsApps =
  (env: Env) =>
  (permissions: Permission[]): boolean =>
    appsCollectionEnabled(env) &&
    permissions.some(
      ({ object, actions }) =>
        object.type === "collection" &&
        object.collectionId === appsCollectionId &&
        actions.includes("write")
    );

/**
 * Refuses blueprints while they are off: as for people, whose blueprints
 * need App sharing on too, whose roles decide who creates from one.
 */
const requireBlueprints = (env: Env): void => {
  requireFeature(env, "app_sharing");
  requireFeature(env, "app_blueprints");
};

/** The values a dry run sets, by parameter name, over each test's own. */
const dryRunParamsSchema = z
  .record(
    z.string().regex(/^[A-Za-z]\w{0,63}$/u),
    z.union([z.string().max(10_000), z.number()])
  )
  .refine((params) => Object.keys(params).length <= 50, {
    message: "At most 50 parameters",
  });

/** A chat's draft of an App, as the agent reads it. */
export interface DraftFiles {
  /** The version it is over; null for an App with none yet. */
  base: number | null;
  /** The paths it changed (null content: deleted), sorted. */
  changed: string[];
  /** Every file of the App as the draft has it, by path. */
  files: Record<string, string>;
}

/** How a check of a draft went. */
export interface DraftCheck {
  /** It all builds and every workflow test passes: what proposing needs. */
  passed: boolean;
  /**
   * A build didn't finish in time, or couldn't run now, and nothing
   * failed: not counted as a failed check. The build goes on, and the
   * next check reads it from the cache.
   */
  pending: boolean;
  screens: SavedBuild;
  server: SavedBuild;
  workflows: SavedBuild;
  tests: {
    /** `not_run` while the workflows don't build. */
    status: "passed" | "failed" | "none" | "not_run";
    failures: string[];
  };
  /** Checks of this draft that failed in a row this turn. */
  failedInARow: number;
  /** How many may fail in a row before checking refuses. */
  maxFailedChecks: number;
}

/** The chat's draft of `app`, with the version it starts over when new. */
const draftOf = async (
  env: Env,
  { workspaceId, chatId }: AgentScope,
  app: AppId
): Promise<Draft> => {
  const draft = await workspace(env, workspaceId).draft(chatId, app);
  // No changes (none yet, or all gone): over the App's latest version.
  return Object.keys(draft.changes).length === 0
    ? { ...draft, base: await latestVersion(env, app) }
    : draft;
};

/** A draft's files: its base version's, with its changes over them. */
const filesOf = async (
  env: Env,
  app: AppId,
  { base, changes }: Pick<Draft, "base" | "changes">
): Promise<Map<string, string>> => {
  const files = new Map(
    base === null ? [] : Object.entries(await versionFiles(env, app, base))
  );
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  return files;
};

/** Whether a build lets a draft through: it built, or had nothing to. */
const buildPassed = ({ status }: SavedBuild): boolean =>
  status === "ok" || status === "none";

/**
 * Whether a build says nothing of the draft yet: still going past the
 * check's wait, or it couldn't run now. Nothing the agent could fix.
 */
const buildUnknown = ({ status }: SavedBuild): boolean =>
  status === "pending" || status === "error";

/**
 * How long a check waits for its builds: {@link checkWaitMs}, or less
 * where tests set `CHECK_BUILD_WAIT_MS`.
 */
const buildWaitMs = (env: Env): number => {
  const set = Number(env.CHECK_BUILD_WAIT_MS);
  return Number.isInteger(set) && set > 0 && set < checkWaitMs
    ? set
    : checkWaitMs;
};

/** A build as a check answers it: its first diagnostics only. */
const reported = (build: SavedBuild): SavedBuild => ({
  ...build,
  diagnostics: build.diagnostics.slice(0, maxReported),
});

/** The tests of a draft's workflows, once they build. */
const testsOf = async (
  env: Env,
  base: number | null,
  files: Record<string, string>,
  workflows: SavedBuild
): Promise<DraftCheck["tests"]> => {
  if (workflows.status === "none") {
    return { status: "none", failures: [] };
  }
  if (!buildPassed(workflows)) {
    return { status: "not_run", failures: [] };
  }
  const failures = await workflowTestFailures(env, base ?? 0, files);
  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures: failures.slice(0, maxReported),
  };
};

/** How a check counts: passed, failed, or neither while a build is pending. */
const outcomeOf = ({
  passed,
  pending,
}: Pick<DraftCheck, "passed" | "pending">): CheckOutcome => {
  if (passed) {
    return "passed";
  }
  return pending ? "pending" : "failed";
};

/**
 * Logs what failed after a draft was proposed (committed, and up for
 * review): the proposal stands, so the failure is no reason to fail it.
 */
const afterProposal =
  (stage: string, app: AppId, version: number) =>
  (error: unknown): undefined => {
    log.warn("agent.after_proposal_failed", {
      stage,
      appId: app,
      version,
      ...errorFields(error),
    });
    return undefined;
  };

/** Logs a turn's count that couldn't be settled; the call's own error goes on. */
const logCountFailure = (failure: unknown): void => {
  log.warn("agent.check_settle_failed", errorFields(failure));
};

/** Builds a draft's `files` and runs their workflows' tests (`check`). */
const checkFiles = async (
  env: Env,
  app: AppId,
  base: number | null,
  files: Record<string, string>
): Promise<Omit<DraftCheck, "failedInARow" | "maxFailedChecks">> => {
  const builds = await buildOnSave(
    env,
    { app, version: base ?? 0, files },
    buildWaitMs(env)
  );
  const tests = await testsOf(env, base, files, builds.workflows);
  const all = [builds.screens, builds.server, builds.workflows];
  const failed =
    all.some((build) => !buildPassed(build) && !buildUnknown(build)) ||
    tests.status === "failed";
  return {
    passed: !failed && all.every(buildPassed),
    pending: !failed && all.some(buildUnknown),
    screens: reported(builds.screens),
    server: reported(builds.server),
    workflows: reported(builds.workflows),
    tests,
  };
};

/** What proposing a draft did. */
export interface Proposal {
  /** The version it is now, pending review; null when it wasn't proposed. */
  version: number | null;
  check: DraftCheck;
  /**
   * What the version changes, as its reviewer reads it; null when it
   * wasn't proposed, or its review couldn't be worked out now
   * (`reviewUnavailable`: proposed all the same).
   */
  review: VersionReview | null;
  /** Proposed, but its review couldn't be worked out now: read it later. */
  reviewUnavailable: boolean;
}

/** Building Apps, as a chat's code does it. */
export class BuildApi extends WorkerEntrypoint<Env, AgentScope> {
  /**
   * Runs one build call as the chat's person, with the agent as the audit
   * log's actor for what it changes: once the agent may build Apps, and
   * only from a chat that hasn't read restricted data.
   */
  async #build<T>(
    method: string,
    run: (by: Acting) => Promise<T>,
    detail?: (result: T) => Record<string, AuditDetailValue>
  ): Promise<T> {
    const { env } = this;
    const scope = this.ctx.props;
    return await asPerson(env, scope, {
      feature: "app_builder",
      allowed: buildsApps(env),
      action: "write",
      method,
      read: async (person: Member) => {
        requireFeature(env, "apps");
        if (await isRestricted(env, chatAuthority(scope), chatContext(scope))) {
          throw permissionErrors.create("permission.restricted");
        }
        const authority = chatAuthority(scope);
        return await run({
          ...person,
          actor: delegateActorOf(authority),
          via: {
            type: "agent",
            agentId: scope.agentId,
            onBehalfOf: scope.personId,
            workspaceId: scope.workspaceId,
            chatId: scope.chatId,
          },
        });
      },
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** The App `app` names, which the person builds. */
  async #buildable(by: Acting, app: unknown): Promise<AppId> {
    const { id } = await appFor(this.env, by, app, "builder");
    return id;
  }

  /**
   * A new App, with no versions yet, owned by the person: at most
   * {@link maxCreatesPerTurn} a turn.
   */
  async create(input: unknown): Promise<App> {
    return await this.#build(
      "build.create",
      async (by) =>
        await this.#creating(async () => await createApp(this.env, by, input)),
      (created) => ({ app: created.id })
    );
  }

  /**
   * The blueprints the person may create an App from: of the Apps they
   * have a role in, newest first, as people's own list has them.
   */
  async blueprints(): Promise<Blueprint[]> {
    return await this.#build(
      "build.blueprints",
      async (by) => {
        requireBlueprints(this.env);
        return await listBlueprints(this.env, by);
      },
      (listed) => ({ blueprints: listed.length })
    );
  }

  /**
   * A new App owned by the person, from the blueprint of App `app` at
   * `version`, by the same rules as a person creating one
   * (app-blueprints.ts): only someone who builds, from a blueprint of an
   * App they have a role in. Its requests wait for an admin, recorded as
   * the agent's. Counted with `create`: at most {@link maxCreatesPerTurn}
   * a turn.
   */
  async createFromBlueprint(
    app: unknown,
    version: unknown,
    input: unknown
  ): Promise<CreatedFromBlueprint> {
    return await this.#build(
      "build.createFromBlueprint",
      async (by) => {
        requireBlueprints(this.env);
        return await this.#creating(
          async () =>
            await createFromBlueprint(this.env, by, app, version, input)
        );
      },
      (created) => ({
        app: created.app.id,
        blueprint: created.app.blueprint,
      })
    );
  }

  /**
   * Runs `create`, which creates an App, once it takes one of the Apps
   * the chat's agent may create this turn: given back when it creates
   * nothing.
   */
  async #creating<T>(create: () => Promise<T>): Promise<T> {
    const { workspaceId, chatId } = this.ctx.props;
    const taken = await workspace(this.env, workspaceId).takeCreate(
      chatId,
      maxCreatesPerTurn
    );
    if (!taken) {
      throw appErrors.create("app.creates_exhausted");
    }
    try {
      return await create();
    } catch (error) {
      // Refused (the person's role, say): it created nothing.
      await workspace(this.env, workspaceId)
        .releaseCreate(chatId)
        .catch(logCountFailure);
      throw error;
    }
  }

  /**
   * Runs `run`, one check or dry run of the chat's draft of App `app`,
   * once it takes one of the draft's checks this turn (`takeCheck`, before
   * anything runs, so checks started at once can't pass the limit), and
   * settles it however it ends: passed only when `run` says so.
   */
  async #counted<T extends Pick<DraftCheck, "passed" | "pending">>(
    app: AppId,
    run: () => Promise<T>
  ): Promise<{ result: T; failedInARow: number }> {
    const { workspaceId, chatId } = this.ctx.props;
    const chats = workspace(this.env, workspaceId);
    const taken = await chats.takeCheck(chatId, app, {
      failed: maxFailedChecks,
      unsettled: maxUnsettledChecks,
    });
    if (taken === "failed") {
      throw appErrors.create("app.checks_exhausted");
    }
    if (taken === "unsettled") {
      throw appErrors.create("app.builds_unfinished");
    }
    let result: T;
    try {
      result = await run();
    } catch (error) {
      // Settled as failed; a failure to settle is logged, never in the way
      // of why the check failed.
      await chats.settleCheck(chatId, app, "failed").catch(logCountFailure);
      throw error;
    }
    const failedInARow = await chats.settleCheck(
      chatId,
      app,
      outcomeOf(result)
    );
    return { result, failedInARow };
  }

  /** The chat's draft of `app`: all its files, and what it changed. */
  async files(app: unknown): Promise<DraftFiles> {
    return await this.#build(
      "build.files",
      async (by) => {
        const id = await this.#buildable(by, app);
        const draft = await draftOf(this.env, this.ctx.props, id);
        return {
          base: draft.base,
          changed: Object.keys(draft.changes).toSorted(),
          files: Object.fromEntries(await filesOf(this.env, id, draft)),
        };
      },
      (found) => ({
        app: typeof app === "string" ? app : null,
        base: found.base,
      })
    );
  }

  /**
   * Writes `changes` (new content by path, or null to delete a file) into
   * the chat's draft of `app`, refused as a whole as a write to the
   * working copy would be. The version it is over, and what it changed.
   */
  async write(
    app: unknown,
    changes: unknown
  ): Promise<Omit<DraftFiles, "files">> {
    return await this.#build(
      "build.write",
      async (by) => {
        const id = await this.#buildable(by, app);
        const draft = await draftOf(this.env, this.ctx.props, id);
        const base = await filesOf(this.env, id, {
          base: draft.base,
          changes: {},
        });
        const written = applyChanges(
          this.env,
          await filesOf(this.env, id, draft),
          changes
        );
        // Only what differs from the base is kept: a path written back as
        // the base has it (a deleted file that isn't there, too) is a
        // change no more. A draft holds at most the base's paths and the
        // files it adds, which the App's limits bound.
        const kept = written.filter(
          ([path, content]) => (content ?? undefined) !== base.get(path)
        );
        const unchanged = written.flatMap(([path, content]) =>
          (content ?? undefined) === base.get(path) ? [path] : []
        );
        const saved = await workspace(
          this.env,
          this.ctx.props.workspaceId
        ).saveDraft(
          this.ctx.props.chatId,
          id,
          draft.base,
          Object.fromEntries(kept),
          unchanged,
          draft.revision
        );
        if (!saved) {
          throw appErrors.create("app.conflict");
        }
        const changed = new Set([
          ...Object.keys(draft.changes),
          ...kept.map(([path]) => path),
        ]);
        for (const path of unchanged) {
          changed.delete(path);
        }
        return { base: draft.base, changed: [...changed].toSorted() };
      },
      (written) => ({
        app: typeof app === "string" ? app : null,
        files: written.changed.length,
      })
    );
  }

  /** Drops the chat's draft of `app`: the next write starts over. */
  async discard(app: unknown): Promise<void> {
    await this.#build(
      "build.discard",
      async (by) => {
        const id = await this.#buildable(by, app);
        const { workspaceId, chatId } = this.ctx.props;
        await workspace(this.env, workspaceId).dropDraft(chatId, id);
      },
      () => ({ app: typeof app === "string" ? app : null })
    );
  }

  /**
   * Checks the chat's draft of `app`: builds its screens, server code and
   * workflows, and runs its workflows' tests. Refused once
   * {@link maxFailedChecks} checks of it failed in a row this turn, those
   * still running counted.
   */
  async check(app: unknown): Promise<DraftCheck> {
    return await this.#build(
      "build.check",
      async (by) => {
        const id = await this.#buildable(by, app);
        const draft = await draftOf(this.env, this.ctx.props, id);
        const files = Object.fromEntries(await filesOf(this.env, id, draft));
        const { result, failedInARow } = await this.#counted(
          id,
          async () => await checkFiles(this.env, id, draft.base, files)
        );
        return { ...result, failedInARow, maxFailedChecks };
      },
      (result) => ({
        app: typeof app === "string" ? app : null,
        passed: result.passed,
        failedInARow: result.failedInARow,
      })
    );
  }

  /**
   * Proposes the chat's draft of `app` for review: checks it over the
   * App's latest version (as `check` does, and counted with its checks),
   * and once it passes commits it as the App's next version, pending, with
   * `message`, and drops the draft. A builder makes it current, in Grasp.
   * A draft that fails isn't proposed: what fails comes back instead.
   */
  async propose(app: unknown, message: unknown): Promise<Proposal> {
    return await this.#build(
      "build.propose",
      async (by) => {
        const id = await this.#buildable(by, app);
        const { workspaceId, chatId } = this.ctx.props;
        const draft = await draftOf(this.env, this.ctx.props, id);
        if (Object.keys(draft.changes).length === 0) {
          throw appErrors.create("app.nothing_to_commit");
        }
        const over = await draftOverLatest(this.env, id, draft);
        const counted = await this.#counted(
          id,
          async () =>
            await checkFiles(
              this.env,
              id,
              draft.base,
              Object.fromEntries(over.files)
            )
        );
        const check = {
          ...counted.result,
          failedInARow: counted.failedInARow,
          maxFailedChecks,
        };
        if (!check.passed) {
          return {
            version: null,
            check,
            review: null,
            reviewUnavailable: false,
          };
        }
        const proposed = await proposeDraft(this.env, by, id, over, message);
        // Committed and up for review: from here on it is proposed, however
        // the rest goes, and says so, so the agent doesn't try again (and
        // meet nothing to commit). What follows is logged when it fails.
        const { version, tree } = proposed;
        // The check ran the tests of exactly these files: the review takes
        // its result rather than running them again.
        if (check.tests.status !== "not_run") {
          await keepTests(this.env, id, tree, check.tests).catch(
            afterProposal("keep_tests", id, version)
          );
        }
        // Only the revision committed: a write since stays a draft.
        await workspace(this.env, workspaceId)
          .dropDraft(chatId, id, draft.revision)
          .catch(afterProposal("drop_draft", id, version));
        const review = await reviewVersion(this.env, by, id, version).catch(
          afterProposal("review", id, version)
        );
        return {
          version,
          check,
          review: review ?? null,
          reviewUnavailable: review === undefined,
        };
      },
      (proposal) => ({
        app: typeof app === "string" ? app : null,
        version: proposal.version,
        passed: proposal.check.passed,
      })
    );
  }

  /**
   * Asks for a permission for `app` (a connection, a collection, a
   * workflow or another App's exports), as its builders do: it allows
   * nothing until an admin grants it.
   */
  async requestPermission(app: unknown, request: unknown): Promise<Permission> {
    return await this.#build(
      "build.requestPermission",
      async (by) => {
        const id = await this.#buildable(by, app);
        const subject = { type: "app", appId: id };
        return await requestPermission(
          this.env,
          by,
          typeof request === "object" && request !== null
            ? { ...request, subject }
            : request,
          async (named, role) => {
            if (featureEnabled(this.env, "app_sharing")) {
              await appFor(this.env, by, named, role);
            }
          }
        );
      },
      (requested) => ({
        app: typeof app === "string" ? app : null,
        permission: requested.id,
      })
    );
  }

  /**
   * Dry-runs each test of workflow `workflow` in the chat's draft of
   * `app`, with `params` over each test's own values: what it would do,
   * with every step's side effect recorded, never made. At most
   * {@link maxDryRunsPerTurn} a turn.
   */
  async dryRun(
    app: unknown,
    workflow: unknown,
    params: unknown = {}
  ): Promise<DryRuns> {
    return await this.#build(
      "build.dryRun",
      async (by) => {
        const id = await this.#buildable(by, app);
        const values = appErrors.parse(
          "app.invalid",
          dryRunParamsSchema,
          params
        );
        const draft = await draftOf(this.env, this.ctx.props, id);
        const files = Object.fromEntries(await filesOf(this.env, id, draft));
        const workflowId = workflowIdSchema.safeParse(workflow);
        if (!workflowId.success || !hasWorkflow(files, workflowId.data)) {
          throw appErrors.create("app.invalid", {
            issues: ["workflow: The draft has no such workflow."],
          });
        }
        // A turn runs only so many, apart from its checks.
        const { workspaceId, chatId } = this.ctx.props;
        const taken = await workspace(this.env, workspaceId).takeDryRun(
          chatId,
          id,
          maxDryRunsPerTurn
        );
        if (!taken) {
          throw appErrors.create("app.dry_runs_exhausted");
        }
        return await dryRunTests(
          this.env,
          id,
          draft.base ?? 0,
          workflowId.data,
          files,
          values,
          { draft: true }
        );
      },
      (runs) => ({
        app: typeof app === "string" ? app : null,
        workflow: typeof workflow === "string" ? workflow : null,
        runs: runs.length,
      })
    );
  }
}

/** The types `env.build` returns, as the model reads them. */
const buildTypes = `/** One build's result: \`none\` when there's nothing of its kind. */
interface Build {
  status: "ok" | "failed" | "none" | "pending" | "error";
  diagnostics: {
    file: string | null;
    line: number | null;
    column?: number;
    /** A TypeScript code (TS2322), a lint rule (shadcn/no-restyle) or a compiler stage. */
    rule?: string;
    severity: "error" | "warning";
    message: string;
    /** A change that would fix it, when the check suggests one. */
    fix?: string;
  }[];
  /** Why it couldn't run, with \`error\`. */
  error?: string;
}`;

/** What the model reads of `env.build`. */
const buildDeclaration = `/**
 * Building Apps for the person: create one, or change one they build, in
 * this chat's own draft of it (builders' working copy never sees it). Write
 * files, check them, fix what fails and check again. Nothing here makes a
 * change live: a builder of the App does that in Grasp.
 *
 * Screens are \`screens/<name>.tsx\` on @grasp-os/ui components with their
 * variants and sizes and the theme's tokens: no raw colours, arbitrary
 * values or restyled components (the lint names what to use instead).
 * Server methods are in \`app/server.ts\`. A workflow is
 * \`workflows/<id>.ts\` with its tests in \`workflows/<id>.workflow-tests.ts\`.
 */
build: {
  /** Creates an App owned by the person, with no files yet: at most ${maxCreatesPerTurn} a question. */
  create(app: { name: string; description?: string }): Promise<{ id: string; name: string }>;
  /** The blueprints the person may create an App from, newest first: \`app\` and \`version\` name each. */
  blueprints(): Promise<{ app: string; name: string; description: string; version: number }[]>;
  /**
   * Creates an App owned by the person from the blueprint of App \`app\` at
   * \`version\`: the blueprint's code as its first version, and a request
   * for each permission the blueprint's App has, which an admin grants or
   * not. Counts with \`create\`: at most ${maxCreatesPerTurn} a question. Change it
   * afterwards in a draft, as any App.
   */
  createFromBlueprint(app: string, version: number, created: { name: string; description?: string }): Promise<{
    app: { id: string; name: string };
    version: { version: number };
    permissions: { id: string; binding: string; status: string }[];
    /** Connections and other Apps' workflows or exports it doesn't ask for, by binding. */
    dropped: { binding: string }[];
    droppedApps: { binding: string }[];
  }>;
  /**
   * This chat's draft of an App: every file as the draft has them, the
   * version it is over (the App's latest when the draft began), and the
   * paths it changed.
   */
  files(app: string): Promise<{ base: number | null; changed: string[]; files: Record<string, string> }>;
  /** Writes files into the draft: new content by path, or null to delete one. */
  write(app: string, changes: Record<string, string | null>): Promise<{ base: number | null; changed: string[] }>;
  /** Drops the draft: the next write starts again from the App's latest version. */
  discard(app: string): Promise<void>;
  /**
   * Builds the draft's screens, server code and workflows (type errors,
   * lint and build errors) and runs its workflows' tests. Fix what fails
   * and check again; after ${maxFailedChecks} checks in a row that didn't pass, checking
   * refuses: stop and tell the person what still fails.
   */
  check(app: string): Promise<{
    passed: boolean;
    /**
     * A build is still going (or couldn't run now) and nothing failed: not
     * a failed check. Check again: the next one reads the build's result.
     * After ${maxUnsettledChecks} such checks in a question, checking refuses.
     */
    pending: boolean;
    screens: Build;
    server: Build;
    workflows: Build;
    tests: { status: "passed" | "failed" | "none" | "not_run"; failures: string[] };
    failedInARow: number;
    maxFailedChecks: number;
  }>;
  /**
   * Dry-runs a workflow's tests in the draft with \`params\` over each
   * test's values: what it would do, its side effects recorded, never made.
   * At most ${maxDryRunsPerTurn} a question.
   */
  dryRun(app: string, workflow: string, params?: Record<string, string | number>): Promise<{
    name: string;
    status: "completed" | "failed";
    report: string;
  }[]>;
  /**
   * Proposes the draft for review: checks it over the App's latest version
   * and, once it passes, makes it the App's next version, pending, with
   * \`message\` (what changed and why, for the reviewer). A builder of the App
   * reviews what it changes and makes it current in Grasp: tell the person
   * so. One that fails isn't proposed: \`version\` is null, and \`check\` says why.
   * Once \`version\` is set, it is proposed: don't propose it again. When
   * \`reviewUnavailable\`, its review couldn't be worked out now; the
   * builder reads it in Grasp.
   */
  propose(app: string, message: string): Promise<{
    version: number | null;
    /** \`pending\`: a build is still going; propose again shortly. */
    check: { passed: boolean; pending: boolean; screens: Build; server: Build; workflows: Build; tests: { status: string; failures: string[] } };
    /** What the version changes, as its reviewer reads it; null when not proposed. */
    review: {
      current: number | null;
      files: { path: string; change: "added" | "modified" | "removed" }[];
      /** How the server code (app/**.ts) changed: it acts for whoever uses the App. */
      server: "added" | "modified" | "removed" | null;
      serverFiles: { path: string; change: "added" | "modified" | "removed" }[];
      workflows: {
        id: string;
        change: "added" | "modified" | "removed";
        /** Changed code outside screens it may use. */
        shared: string[];
        /** \`sharedCode\`: listed because code it may use changed. */
        steps: { name: string; change: string; sideEffect: boolean; calls: string[]; sharedCode: boolean }[] | null;
        params: { name: string; change: string }[] | null;
        /** What makes it run on its own, added or removed. */
        triggers: { trigger: Record<string, unknown>; change: "added" | "removed"; count: number }[] | null;
        /** It can change something outside Grasp (any step may, or its steps can't be read). */
        sideEffect: boolean;
      }[];
      /** What other Apps may call (app/exports.json), with read/write access. */
      exports: { name: string; change: string; access: "read" | "write" | null; accessBefore: "read" | "write" | null }[];
      permissions: { id: string; object: Record<string, unknown>; actions: string[]; binding: string }[];
      /** What the App holds, and which making it current asks an admin for again. */
      grants: { permission: { id: string; binding: string; actions: string[] }; askedAgain: boolean }[];
      tests: { status: "passed" | "failed" | "none"; failures: string[] };
    } | null;
    reviewUnavailable: boolean;
  }>;
  /**
   * Asks for a permission the App needs, as its builders do: an admin
   * grants it or not, and it allows nothing until then. \`binding\` is the
   * name the App's code reaches it by, such as \`MAIL\`.
   */
  requestPermission(app: string, request: {
    object:
      | { type: "connection"; connectionId: string; resource?: string }
      | { type: "collection"; collectionId: string }
      | { type: "workflow"; appId: string; workflowId: string }
      | { type: "app"; appId: string };
    actions: string[];
    binding: string;
  }): Promise<{ id: string; status: string }>;
};`;

/** `env.build`. */
export const buildApi: AgentApi = {
  name: "build",
  types: buildTypes,
  declaration: buildDeclaration,
  stub: (scope) => exports.BuildApi({ props: scope }),
};
