import type { SessionApi } from "@grasp-os/shared/rpc";
import { uploadTypes } from "@grasp-os/shared/uploads";
import type { Upload } from "@grasp-os/shared/uploads";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { extractUpload, originalKey } from "../src/knowledge/uploads.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Which extractor reads an uploaded file: Workers AI's document conversion
// for a normal collection, and the Worker itself for a sensitive
// collection, for a deployment whose rules keep everything in the EU, and
// without an AI binding. A sensitive file never reaches Workers AI.
// Workers AI is the outside system: a fake behind the AI binding's
// `toMarkdown`, which keeps what it was sent.

const idp = mockIdp();

/** The one model the tests' gateway allows (vite.config.ts). */
const testModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A test file, from the fixtures the test assets serve. */
const fixture = async (name: string): Promise<Uint8Array> => {
  const response = await env.ASSETS.fetch(`https://assets/uploads/${name}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** What the fake got: each file's name, type and size. */
interface Sent {
  name: string;
  type: string;
  bytes: number;
}

/**
 * Runs `run` with Workers AI answering each conversion with `answer`, and
 * returns what it was sent.
 */
const withWorkersAi = async (
  answer: (file: Sent) => ConversionResponse | Promise<ConversionResponse>,
  run: () => Promise<void>
): Promise<Sent[]> => {
  const sent: Sent[] = [];
  const converting = vi
    .spyOn(env.AI, "toMarkdown")
    .mockImplementation(async ({ name, blob }: MarkdownDocument) => {
      const file = { name, type: blob.type, bytes: blob.size };
      sent.push(file);
      return await answer(file);
    });
  try {
    await run();
  } finally {
    converting.mockRestore();
  }
  return sent;
};

/** A conversion of `name` into `markdown`. */
const converted = (name: string, markdown: string): ConversionResponse => ({
  id: crypto.randomUUID(),
  name,
  mimeType: uploadTypes.docx,
  format: "markdown",
  tokens: 0,
  data: markdown,
});

/** The upload once its extraction has ended, ready or failed. */
const ended = async (api: SessionApi, uploadId: string): Promise<Upload> =>
  await vi.waitFor(
    async () => {
      const upload = await api.uploads.get(uploadId);
      if (upload.status !== "ready" && upload.status !== "failed") {
        throw new Error(`Upload ${uploadId} is ${upload.status}`);
      }
      return upload;
    },
    { timeout: 20_000, interval: 100 }
  );

/** Uploads the Word fixture into `collectionId` and waits for it to end. */
const uploadedTo = async (
  api: SessionApi,
  collectionId: string
): Promise<Upload> => {
  const upload = await api.uploads.upload({
    collectionId,
    name: "travel-policy.docx",
    bytes: await fixture("travel-policy.docx"),
  });
  return await ended(api, upload.id);
};

/** Which extractor the audit log says read `upload`. */
const extractorOf = async (upload: Upload): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "knowledge.upload.extracted" && target?.id === upload.id
  )?.detail.extractor;
};

/** How many times the audit log says `upload` was sent to Workers AI. */
const timesSent = async (upload: Upload): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target, detail }) =>
      action === "knowledge.upload.sent" &&
      target?.id === upload.id &&
      detail.extractor === "workers-ai"
  ).length;
};

/** Runs `run` with `config` as the deployment's gateway config. */
const withDeployment = async (
  config: unknown,
  run: () => Promise<void>
): Promise<void> => {
  const { MODEL_GATEWAY: gateway } = env;
  env.MODEL_GATEWAY = config;
  try {
    await run();
  } finally {
    env.MODEL_GATEWAY = gateway;
  }
};

/** A gateway config whose rules keep every call of the deployment in the EU. */
const euOnly = {
  gateway: "grasp-os-test",
  models: [testModel],
  eu: { models: [testModel], deployment: true },
};

// Each test waits for an upload to end, up to 20 seconds (`ended`): more
// than Vitest's default five on a loaded runner. Sixty leaves room for
// signing in and making a team.
describe("upload routing", { timeout: 60_000 }, () => {
  it("send a normal collection's file to Workers AI, and save what it returns", async () => {
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await person.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "me",
    });
    let upload: Upload | undefined;
    const sent = await withWorkersAi(
      ({ name }) =>
        converted(name, "# Travel policy\n\n## Flights\n\nFly economy."),
      async () => {
        upload = await uploadedTo(person.api, collectionId);
      }
    );
    const { hits } = await person.api.knowledge.search("economy", {
      collectionId,
    });
    const docx = await fixture("travel-policy.docx");

    expect({
      sent,
      status: upload?.status,
      extractor: upload && (await extractorOf(upload)),
      recorded: upload && (await timesSent(upload)),
      hits: hits.map(({ path, headings }) => ({ path, headings })),
    }).toStrictEqual({
      sent: [
        {
          name: "travel-policy.docx",
          type: uploadTypes.docx,
          bytes: docx.length,
        },
      ],
      status: "ready",
      extractor: "workers-ai",
      recorded: 1,
      hits: [
        { path: "travel-policy.docx", headings: ["Travel policy", "Flights"] },
      ],
    });
  });

  it("never send a sensitive collection's file to Workers AI", async () => {
    const admin = await signedInApi(idp, "admin");
    const team = await newTeam(admin, []);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Payroll ${unique()}`,
      access: "teams",
      teams: [team],
      sensitive: true,
    });
    let upload: Upload | undefined;
    const sent = await withWorkersAi(
      ({ name }) => converted(name, "# Leaked"),
      async () => {
        upload = await uploadedTo(admin.api, collectionId);
      }
    );

    expect({
      sent,
      status: upload?.status,
      extractor: upload && (await extractorOf(upload)),
    }).toStrictEqual({ sent: [], status: "ready", extractor: "local" });
  });

  it("keep every file of a deployment whose rules keep everything in the EU in the Worker", async () => {
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await person.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "me",
    });
    const uploads: Upload[] = [];
    const sent = await withWorkersAi(
      ({ name }) => converted(name, "# Left the EU"),
      async () => {
        await withDeployment(euOnly, async () => {
          uploads.push(await uploadedTo(person.api, collectionId));
        });
      }
    );

    expect({
      sent,
      uploads: await Promise.all(
        uploads.map(async (upload) => ({
          status: upload.status,
          extractor: await extractorOf(upload),
          sent: await timesSent(upload),
        }))
      ),
    }).toStrictEqual({
      sent: [],
      uploads: [{ status: "ready", extractor: "local", sent: 0 }],
    });
  });

  it("keep a file in the Worker while the deployment's rules don't parse", async () => {
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await person.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "me",
    });
    let upload: Upload | undefined;
    const sent = await withWorkersAi(
      ({ name }) => converted(name, "# Left the Worker"),
      async () => {
        await withDeployment(
          { ...euOnly, eu: { deployment: "yes" } },
          async () => {
            upload = await uploadedTo(person.api, collectionId);
          }
        );
      }
    );

    expect({
      sent,
      status: upload?.status,
      extractor: upload && (await extractorOf(upload)),
      recorded: upload && (await timesSent(upload)),
    }).toStrictEqual({
      sent: [],
      status: "ready",
      extractor: "local",
      recorded: 0,
    });
  });

  it("send nothing to Workers AI while the record that it's sent can't be written", async () => {
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await person.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "me",
    });
    const bytes = await fixture("travel-policy.docx");
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.FILES.put(originalKey(collectionId, id), bytes);
    await env.KNOWLEDGE.prepare(
      `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
         uploaded_by, actor, status, created_at, updated_at)
       VALUES (?, ?, 'held.docx', ?, ?, 'x', ?, ?, 'pending', ?, ?)`
    )
      .bind(
        id,
        collectionId,
        uploadTypes.docx,
        bytes.length,
        person.userId,
        JSON.stringify({ type: "person", userId: person.userId }),
        now,
        now
      )
      .run();
    // Knowledge's database refusing every batch: the record's too.
    const refusing = new Proxy(env.KNOWLEDGE, {
      get: (target, property) => {
        if (property === "batch") {
          return async () =>
            await Promise.reject(new Error("D1 is down for a moment"));
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    let refused = "";
    const sent = await withWorkersAi(
      ({ name }) => converted(name, "# Sent"),
      async () => {
        refused = await outcome(
          extractUpload({ ...env, KNOWLEDGE: refusing }, id)
        );
      }
    );

    expect({ refused, sent }).toStrictEqual({
      refused: "Error: D1 is down for a moment",
      sent: [],
    });
  });

  it("extract every file in the Worker without an AI binding, as on-prem", async () => {
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await person.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "me",
    });
    const ai = env.AI;
    Reflect.set(env, "AI", undefined);
    let upload: Upload | undefined;
    try {
      upload = await uploadedTo(person.api, collectionId);
    } finally {
      Reflect.set(env, "AI", ai);
    }

    expect({
      status: upload.status,
      extractor: await extractorOf(upload),
    }).toStrictEqual({ status: "ready", extractor: "local" });
  });

  it("retry Workers AI while it can't be reached, recording each time the file was sent, then fail", async () => {
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await person.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "me",
    });
    await using introspector = await introspectWorkflow(env.WORKFLOWS);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    let upload: Upload | undefined;
    const sent = await withWorkersAi(
      () => {
        throw new Error("Workers AI is down");
      },
      async () => {
        upload = await uploadedTo(person.api, collectionId);
      }
    );

    expect({
      // The first try and its three retries.
      tries: sent.length,
      recorded: upload && (await timesSent(upload)),
      status: upload?.status,
      failure: upload?.failure,
    }).toStrictEqual({
      tries: 4,
      recorded: 4,
      status: "failed",
      failure: {
        code: "internal.unexpected",
        message: "Something went wrong.",
      },
    });
  });

  it("fail a file Workers AI can't convert at once, with a record that it was sent", async () => {
    const person = await signedInApi(idp, "user");
    const { id: collectionId } = await person.api.knowledge.createCollection({
      name: `Files ${unique()}`,
      access: "me",
    });
    let upload: Upload | undefined;
    const sent = await withWorkersAi(
      ({ name }) => ({
        id: crypto.randomUUID(),
        name,
        mimeType: uploadTypes.docx,
        format: "error",
        error: "Unsupported file",
      }),
      async () => {
        upload = await uploadedTo(person.api, collectionId);
      }
    );

    expect({
      tries: sent.length,
      recorded: upload && (await timesSent(upload)),
      status: upload?.status,
      failure: upload?.failure?.code,
    }).toStrictEqual({
      tries: 1,
      recorded: 1,
      status: "failed",
      failure: "upload.unreadable",
    });
  });
});
