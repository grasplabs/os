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

  it("refuses a tag the release doesn't have, rather than run them all again", () => {
    expect(() => pendingMigrations(history, "v3")).toThrow(
      expect.objectContaining({ code: "unknown_migration_tag" })
    );
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

  it("refuses a placeholder it doesn't fill, and a D1 id that isn't its own binding's", () => {
    const refused = [
      [{ type: "kv_namespace", name: "KV", id: "$KV_KV_ID" }],
      // Another binding's placeholder.
      [{ type: "d1", name: "DB", id: "$D1_OTHER_ID" }],
      // A literal id where the placeholder belongs.
      [{ type: "d1", name: "DB", id: "uuid-elsewhere" }],
      // A D1 binding with no database listed for it.
      [{ type: "d1", name: "LOGS", id: "$D1_LOGS_ID" }],
    ].map((bindings) => {
      try {
        renderBindings(worker("core", bindings, d1), databases);
        return "rendered";
      } catch (error) {
        return error instanceof Error && "code" in error ? error.code : "other";
      }
    });
    expect(refused).toStrictEqual([
      "unknown_placeholder",
      "unknown_placeholder",
      "unknown_placeholder",
      "unknown_placeholder",
    ]);
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
