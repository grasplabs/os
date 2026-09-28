import { deriveClientSecret } from "@grasp-os/shared/client-secrets";
import type { WorkerEntry } from "@grasp-os/shared/release";
import { describe, expect, it } from "vite-plus/test";

import { workerSecrets } from "../src/deploy/secrets.ts";
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

const secrets: DeploySecrets = {
  routerKey: "router-key",
  clientKey: "client-key",
  shared: { connect: { COMPOSIO_API_KEY: "composio" } },
};

const derived = async (
  purpose: string,
  generation: number,
  encoding: "hex" | "base64" = "hex"
) =>
  await deriveClientSecret("client-key", purpose, "acme", generation, encoding);

const byName = async (generation: number, given = secrets) => {
  const values = await workerSecrets("connect", connect, given, {
    id: "acme",
    generation,
  });
  return Object.fromEntries(values.map(({ name, value }) => [name, value]));
};

describe("a Worker's secrets", () => {
  it("are derived for the client's generation, with the shared ones it's given", async () => {
    await expect(byName(1)).resolves.toStrictEqual({
      COMPOSIO_API_KEY: "composio",
      CAPABILITY_SIGNING_KEY: await derived("capability", 1),
      TOKEN_ENCRYPTION_KEY: await derived("token-encryption", 1, "base64"),
    });
  });

  it("keep the previous generation's keys after a rotation, so what they sealed and signed still opens", async () => {
    await expect(byName(2)).resolves.toStrictEqual({
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
  });

  it("refuse a derived secret given as a shared one", async () => {
    await expect(
      byName(1, {
        ...secrets,
        shared: { connect: { TOKEN_ENCRYPTION_KEY: "from-elsewhere" } },
      })
    ).rejects.toThrow(/derived/u);
  });

  it("refuse a required secret with no value", async () => {
    await expect(
      workerSecrets(
        "connect",
        { ...connect, requiredSecrets: ["MICROSOFT_CLIENT_SECRET"] },
        secrets,
        { id: "acme", generation: 1 }
      )
    ).rejects.toMatchObject({ name: "MissingSecretError" });
  });
});
