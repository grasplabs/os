import { deriveClientSecret } from "@grasp-os/shared/client-secrets";
import type { WorkerEntry } from "@grasp-os/shared/release";
import { describe, expect, it } from "vite-plus/test";

import { rotationWindowMs, workerSecrets } from "../src/deploy/secrets.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";

const connect: WorkerEntry = {
  name: "grasp-os-connect",
  mainModule: "index.js",
  modules: [],
  compatibilityFlags: [],
  bindings: [],
  d1Databases: [],
  durableObjectMigrations: [],
  crons: [],
  requiredSecrets: ["CAPABILITY_SIGNING_KEY"],
  keepVars: true,
  workersDev: false,
  previewUrls: false,
  observability: {},
};
const core: WorkerEntry = { ...connect, name: "grasp-os-core" };

const secrets: DeploySecrets = {
  routerKey: "router-key",
  clientKey: "client-key",
  shared: { connect: { COMPOSIO_API_KEY: "composio" } },
};

const now = new Date(Date.UTC(2026, 8, 28, 12));
/** A day after a rotation went live, and a day after its window closed. */
const liveRecently = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const liveLongAgo = new Date(
  now.getTime() - rotationWindowMs - 24 * 60 * 60 * 1000
);

const derived = async (
  purpose: string,
  generation: number,
  encoding: "hex" | "base64" = "hex",
  key = "client-key"
) => await deriveClientSecret(key, purpose, "acme", generation, encoding);

/** `app`'s secrets by name, for generation `generation` rotated at `rotationLiveAt`. */
const byName = async (
  app: "core" | "connect",
  generation: number,
  rotationLiveAt: Date | null,
  given = secrets
) => {
  const values = await workerSecrets(
    app,
    app === "core" ? core : connect,
    given,
    { id: "acme", generation, rotationLiveAt },
    now
  );
  return Object.fromEntries(values.map(({ name, value }) => [name, value]));
};

describe("a Worker's secrets", () => {
  it("are derived for the client's generation, with the shared ones it's given", async () => {
    await expect(byName("connect", 1, null)).resolves.toStrictEqual({
      COMPOSIO_API_KEY: "composio",
      CAPABILITY_SIGNING_KEY: await derived("capability", 1),
      TOKEN_ENCRYPTION_KEY: await derived("token-encryption", 1, "base64"),
    });
  });

  it("carry the previous generation's keys for a week after a rotation, the router secret's included", async () => {
    await expect(byName("connect", 2, liveRecently)).resolves.toStrictEqual({
      COMPOSIO_API_KEY: "composio",
      CAPABILITY_SIGNING_KEY: await derived("capability", 2),
      CAPABILITY_SIGNING_KEY_PREVIOUS: await derived("capability", 1),
      TOKEN_ENCRYPTION_KEY: await derived("token-encryption", 2, "base64"),
      TOKEN_ENCRYPTION_KEY_PREVIOUS: await derived(
        "token-encryption",
        1,
        "base64"
      ),
    });
    await expect(byName("core", 2, liveRecently)).resolves.toStrictEqual({
      ROUTER_SECRET: await derived("router", 2, "hex", "router-key"),
      ROUTER_SECRET_PREVIOUS: await derived("router", 1, "hex", "router-key"),
      BETTER_AUTH_SECRET: await derived("better-auth", 2),
      CAPABILITY_SIGNING_KEY: await derived("capability", 2),
    });
  });

  it("carry the previous keys while the rotation isn't live yet, however long ago it was raised", async () => {
    const names = Object.keys(await byName("core", 2, null));
    expect(names).toContain("ROUTER_SECRET_PREVIOUS");
  });

  it("drop the previous keys once the rotation's window has closed", async () => {
    const names = Object.keys(await byName("connect", 2, liveLongAgo));
    expect(names.toSorted()).toStrictEqual([
      "CAPABILITY_SIGNING_KEY",
      "COMPOSIO_API_KEY",
      "TOKEN_ENCRYPTION_KEY",
    ]);
  });

  it("refuse every derived name and every previous name given as a shared one", async () => {
    const names = [
      "ROUTER_SECRET",
      "ROUTER_SECRET_PREVIOUS",
      "BETTER_AUTH_SECRET",
      "CAPABILITY_SIGNING_KEY",
      "CAPABILITY_SIGNING_KEY_PREVIOUS",
      "TOKEN_ENCRYPTION_KEY",
      "TOKEN_ENCRYPTION_KEY_PREVIOUS",
    ];
    const codes = await Promise.all(
      names.map(async (name) => {
        try {
          await byName("connect", 1, null, {
            ...secrets,
            shared: { connect: { [name]: "from-elsewhere" } },
          });
          return "given";
        } catch (error) {
          return error instanceof Error && "code" in error
            ? error.code
            : "other";
        }
      })
    );
    expect(codes).toStrictEqual(names.map(() => "reserved_secret_name"));
  });

  it("refuse a required secret with no value", async () => {
    await expect(
      workerSecrets(
        "connect",
        { ...connect, requiredSecrets: ["MICROSOFT_CLIENT_SECRET"] },
        secrets,
        { id: "acme", generation: 1, rotationLiveAt: null },
        now
      )
    ).rejects.toMatchObject({ code: "missing_secret" });
  });
});
