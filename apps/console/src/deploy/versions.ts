/**
 * Uploading a release's Workers to a client's account and sending all
 * their traffic to it.
 *
 * A Worker is uploaded as a new version with every secret it needs, so the
 * version works after a rollback too and rolls back with its secrets. Two
 * uploads go as a script upload instead, which deploys at once: a Worker's
 * first, and one that runs Durable Object migrations, which a version
 * can't carry. Which migrations it carries is worked out from the tag the
 * account's script is at, as Wrangler does.
 *
 * Each Worker goes live before the next is uploaded (connect before core,
 * which binds it), so a script upload of core, live at once, never runs
 * against the connect it replaced.
 */
import type { WorkerEntry } from "@grasp-os/shared/release";

import type { CloudflareApi } from "../cloudflare/api.ts";
import {
  deployVersion,
  liveVersion,
  putSchedules,
  putWorkflow,
  scriptMigrationState,
  setScriptSubdomain,
  uploadScript,
  uploadVersionWithSecrets,
} from "../cloudflare/workers.ts";
import type { Secret, WorkerUpload } from "../cloudflare/workers.ts";
import { DeployError } from "./errors.ts";

/** The migrations section of a script upload, as the API takes it. */
interface MigrationsUpload {
  old_tag?: string;
  new_tag: string;
  steps: Record<string, unknown>[];
}

/**
 * The Durable Object migrations the script at `tag` hasn't run, from the
 * release's whole ordered history; none when it's at the last one. A tag
 * the history doesn't have is refused (`unknown_migration_tag`), where
 * Wrangler would run them all again: the script ran migrations this
 * release doesn't know, such as a later release's, and replaying the rest
 * could undo them.
 */
export const pendingMigrations = (
  history: WorkerEntry["durableObjectMigrations"],
  tag?: string
): MigrationsUpload | undefined => {
  const last = history.at(-1);
  const at =
    tag === undefined ? -1 : history.findIndex((step) => step.tag === tag);
  if (tag !== undefined && at === -1) {
    throw new DeployError(
      "unknown_migration_tag",
      `The script is at Durable Object migration ${tag}, which the release doesn't have`
    );
  }
  if (last === undefined || at === history.length - 1) {
    return undefined;
  }
  const steps = history.slice(at + 1).map(({ tag: _tag, ...step }) => step);
  return {
    ...(tag === undefined ? {} : { old_tag: tag }),
    new_tag: last.tag,
    steps,
  };
};

/**
 * Uploads `worker` with exactly `secrets` and returns its version's id. A
 * script upload (the Worker's first, or one with Durable Object
 * migrations) is live at once; a version waits for `deployWorker`.
 */
export const uploadWorker = async (
  api: CloudflareApi,
  accountId: string,
  worker: WorkerEntry,
  upload: WorkerUpload,
  secrets: readonly Secret[]
): Promise<string> => {
  const script = await scriptMigrationState(api, accountId, worker.name);
  const migrations = pendingMigrations(
    worker.durableObjectMigrations,
    script.migrationTag
  );
  if (script.exists && migrations === undefined) {
    const version = await uploadVersionWithSecrets(
      api,
      accountId,
      worker.name,
      upload,
      secrets
    );
    return version.id;
  }
  await uploadScript(
    api,
    accountId,
    worker.name,
    {
      ...upload,
      metadata: {
        ...upload.metadata,
        ...(migrations === undefined ? {} : { migrations }),
      },
    },
    secrets
  );
  const live = await liveVersion(api, accountId, worker.name);
  if (live === undefined) {
    throw new Error(`${worker.name}'s upload left no version live`);
  }
  return live;
};

/**
 * Sends all of `worker`'s traffic to `versionId`, unless it already goes
 * there, then sets what goes with it: its cron triggers, whether it's on
 * workers.dev (its preview URLs never are), and the Workflows it runs.
 * Each is a PUT or a set, so it can run again.
 */
export const deployWorker = async (
  api: CloudflareApi,
  accountId: string,
  worker: WorkerEntry,
  versionId: string,
  message: string
): Promise<void> => {
  if ((await liveVersion(api, accountId, worker.name)) !== versionId) {
    await deployVersion(api, accountId, worker.name, versionId, { message });
  }
  await putSchedules(api, accountId, worker.name, worker.crons);
  await setScriptSubdomain(api, accountId, worker.name, {
    enabled: worker.workersDev,
    previewsEnabled: false,
  });
  for (const binding of worker.bindings) {
    const { workflow_name: name, class_name: className } = binding;
    if (
      binding.type === "workflow" &&
      typeof name === "string" &&
      typeof className === "string"
    ) {
      // oxlint-disable-next-line no-await-in-loop -- a Worker runs one or two
      await putWorkflow(api, accountId, name, {
        className,
        scriptName: worker.name,
      });
    }
  }
};

/**
 * The order to upload and deploy a release's Workers in, by app: a Worker
 * another one binds as a service goes before it, as connect before core.
 */
export const deployOrder = (workers: Record<string, WorkerEntry>): string[] => {
  const bound = new Set(
    Object.values(workers).flatMap((worker) =>
      worker.bindings.flatMap((binding) =>
        binding.type === "service" && typeof binding.service === "string"
          ? [binding.service]
          : []
      )
    )
  );
  const apps = Object.keys(workers).toSorted();
  const first = apps.filter((app) => bound.has(workers[app]?.name ?? ""));
  return [...first, ...apps.filter((app) => !first.includes(app))];
};
