import type { WorkerEntry } from "@grasp-os/shared/release";
import { describe, expect, it } from "vite-plus/test";

import { renderBindings } from "../src/deploy/upload.ts";
import { deployOrder, pendingMigrations } from "../src/deploy/versions.ts";

const history = [
  { tag: "v1", new_sqlite_classes: ["A"] },
  { tag: "v2", new_sqlite_classes: ["B"] },
];

const worker = (
  name: string,
  bindings: WorkerEntry["bindings"],
  d1Databases: WorkerEntry["d1Databases"] = []
): WorkerEntry => ({
  name,
  mainModule: "index.js",
  modules: [],
  compatibilityFlags: [],
  bindings,
  d1Databases,
  durableObjectMigrations: [],
  crons: [],
  requiredSecrets: [],
  keepVars: true,
  workersDev: false,
  previewUrls: false,
  observability: {},
});

describe("Durable Object migrations to upload", () => {
  it("runs every migration on a script that has none, and only the new ones after its tag", () => {
    expect([
      pendingMigrations(history),
      pendingMigrations(history, "v1"),
      pendingMigrations(history, "v2"),
      pendingMigrations([]),
    ]).toStrictEqual([
      {
        new_tag: "v2",
        steps: [{ new_sqlite_classes: ["A"] }, { new_sqlite_classes: ["B"] }],
      },
      { old_tag: "v1", new_tag: "v2", steps: [{ new_sqlite_classes: ["B"] }] },
      undefined,
      undefined,
    ]);
  });

  it("runs them all from a tag the release no longer has, as Wrangler does", () => {
    expect(pendingMigrations(history, "v0")).toStrictEqual({
      old_tag: "v0",
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["A"] }, { new_sqlite_classes: ["B"] }],
    });
  });
});

describe("a Worker's bindings", () => {
  const databases = new Map([["grasp-os-core", "uuid-core"]]);
  const d1 = [{ binding: "DB", databaseName: "grasp-os-core", migrations: [] }];

  it("fills in each D1 database's id", () => {
    expect(
      renderBindings(
        worker("core", [{ type: "d1", name: "DB", id: "$D1_DB_ID" }], d1),
        databases
      )
    ).toStrictEqual([{ type: "d1", name: "DB", id: "uuid-core" }]);
  });

  it("refuses a placeholder it doesn't fill", () => {
    expect(() =>
      renderBindings(
        worker(
          "core",
          [{ type: "kv_namespace", name: "KV", id: "$KV_KV_ID" }],
          d1
        ),
        databases
      )
    ).toThrow(/placeholder/u);
  });
});

describe("the order Workers deploy in", () => {
  it("puts a Worker another binds as a service first", () => {
    expect(
      deployOrder({
        core: worker("grasp-os-core", [
          { type: "service", name: "CONNECT", service: "grasp-os-connect" },
        ]),
        connect: worker("grasp-os-connect", []),
      })
    ).toStrictEqual(["connect", "core"]);
  });
});
