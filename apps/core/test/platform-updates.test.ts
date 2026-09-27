import type { AuditEvent } from "@grasp-os/shared/audit";
import { auditEventTypeOf } from "@grasp-os/shared/audit-log";
import type { PlatformChange } from "@grasp-os/shared/platform-change";
import { describe, expect, it } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";

// Platform updates: the every-minute cron records each version of core it
// hasn't seen running as `platform.updated`, with the change the console
// set on it, once per version however many cron runs see it.

/** A version's metadata as the binding gives it, with an ID of its own. */
const newVersion = (): WorkerVersionMetadata => ({
  id: crypto.randomUUID(),
  tag: "",
  timestamp: "2031-01-02T03:04:05.000Z",
});

const change: PlatformChange = {
  by: "staff@grasp.test",
  what: "release",
  release: "r000123-abcdef0",
  at: "2031-01-02T03:04:00.000Z",
};

/** The `platform.updated` events recorded for `version`, oldest first. */
const updatesOf = async ({
  id,
}: WorkerVersionMetadata): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === "platform.updated" && event.target?.id === id
  );
};

describe("platform updates", () => {
  it("are recorded once per new version, with the change that made it", async () => {
    const version = newVersion();
    await runCron({ CF_VERSION_METADATA: version, PLATFORM_CHANGE: change });
    await runCron({ CF_VERSION_METADATA: version, PLATFORM_CHANGE: change });

    const updates = await updatesOf(version);
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update?.actor).toStrictEqual({ type: "system" });
    expect(update?.target).toStrictEqual({ type: "version", id: version.id });
    expect(update?.detail).toStrictEqual({
      versionId: version.id,
      versionCreatedAt: version.timestamp,
      by: change.by,
      what: change.what,
      release: change.release,
      changedAt: change.at,
    });
    expect(update && auditEventTypeOf(update)).toBe("platform_update");
  });

  it("take the change from a var set as text, as local dev sets it", async () => {
    const version = newVersion();
    await runCron({
      CF_VERSION_METADATA: version,
      PLATFORM_CHANGE: JSON.stringify(change),
    });

    const [update] = await updatesOf(version);
    expect(update?.detail).toMatchObject({ by: change.by });
  });

  it.each([
    ["missing", undefined],
    ["invalid", { ...change, at: "yesterday" }],
  ])("name an unknown change when the var is %s", async (_case, value) => {
    const version = newVersion();
    await runCron({ CF_VERSION_METADATA: version, PLATFORM_CHANGE: value });

    const [update] = await updatesOf(version);
    expect(update?.detail).toStrictEqual({
      versionId: version.id,
      versionCreatedAt: version.timestamp,
      by: "unknown",
      what: "unknown",
      release: "unknown",
      changedAt: null,
    });
  });

  it("record a rollback to an earlier version again", async () => {
    const earlier = newVersion();
    const later = newVersion();
    await runCron({ CF_VERSION_METADATA: earlier });
    await runCron({ CF_VERSION_METADATA: later });
    await runCron({ CF_VERSION_METADATA: earlier });

    await expect(updatesOf(earlier)).resolves.toHaveLength(2);
    await expect(updatesOf(later)).resolves.toHaveLength(1);
  });

  it("are recorded once when cron runs see a new version at the same time", async () => {
    const version = newVersion();
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        await runCron({ CF_VERSION_METADATA: version });
      })
    );

    await expect(updatesOf(version)).resolves.toHaveLength(1);
  });

  it("are not recorded without version metadata, as on plain workerd", async () => {
    const before = await allEvents();
    await runCron({ CF_VERSION_METADATA: undefined });

    const after = await allEvents();
    expect(
      after
        .slice(before.length)
        .filter((event) => event.action === "platform.updated")
    ).toStrictEqual([]);
  });
});
