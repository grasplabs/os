import {
  assetKey,
  manifestKey,
  moduleKey,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { consoleDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  releaseImportFailures,
  releases,
} from "../src/db/schema.ts";
import {
  importReleases,
  MAX_IMPORTS_PER_RUN,
  MAX_MANIFEST_BYTES,
  MAX_BLOBS_PER_RELEASE,
  MAX_READS_PER_RUN,
} from "../src/releases/import.ts";
import type { ReleaseStore } from "../src/releases/import.ts";
import worker from "../src/server.ts";
import {
  buildRelease,
  nextReleaseId,
  publishRelease,
  putBlobs,
  putManifest,
} from "./releases.ts";
import type { TestRelease } from "./releases.ts";

const db = consoleDatabase(env.DB);

const releaseRow = async (id: string) => {
  const [row] = await db.select().from(releases).where(eq(releases.id, id));
  return row;
};

const eventsFor = async (action: string, id: string) =>
  await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.target, id)));

const importEvents = async (id: string) =>
  await eventsFor("release.import", id);

const failureRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(releaseImportFailures)
    .where(eq(releaseImportFailures.releaseId, id));
  return row;
};

const MINUTE = 60 * 1000;

/** `minutes` from now: a later run, past a failed release's wait. */
const inMinutes = (minutes: number): Date =>
  new Date(Date.now() + minutes * MINUTE);

/** Runs an import, with the failures it logs kept out of the test output. */
const runImport = async (
  store: ReleaseStore = env.RELEASES,
  options: { now?: Date } = {}
) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {
    // Failed imports are logged; the tests read the result instead.
  });
  try {
    return await importReleases(store, db, options);
  } finally {
    errors.mockRestore();
  }
};

/** `env.RELEASES`, counting the reads of each key. */
const countingStore = () => {
  const reads = new Map<string, number>();
  const store: ReleaseStore = {
    list: async (options) => await env.RELEASES.list(options),
    get: async (key: string) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return await env.RELEASES.get(key);
    },
  };
  return { store, reads };
};

/** Where a release's one static asset is stored. */
const assetOf = (release: TestRelease): string => {
  const [hash] = Object.keys(release.manifest.assets);
  if (hash === undefined) {
    throw new Error("expected an asset");
  }
  return assetKey(hash);
};

/** Replaces `text` with text of the same length but other bytes. */
const sameSizeOther = (text: string): string =>
  text.replaceAll(/[0-9a-f]/gu, (char) => (char === "0" ? "1" : "0"));

