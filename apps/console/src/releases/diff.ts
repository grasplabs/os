/**
 * What changes between two releases, read from their manifests: each
 * Worker's code, bindings and settings, its D1 migrations and its static
 * assets, and the platform's compatibility date and packages.
 */
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";

/** One thing that was added, removed or changed, with its values. */
export interface Change {
  name: string;
  change: "added" | "removed" | "changed";
  /** Its value in the older release, where it's shown. */
  from?: string;
  /** Its value in the newer release, where it's shown. */
  to?: string;
}

/** What changes in one Worker (core, connect). */
export interface WorkerDiff {
  worker: string;
  /** By module name; a change is new bytes. */
  modules: Change[];
  /** By binding name. */
  bindings: Change[];
  /** Crons, compatibility flags, required secrets, Durable Object migrations and the rest. */
  settings: Change[];
  /** By `<binding>/<file>`. */
  migrations: Change[];
  /** By URL path; a change is new bytes. */
  assets: Change[];
}

export interface ReleaseDiff {
  /** The compatibility date and each package's version. */
  platform: Change[];
  /** Every Worker in either release, by name. */
  workers: WorkerDiff[];
}

/** What changes from `from` to `to`, each a map of name to value. */
const changesBetween = (
  from: ReadonlyMap<string, string>,
  to: ReadonlyMap<string, string>,
  { showValues = false }: { showValues?: boolean } = {}
): Change[] => {
  const values = (before?: string, after?: string) =>
    showValues
      ? {
          ...(before === undefined ? {} : { from: before }),
          ...(after === undefined ? {} : { to: after }),
        }
      : {};
  const names = [...new Set([...from.keys(), ...to.keys()])].toSorted();
  return names.flatMap((name): Change[] => {
    const before = from.get(name);
    const after = to.get(name);
    if (before === after) {
      return [];
    }
    if (before === undefined) {
      return [{ name, change: "added", ...values(undefined, after) }];
    }
    if (after === undefined) {
      return [{ name, change: "removed", ...values(before) }];
    }
    return [{ name, change: "changed", ...values(before, after) }];
  });
};

const setting = (name: string, value: unknown): [string, string] => [
  name,
  JSON.stringify(value),
];

/** A Worker's settings besides its code, bindings, migrations and assets. */
const settingsOf = (worker: WorkerEntry | undefined): Map<string, string> => {
  if (worker === undefined) {
    return new Map();
  }
  return new Map([
    ...worker.crons.map((cron) => setting(`cron ${cron}`, cron)),
    ...worker.compatibilityFlags.map((flag) =>
      setting(`compatibility flag ${flag}`, flag)
    ),
    ...worker.requiredSecrets.map((secret) =>
      setting(`required secret ${secret}`, secret)
    ),
    ...worker.durableObjectMigrations.map((migration) =>
      setting(`Durable Object migration ${migration.tag}`, migration)
    ),
    setting("main module", worker.mainModule),
    setting("keep vars", worker.keepVars),
    setting("workers.dev", worker.workersDev),
    setting("preview URLs", worker.previewUrls),
    setting("observability", worker.observability),
    setting("assets config", worker.assets?.config ?? null),
  ]);
};

const modulesOf = (worker?: WorkerEntry) =>
  new Map(worker?.modules.map((file) => [file.name, file.sha256]));

const bindingsOf = (worker?: WorkerEntry) =>
  new Map(
    worker?.bindings.map((binding) => [binding.name, JSON.stringify(binding)])
  );

const migrationsOf = (worker?: WorkerEntry) =>
  new Map(
    worker?.d1Databases.flatMap((database) =>
      database.migrations.map((file) => [
        `${database.binding}/${file.name}`,
        file.sha256,
      ])
    )
  );

const assetsOf = (worker?: WorkerEntry) =>
  new Map(
    Object.entries(worker?.assets?.manifest ?? {}).map(([path, entry]) => [
      path,
      entry.hash,
    ])
  );

const platformOf = (manifest: ReleaseManifest) =>
  new Map([
    ["compatibility date", manifest.compatibilityDate],
    ["wrangler", manifest.wranglerVersion],
    ...Object.entries(manifest.packages),
  ]);

const workerDiff = (
  name: string,
  from: WorkerEntry | undefined,
  to: WorkerEntry | undefined
): WorkerDiff => ({
  worker: name,
  modules: changesBetween(modulesOf(from), modulesOf(to)),
  bindings: changesBetween(bindingsOf(from), bindingsOf(to)),
  settings: changesBetween(settingsOf(from), settingsOf(to)),
  migrations: changesBetween(migrationsOf(from), migrationsOf(to)),
  assets: changesBetween(assetsOf(from), assetsOf(to)),
});

/** What changes from release `from` to release `to`. */
export const diffReleases = (
  from: ReleaseManifest,
  to: ReleaseManifest
): ReleaseDiff => {
  const names = [
    ...new Set([...Object.keys(from.workers), ...Object.keys(to.workers)]),
  ].toSorted();
  return {
    platform: changesBetween(platformOf(from), platformOf(to), {
      showValues: true,
    }),
    workers: names.map((name) =>
      workerDiff(name, from.workers[name], to.workers[name])
    ),
  };
};
