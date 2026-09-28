import {
  manifestKey,
  moduleKey,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { consoleDatabase } from "../src/db/act.ts";
import { auditEvents, releases } from "../src/db/schema.ts";
import { importReleases, MAX_IMPORTS_PER_RUN } from "../src/releases/import.ts";
import type { ReleaseStore } from "../src/releases/import.ts";
import worker from "../src/server.ts";
import {
  buildRelease,
  nextReleaseId,
  publishRelease,
  putBlobs,
  putManifest,
} from "./releases.ts";

const db = consoleDatabase(env.DB);

const releaseRow = async (id: string) => {
  const [row] = await db.select().from(releases).where(eq(releases.id, id));
  return row;
};

const importEvents = async (id: string) =>
  await db
    .select()
    .from(auditEvents)
    .where(
      and(eq(auditEvents.action, "release.import"), eq(auditEvents.target, id))
    );

/** Runs an import, with the failures it logs kept out of the test output. */
const runImport = async (store: ReleaseStore = env.RELEASES) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {
    // Failed imports are logged; the tests read the result instead.
  });
  try {
    return await importReleases(store, db);
  } finally {
    errors.mockRestore();
  }
};

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
    await env.RELEASES.put(moduleKey(module.sha256), "export default {};//x");
    await putManifest(release);

    const result = await runImport();

    expect(result.failed).toContain(release.id);
    await expect(releaseRow(release.id)).resolves.toBeUndefined();
    await expect(importEvents(release.id)).resolves.toHaveLength(0);
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
    const retried = await runImport();
    expect(retried.imported).toContain(release.id);
  });

  it("refuses a manifest that names another release, or isn't a manifest", async () => {
    const release = await publishRelease({ notes: "feat(core): elsewhere" });
    const moved = nextReleaseId();
    await env.RELEASES.put(manifestKey(moved), release.manifestText);
    const garbled = nextReleaseId();
    await env.RELEASES.put(manifestKey(garbled), "{ not json");

    const result = await runImport();

    expect(result.failed).toStrictEqual(
      expect.arrayContaining([moved, garbled])
    );
    await expect(releaseRow(moved)).resolves.toBeUndefined();
    await expect(releaseRow(garbled)).resolves.toBeUndefined();
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