describe("importing releases", () => {
  it("records a published release once its blobs verify, and audits it", async () => {
    const release = await publishRelease({ notes: "feat(core): one" });

    const result = await runImport();

    expect(result.imported).toContain(release.id);
    const row = await releaseRow(release.id);
    expect(row).toMatchObject({
      commitSha: release.manifest.commit,
      manifest: release.manifestText,
      manifestSha256: await sha256OfBytes(
        new TextEncoder().encode(release.manifestText)
      ),
      builtAt: new Date(release.manifest.createdAt),
    });
    const events = await importEvents(release.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "system",
      clientId: null,
      detail: JSON.stringify({
        commit: release.manifest.commit,
        manifestSha256: row?.manifestSha256,
      }),
    });
  });

  it("changes nothing when it runs again", async () => {
    const release = await publishRelease({ notes: "feat(core): again" });
    await runImport();
    const first = await releaseRow(release.id);

    const again = await runImport();

    expect(again.imported).not.toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toStrictEqual(first);
    await expect(importEvents(release.id)).resolves.toHaveLength(1);
  });

  it("records a release once when two runs import it at the same time", async () => {
    const release = await publishRelease({ notes: "feat(core): overlap" });
    // Both runs have seen the release as new before either records it:
    // each waits at the manifest until the other has reached it too.
    let arrived = 0;
    const { promise: barrier, resolve: bothArrived } =
      Promise.withResolvers<boolean>();
    const store: ReleaseStore = {
      list: async (options) => await env.RELEASES.list(options),
      get: async (key: string) => {
        if (key === manifestKey(release.id)) {
          arrived += 1;
          if (arrived === 2) {
            bothArrived(true);
          }
          await barrier;
        }
        return await env.RELEASES.get(key);
      },
    };

    const results = await Promise.all([runImport(store), runImport(store)]);

    expect(
      results.map((result) => result.imported.includes(release.id))
    ).toStrictEqual([true, true]);
    await expect(releaseRow(release.id)).resolves.toBeDefined();
    await expect(importEvents(release.id)).resolves.toHaveLength(1);
  });

  it("skips a release until its manifest is written", async () => {
    const release = await buildRelease({ notes: "feat(core): halfway" });
    await putBlobs(release);

    const before = await runImport();

    expect([...before.imported, ...before.failed]).not.toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toBeUndefined();

    await putManifest(release);
    const after = await runImport();

    expect(after.imported).toContain(release.id);
  });

  it("refuses a release whose blob isn't what its manifest says", async () => {
    // Its own module: blobs are shared by content, and this one is replaced.
    const release = await buildRelease({
      notes: "feat(core): tampered",
      core: `export default { tampered: "${crypto.randomUUID()}" };`,
    });
    await putBlobs(release);
    const [module] = release.manifest.workers.core?.modules ?? [];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    // The same size, so it's the hash that gives it away.
    const original = new TextDecoder().decode(
      release.blobs.get(moduleKey(module.sha256))
    );
    await env.RELEASES.put(moduleKey(module.sha256), sameSizeOther(original));
    await putManifest(release);

    const result = await runImport();

    expect(result.failed).toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toBeUndefined();
    await expect(importEvents(release.id)).resolves.toHaveLength(0);
  });

  it("refuses a release whose static asset isn't what its manifest says, whatever its size", async () => {
    const token = crypto.randomUUID();
    const sameSize = await buildRelease({
      notes: "feat(core): tampered asset",
      assets: { "/index.html": `<html>${token}</html>` },
    });
    const resized = await buildRelease({
      notes: "feat(core): resized asset",
      assets: { "/index.html": `<html>${token} resized</html>` },
    });
    await Promise.all([putBlobs(sameSize), putBlobs(resized)]);
    await env.RELEASES.put(
      assetOf(sameSize),
      `<html>${sameSizeOther(token)}</html>`
    );
    await env.RELEASES.put(assetOf(resized), "<html></html>");
    await Promise.all([putManifest(sameSize), putManifest(resized)]);

    const result = await runImport();

    expect(result.failed).toStrictEqual(
      expect.arrayContaining([sameSize.id, resized.id])
    );
    await expect(releaseRow(sameSize.id)).resolves.toBeUndefined();
    await expect(releaseRow(resized.id)).resolves.toBeUndefined();
  });

  it("refuses a release with a missing blob, and imports it once the blob is there", async () => {
    const release = await buildRelease({
      notes: "feat(core): missing blob",
      // Its own migration: blobs are shared by content, and this one is
      // deleted for a while.
      migrations: {
        "0000_only.sql": `-- ${crypto.randomUUID()}
CREATE TABLE t (id TEXT);`,
      },
    });
    const [key, bytes] =
      [...release.blobs].find(([blobKey]) =>
        blobKey.startsWith("blobs/migrations/")
      ) ?? [];
    if (key === undefined || bytes === undefined) {
      throw new Error("expected a migration");
    }
    await putBlobs(release);
    await env.RELEASES.delete(key);
    await putManifest(release);

    const failed = await runImport();
    expect(failed.failed).toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toBeUndefined();

    await env.RELEASES.put(key, bytes);
    const retried = await runImport(env.RELEASES, { now: inMinutes(6) });
    expect(retried.imported).toContain(release.id);
    await expect(failureRow(release.id)).resolves.toBeUndefined();
  });

  it("waits longer after each failed attempt, and audits each", async () => {
    const broken = nextReleaseId();
    await env.RELEASES.put(manifestKey(broken), "{ not json");
    const { store, reads } = countingStore();
    const attempts = () => reads.get(manifestKey(broken)) ?? 0;

    // Attempts at 0; the first wait is five minutes, so again at 6; the
    // second is ten, so again at 17, not at 15.
    const seen: number[] = [];
    for (const minutes of [0, 4, 6, 15, 17]) {
      // oxlint-disable-next-line no-await-in-loop -- runs in order
      await runImport(store, { now: inMinutes(minutes) });
      seen.push(attempts());
    }
    expect(seen).toStrictEqual([1, 1, 2, 2, 3]);

    await expect(failureRow(broken)).resolves.toMatchObject({ attempts: 3 });
    const events = await eventsFor("release.import_failed", broken);
    expect(events.map((event) => event.detail)).toStrictEqual([
      JSON.stringify({ attempts: 1 }),
      JSON.stringify({ attempts: 2 }),
      JSON.stringify({ attempts: 3 }),
    ]);
  });

  it("imports an older release past newer ones that are broken", async () => {
    const good = await publishRelease({ notes: "feat(core): older and good" });
    const broken = Array.from({ length: MAX_IMPORTS_PER_RUN + 1 }, () =>
      nextReleaseId()
    );
    await Promise.all(
      broken.map(
        async (id) => await env.RELEASES.put(manifestKey(id), "{ not json")
      )
    );

    const result = await runImport();

    expect(result.failed).toStrictEqual(expect.arrayContaining(broken));
    expect(result.imported).toContain(good.id);
  });

  it("refuses a manifest that names another release or commit, or isn't a manifest", async () => {
    const release = await publishRelease({ notes: "feat(core): elsewhere" });
    const moved = nextReleaseId();
    await env.RELEASES.put(manifestKey(moved), release.manifestText);
    const garbled = nextReleaseId();
    await env.RELEASES.put(manifestKey(garbled), "{ not json");
    // Its own id, but a commit its id's short SHA doesn't name.
    const otherCommit = await buildRelease({ notes: "feat(core): commit" });
    await putBlobs(otherCommit);
    await env.RELEASES.put(
      manifestKey(otherCommit.id),
      JSON.stringify({
        ...otherCommit.manifest,
        commit: sameSizeOther(otherCommit.manifest.commit),
      })
    );
    const huge = nextReleaseId();
    await env.RELEASES.put(
      manifestKey(huge),
      `{"padding":"${"x".repeat(MAX_MANIFEST_BYTES)}"}`
    );
    const bom = await buildRelease({ notes: "feat(core): bom" });
    await putBlobs(bom);
    await env.RELEASES.put(manifestKey(bom.id), `\uFEFF${bom.manifestText}`);
    const invalidUtf8 = nextReleaseId();
    await env.RELEASES.put(
      manifestKey(invalidUtf8),
      Uint8Array.from([0x7b, 0xff, 0x7d])
    );

    const result = await runImport();

    const refused = [moved, garbled, otherCommit.id, huge, bom.id, invalidUtf8];
    expect(result.failed).toStrictEqual(expect.arrayContaining(refused));
    const rows = await Promise.all(refused.map(releaseRow));
    expect(rows.filter((row) => row !== undefined)).toStrictEqual([]);
  });

  it("imports the newest releases first, the rest on the next run", async () => {
    const published = [];
    for (let count = 0; count <= MAX_IMPORTS_PER_RUN; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, oldest first
      published.push(await publishRelease({ notes: `feat(core): ${count}` }));
    }
    const [oldest, ...newest] = published.map((release) => release.id);

    const first = await runImport();

    expect(first.imported).toStrictEqual(newest.toReversed());
    await expect(releaseRow(oldest ?? "")).resolves.toBeUndefined();

    const second = await runImport();

    expect(second.imported).toContain(oldest);
  });

  it("counts two runs' failures of the same release at once as two attempts", async () => {
    const broken = nextReleaseId();
    await env.RELEASES.put(manifestKey(broken), "{ not json");
    // Both runs have seen the release as due before either records its
    // failure: each waits at the manifest until the other has reached it.
    let arrived = 0;
    const { promise: barrier, resolve: bothArrived } =
      Promise.withResolvers<boolean>();
    const store: ReleaseStore = {
      list: async (options) => await env.RELEASES.list(options),
      get: async (key: string) => {
        if (key === manifestKey(broken)) {
          arrived += 1;
          if (arrived === 2) {
            bothArrived(true);
          }
          await barrier;
        }
        return await env.RELEASES.get(key);
      },
    };
    const now = inMinutes(0);

    await Promise.all([runImport(store, { now }), runImport(store, { now })]);

    // The second attempt's wait is ten minutes.
    await expect(failureRow(broken)).resolves.toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(now.getTime() + 10 * MINUTE),
    });
    const events = await eventsFor("release.import_failed", broken);
    const details = events.map((event) => event.detail ?? "");
    expect(details.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      JSON.stringify({ attempts: 1 }),
      JSON.stringify({ attempts: 2 }),
    ]);
  });

  it("refuses a release naming more blobs than a run may read for one, before reading them", async () => {
    const token = crypto.randomUUID();
    const release = await publishRelease({
      notes: "feat(core): too many blobs",
      assets: Object.fromEntries(
        Array.from({ length: MAX_BLOBS_PER_RELEASE + 1 }, (_, index) => [
          `/asset-${index}.txt`,
          `${token} ${index}`,
        ])
      ),
    });
    const { store, reads } = countingStore();

    const result = await runImport(store);

    expect(result.failed).toContain(release.id);
    expect(
      [...reads.keys()].filter((key) => key.startsWith("blobs/"))
    ).toStrictEqual([]);
  });

  it("stops a run before a release whose reads don't fit, and imports it next run", async () => {
    // Each release reads a third of the budget and a little more: a run
    // has room for two.
    const assetCount = Math.floor(MAX_READS_PER_RUN / 3);
    const token = crypto.randomUUID();
    const assets = Object.fromEntries(
      Array.from({ length: assetCount }, (_, index) => [
        `/asset-${index}.txt`,
        `${token} ${index}`,
      ])
    );
    // Ids are handed out in call order: oldest first.
    const built = await Promise.all(
      [0, 1, 2].map(
        async (count) =>
          await buildRelease({ notes: `feat(core): big ${count}`, assets })
      )
    );
    // Blobs are content-addressed, so the three share their assets: each is
    // stored once, not three times, which keeps the test well inside its
    // timeout on a loaded machine.
    const blobs = new Map(built.flatMap((release) => [...release.blobs]));
    await putBlobs({ blobs });
    await Promise.all(
      built.map(async (release) => {
        await putManifest(release);
      })
    );
    const [oldest, middle, newest] = built.map((release) => release.id);

    const first = await runImport();
    const second = await runImport();

    expect(first.imported).toStrictEqual([newest, middle]);
    expect(second.imported).toContain(oldest);
  });

  it("reads the whole listing, a page at a time", async () => {
    const release = await publishRelease({ notes: "feat(core): paged" });
    const pages: string[] = [];
    // The real bucket, one release per page.
    const store: ReleaseStore = {
      get: async (key: string) => await env.RELEASES.get(key),
      list: async (options) => {
        const page = await env.RELEASES.list({ ...options, limit: 1 });
        pages.push(page.delimitedPrefixes.join(","));
        return page;
      },
    };

    const result = await runImport(store);

    expect(pages.length).toBeGreaterThan(1);
    expect(result.imported).toContain(release.id);
  });

  it("runs on the console's cron", async () => {
    const release = await publishRelease({ notes: "feat(core): cron" });

    await worker.scheduled(
      createScheduledController({ cron: "*/5 * * * *" }),
      env
    );

    await expect(releaseRow(release.id)).resolves.toBeDefined();
  });
});
