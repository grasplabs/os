import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { SessionApi } from "@grasp-os/shared/rpc";
import {
  uploadMaxBytes,
  uploadOriginalPath,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import type { Upload } from "@grasp-os/shared/uploads";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { extractionRunId, originalKey } from "../src/knowledge/uploads.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { finished } from "./runs.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

// Files uploaded into Knowledge, through the API people use: each becomes
// a document at its name, its text extracted by core's own workflow on the
// engine, searchable by section once ready; the same name again is the
// next version; a file that can't be read fails with a reason its
// uploader sees, and its original is deleted; and an original is only
// ever downloaded as an attachment, by those who may read its document.

const idp = mockIdp();

/** A test file, from the fixtures the test assets serve. */
const fixture = async (name: string): Promise<Uint8Array> => {
  const response = await env.ASSETS.fetch(`https://assets/uploads/${name}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** Someone signed in, with a collection of their own. */
const personWithCollection = async () => {
  const person = await signedInApi(idp, "user");
  const collection = await person.api.knowledge.createCollection({
    name: `Files ${unique()}`,
    access: "me",
  });
  return { ...person, collectionId: collection.id };
};

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

/** Uploads a fixture as `name` and waits for it to end. */
const uploaded = async (
  person: { api: SessionApi; collectionId: string },
  file: string,
  name = file
): Promise<Upload> => {
  const upload = await person.api.uploads.upload({
    collectionId: person.collectionId,
    name,
    bytes: await fixture(file),
  });
  return await ended(person.api, upload.id);
};

/** A file's SHA-256, in hex. */
const sha256Of = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

/** Whether R2 holds the original of the fixture `file` in the collection. */
const originalStored = async (
  collectionId: string,
  file: string
): Promise<boolean> => {
  const key = originalKey(collectionId, await sha256Of(await fixture(file)));
  return (await env.FILES.head(key)) !== null;
};

// Each test waits for its uploads to end, with up to 20 seconds each
// (`ended`), and several upload a few files: more than Vitest's default
// five seconds on a loaded runner. Sixty fits the longest, with room for
// signing in.
/**
 * Records a pending upload of `file`, unchanged for an hour, with its
 * original stored: as core leaves one that stopped between recording it
 * and starting its run.
 */
const leftPending = async (
  person: { userId: string; collectionId: string },
  file: string
): Promise<string> => {
  const bytes = await fixture(file);
  const sha256 = await sha256Of(bytes);
  const id = crypto.randomUUID();
  const longAgo = Date.now() - 60 * 60_000;
  await env.FILES.put(originalKey(person.collectionId, sha256), bytes);
  await env.KNOWLEDGE.prepare(
    `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
       uploaded_by, actor, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  )
    .bind(
      id,
      person.collectionId,
      file,
      uploadTypes.docx,
      bytes.length,
      sha256,
      person.userId,
      JSON.stringify({ type: "person", userId: person.userId }),
      longAgo,
      longAgo
    )
    .run();
  return id;
};

describe("uploads", { timeout: 60_000 }, () => {
  it("make a PDF, a Word file and a workbook searchable by section", async () => {
    const person = await personWithCollection();
    const [pdf, docx, xlsx] = await Promise.all([
      uploaded(person, "expense-policy.pdf"),
      uploaded(person, "travel-policy.docx"),
      uploaded(person, "offices.xlsx"),
    ]);
    const search = async (query: string) => {
      const { hits } = await person.api.knowledge.search(query, {
        collectionId: person.collectionId,
      });
      return hits.map(({ path, title, type, headings }) => ({
        path,
        title,
        type,
        headings,
      }));
    };
    const events = await allEvents();

    expect({
      statuses: [pdf, docx, xlsx].map(({ status, version, failure }) => ({
        status,
        version,
        failure,
      })),
      receipts: await search("thirty days"),
      mileage: await search("mileage"),
      flights: await search("economy"),
      contacts: await search("facilities"),
      audited: [pdf, docx, xlsx].map(({ id, documentId }) => ({
        received: events.some(
          ({ action, target }) =>
            action === "knowledge.upload.received" && target?.id === id
        ),
        saved: events.some(
          ({ action, target }) =>
            action === "knowledge.document.saved" && target?.id === documentId
        ),
      })),
    }).toStrictEqual({
      statuses: [
        { status: "ready", version: 1, failure: null },
        { status: "ready", version: 1, failure: null },
        { status: "ready", version: 1, failure: null },
      ],
      receipts: [
        {
          path: "expense-policy.pdf",
          title: "expense-policy",
          type: "file",
          headings: ["Page 1"],
        },
      ],
      mileage: [
        {
          path: "expense-policy.pdf",
          title: "expense-policy",
          type: "file",
          headings: ["Page 2"],
        },
      ],
      flights: [
        {
          path: "travel-policy.docx",
          title: "travel-policy",
          type: "file",
          headings: ["Travel policy", "Flights"],
        },
      ],
      contacts: [
        {
          path: "offices.xlsx",
          title: "offices",
          type: "file",
          headings: ["Contacts"],
        },
      ],
      audited: [
        { received: true, saved: true },
        { received: true, saved: true },
        { received: true, saved: true },
      ],
    });
  });

  it("save the same name again as the next version of its document", async () => {
    const person = await personWithCollection();
    const first = await uploaded(person, "travel-policy.docx", "Policy.docx");
    const second = await uploaded(
      person,
      "travel-policy-2.docx",
      "Policy.docx"
    );
    const document = await person.api.knowledge.getDocument(
      second.documentId ?? ""
    );
    const { versions } = await person.api.knowledge.history(document.id);

    expect({
      first: [first.status, first.version],
      second: [second.status, second.version],
      sameDocument: first.documentId === second.documentId,
      current: document.version.number,
      text: document.version.text.includes("under 800 kilometres"),
      history: versions.map(({ number, message }) => [number, message]),
    }).toStrictEqual({
      first: ["ready", 1],
      second: ["ready", 2],
      sameDocument: true,
      current: 2,
      text: true,
      history: [
        [2, "Uploaded Policy.docx"],
        [1, "Uploaded Policy.docx"],
      ],
    });
  });

  it("save uploads of one name made at once in the order they were made", async () => {
    const person = await personWithCollection();
    // The one that conflicts saves again at once, not 30 seconds later.
    await using introspector = await introspectWorkflow(env.WORKFLOWS);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    const files = await Promise.all([
      fixture("travel-policy.docx"),
      fixture("travel-policy-2.docx"),
    ]);
    const started = await Promise.all(
      files.map(
        async (bytes) =>
          await person.api.uploads.upload({
            collectionId: person.collectionId,
            name: "Policy.docx",
            bytes,
          })
      )
    );
    const all = await Promise.all(
      started.map(async ({ id }) => await ended(person.api, id))
    );
    // The order they were made in: by time, then by ID.
    const { results } = await env.KNOWLEDGE.prepare(
      "SELECT id FROM uploads WHERE collection_id = ? ORDER BY created_at, id"
    )
      .bind(person.collectionId)
      .all<{ id: string }>();
    const [earlier, later] = results.map(({ id }) =>
      all.find((upload) => upload.id === id)
    );
    const document = await person.api.knowledge.getDocument(
      later?.documentId ?? ""
    );
    // The earlier one is saved as the version before, or not at all.
    const earlierKept =
      earlier?.status === "ready"
        ? earlier.version === (later?.version ?? 0) - 1
        : earlier?.failure?.code === "upload.superseded";

    expect({
      later: later?.status,
      current: document.version.number === later?.version,
      earlierKept,
    }).toStrictEqual({ later: "ready", current: true, earlierKept: true });
  });

  it("fail a file that can't be read, say why, and delete its original", async () => {
    const person = await personWithCollection();
    const failed = await uploaded(person, "broken.pdf");
    const events = await allEvents();
    const { documents } = await person.api.knowledge.listDocuments(
      person.collectionId
    );

    expect({
      upload: failed,
      stored: await originalStored(person.collectionId, "broken.pdf"),
      documents: documents.length,
      audited: events
        .filter(({ target }) => target?.id === failed.id)
        .map(({ action, detail }) => [action, detail.reason ?? null]),
    }).toMatchObject({
      upload: {
        status: "failed",
        documentId: null,
        failure: {
          code: "upload.unreadable",
          message:
            "The file's text couldn't be read. Check that it opens, then upload it again.",
        },
      },
      stored: false,
      documents: 0,
      audited: [
        ["knowledge.upload.received", null],
        ["knowledge.upload.failed", "upload.unreadable"],
      ],
    });
  });

  it("fail a file with no text to read, and say so", async () => {
    const person = await personWithCollection();
    const failed = await uploaded(person, "scan.pdf");

    expect(failed.failure).toStrictEqual({
      code: "upload.no_text",
      message:
        "The file has no text to read: a scan without a text layer has none.",
    });
  });

  it("retry an extraction that fails for a moment", async () => {
    const person = await personWithCollection();
    await using introspector = await introspectWorkflow(env.WORKFLOWS);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError(
        { name: "extract" },
        new Error("R2 is down for a moment"),
        2
      );
    });
    const upload = await uploaded(person, "travel-policy.docx");

    expect([upload.status, upload.version]).toStrictEqual(["ready", 1]);
  });

  it("fail an extraction that keeps failing once its retries run out", async () => {
    const person = await personWithCollection();
    await using introspector = await introspectWorkflow(env.WORKFLOWS);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
      // The first attempt and its three retries.
      await modifier.mockStepError(
        { name: "extract" },
        new Error("R2 is down"),
        4
      );
    });
    const upload = await uploaded(person, "offices.xlsx");

    expect({
      status: upload.status,
      failure: upload.failure?.code,
      stored: await originalStored(person.collectionId, "offices.xlsx"),
    }).toStrictEqual({
      status: "failed",
      failure: "upload.unreadable",
      stored: false,
    });
  });

  it("leave an upload as it ended when its extraction runs again", async () => {
    const person = await personWithCollection();
    const [ready, failed] = await Promise.all([
      uploaded(person, "travel-policy.docx"),
      uploaded(person, "broken.pdf"),
    ]);
    // As a replay would, from the start.
    await Promise.all(
      [ready, failed].map(async ({ id }) => {
        const again = `${extractionRunId(id)}-again`;
        await runEngine(env).createInternal({
          id: again,
          workflow: "extraction",
          input: { uploadId: id },
        });
        await finished(again);
      })
    );
    const { versions } = await person.api.knowledge.history(
      ready.documentId ?? ""
    );

    expect({
      ready: await person.api.uploads.get(ready.id),
      failed: await person.api.uploads.get(failed.id),
      versions: versions.length,
    }).toStrictEqual({ ready, failed, versions: 1 });
  });

  it("refuse files over the limit or of other types, whatever their name", async () => {
    const person = await personWithCollection();
    const pdf = await fixture("expense-policy.pdf");
    const attempt = async (name: string, bytes: Uint8Array) =>
      await outcome(
        person.api.uploads.upload({
          collectionId: person.collectionId,
          name,
          bytes,
        })
      );
    const oversized = new Uint8Array(uploadMaxBytes + 1);
    oversized.set(pdf);

    expect({
      oversized: await attempt("big.pdf", oversized),
      atLimit: await attempt("limit.pdf", oversized.slice(0, uploadMaxBytes)),
      pdfAsWord: await attempt("expense.docx", pdf),
      text: await attempt("notes.txt", new TextEncoder().encode("Notes")),
      noExtension: await attempt("expense", pdf),
      folder: await attempt("policies/expense.pdf", pdf),
    }).toStrictEqual({
      oversized: "upload.too_large",
      atLimit: "ok",
      pdfAsWord: "upload.unsupported",
      text: "upload.unsupported",
      noExtension: "upload.unsupported",
      folder: "upload.invalid",
    });
  });

  it("take uploads only into collections the person may change, and show each only to its uploader", async () => {
    const owner = await personWithCollection();
    const other = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const bytes = await fixture("expense-policy.pdf");
    const upload = await owner.api.uploads.upload({
      collectionId: owner.collectionId,
      name: "expense.pdf",
      bytes,
    });
    // Everyone reads it; only its owner and admins change it.
    const handbook = await admin.api.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });

    expect({
      othersCollection: await outcome(
        other.api.uploads.upload({
          collectionId: owner.collectionId,
          name: "expense.pdf",
          bytes,
        })
      ),
      onlyRead: await outcome(
        owner.api.uploads.upload({
          collectionId: handbook.id,
          name: "expense.pdf",
          bytes,
        })
      ),
      othersUpload: await outcome(other.api.uploads.get(upload.id)),
      ownUpload: await outcome(owner.api.uploads.get(upload.id)),
    }).toStrictEqual({
      othersCollection: "knowledge.not_found",
      onlyRead: "knowledge.forbidden",
      othersUpload: "upload.not_found",
      ownUpload: "ok",
    });
  });

  it("download an original only as an attachment, to those who may read its document", async () => {
    const owner = await personWithCollection();
    const other = await signedInApi(idp, "user");
    const upload = await uploaded(
      owner,
      "travel-policy.docx",
      'Travel "policy" é.docx'
    );
    const download = await routed(uploadOriginalPath(upload.id), {
      headers: { cookie: owner.session },
    });
    const body = new Uint8Array(await download.arrayBuffer());
    const forOther = await routed(uploadOriginalPath(upload.id), {
      headers: { cookie: other.session },
    });
    const signedOut = await routed(uploadOriginalPath(upload.id));
    const events = await allEvents();

    expect({
      status: download.status,
      type: download.headers.get("content-type"),
      disposition: download.headers.get("content-disposition"),
      sniffing: download.headers.get("x-content-type-options"),
      same:
        (await sha256Of(body)) ===
        (await sha256Of(await fixture("travel-policy.docx"))),
      other: forOther.status,
      signedOut: signedOut.status,
      audited: events.some(
        ({ action, target, detail }) =>
          action === "knowledge.read" &&
          target?.id === upload.documentId &&
          detail.read === "original"
      ),
    }).toStrictEqual({
      status: 200,
      type: uploadTypes.docx,
      disposition: `attachment; filename="Travel _policy_ _.docx"; filename*=UTF-8''Travel%20%22policy%22%20%C3%A9.docx`,
      sniffing: "nosniff",
      same: true,
      other: 404,
      signedOut: 401,
      audited: true,
    });
  });

  it("start the run of an upload that core stopped before starting it", async () => {
    const person = await personWithCollection();
    const id = await leftPending(person, "travel-policy.docx");
    await runCron();

    await expect(ended(person.api, id)).resolves.toMatchObject({
      status: "ready",
      version: 1,
    });
  });

  it("fail an upload whose run ended without ending it", async () => {
    const person = await personWithCollection();
    const id = await leftPending(person, "travel-policy.docx");
    // A run that ended before the upload was there to see.
    await env.KNOWLEDGE.prepare("UPDATE uploads SET id = ? WHERE id = ?")
      .bind(`${id}-moved`, id)
      .run();
    await runEngine(env).createInternal({
      id: extractionRunId(id),
      workflow: "extraction",
      input: { uploadId: id },
    });
    await finished(extractionRunId(id));
    await env.KNOWLEDGE.prepare("UPDATE uploads SET id = ? WHERE id = ?")
      .bind(id, `${id}-moved`)
      .run();
    await runCron();

    await expect(person.api.uploads.get(id)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "internal.unexpected" },
    });
  });

  it("fail an upload whose original can't be stored, and say so", async () => {
    const person = await personWithCollection();
    const down = vi
      .spyOn(env.FILES, "put")
      .mockRejectedValue(new Error("R2 is down"));
    const attempt = await outcome(
      person.api.uploads
        .upload({
          collectionId: person.collectionId,
          name: "offices.xlsx",
          bytes: await fixture("offices.xlsx"),
        })
        .finally(() => {
          down.mockRestore();
        })
    );
    const { results } = await env.KNOWLEDGE.prepare(
      "SELECT status, failure FROM uploads WHERE collection_id = ?"
    )
      .bind(person.collectionId)
      .all();

    expect({ attempt, results }).toStrictEqual({
      attempt: "internal.unexpected",
      results: [{ status: "failed", failure: "internal.unexpected" }],
    });
  });

  it("delete the original of a document a purge rewrites", async () => {
    const person = await personWithCollection();
    const admin = await signedInApi(idp, "admin");
    const upload = await uploaded(person, "offices.xlsx");
    const input: PurgeInput = {
      type: "content",
      documentIds: [upload.documentId ?? ""],
      terms: ["facilities@example.com"],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);

    expect({
      stored: await originalStored(person.collectionId, "offices.xlsx"),
      upload: await outcome(person.api.uploads.get(upload.id)),
    }).toStrictEqual({ stored: false, upload: "upload.not_found" });
  });

  it("delete the originals in a Personal collection a purge deletes", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const { personal } = await person.api.memory.collections();
    const upload = await uploaded(
      { api: person.api, collectionId: personal },
      "offices.xlsx"
    );
    const input: PurgeInput = {
      type: "personal",
      userId: person.userId,
      reason: "offboarding",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);

    expect({
      ready: upload.status,
      stored: await originalStored(personal, "offices.xlsx"),
      upload: await outcome(person.api.uploads.get(upload.id)),
    }).toStrictEqual({
      ready: "ready",
      stored: false,
      upload: "upload.not_found",
    });
  });
});
