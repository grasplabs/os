import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { SessionApi } from "@grasp-os/shared/rpc";
import { compatibilityDate } from "@grasp-os/shared/runtime";
import {
  uploadExtensionOf,
  uploadMaxBytes,
  uploadOriginalPath,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import type { Upload } from "@grasp-os/shared/uploads";
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  extractUpload,
  extractionRunId,
  originalKey,
} from "../src/knowledge/uploads.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
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

/** Whether R2 holds the original of the upload `uploadId`. */
const originalStored = async (
  collectionId: string,
  uploadId: string
): Promise<boolean> =>
  (await env.FILES.head(originalKey(collectionId, uploadId))) !== null;

/**
 * Records a pending upload of the fixture `file` as `name`, with its
 * original stored, made at `createdAt` and unchanged since: an hour ago
 * unless given, as core leaves one that stopped between recording it and
 * starting its run.
 */
const leftPending = async (
  person: { userId: string; collectionId: string },
  file: string,
  { name = file, createdAt = Date.now() - 60 * 60_000 } = {}
): Promise<string> => {
  const bytes = await fixture(file);
  const id = crypto.randomUUID();
  const extension = uploadExtensionOf(name) ?? "docx";
  await env.FILES.put(originalKey(person.collectionId, id), bytes);
  await env.KNOWLEDGE.prepare(
    `INSERT INTO uploads (id, collection_id, path, media_type, bytes, sha256,
       uploaded_by, actor, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  )
    .bind(
      id,
      person.collectionId,
      name,
      uploadTypes[extension],
      bytes.length,
      await sha256Of(bytes),
      person.userId,
      JSON.stringify({ type: "person", userId: person.userId }),
      createdAt,
      createdAt
    )
    .run();
  return id;
};

/**
 * Knowledge's database, with `first` run once, just before the first
 * batch lands: a change made by someone else between a read and the write
 * it allowed.
 */
const racingKnowledge = (first: () => Promise<unknown>): D1Database => {
  let raced = false;
  return new Proxy(env.KNOWLEDGE, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await first();
          }
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

/** The text of every version of `documentId`, oldest first. */
const versionTexts = async (documentId: string): Promise<string[]> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT text FROM versions WHERE document_id = ? ORDER BY number"
  )
    .bind(documentId)
    .all<{ text: string }>();
  return results.map(({ text }) => text);
};

/** A Word file of `document.xml` and `styles.xml` as given. */
const wordFile = (document: string, styles: string): Uint8Array => {
  const encoder = new TextEncoder();
  return zipSync({
    "word/document.xml": encoder.encode(document),
    "word/styles.xml": encoder.encode(styles),
  });
};

// Each test waits for its uploads to end, with up to 20 seconds each
// (`ended`), and none waits for more than two in a row: more than
// Vitest's default five seconds on a loaded runner. Sixty fits the
// longest, with room for signing in.
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

  it("don't save an earlier upload over a later one saved first", async () => {
    const person = await personWithCollection();
    const later = await uploaded(person, "travel-policy-2.docx", "Policy.docx");
    // Made before the later one, and extracted after it.
    const earlier = await leftPending(person, "travel-policy.docx", {
      name: "Policy.docx",
    });
    await runCron();
    const ended_ = await ended(person.api, earlier);
    const document = await person.api.knowledge.getDocument(
      later.documentId ?? ""
    );

    expect({
      earlier: ended_.failure?.code,
      current: document.version.number,
      text: document.version.text.includes("under 800 kilometres"),
    }).toStrictEqual({ earlier: "upload.superseded", current: 1, text: true });
  });

  it("save an upload on top of a save made while it was extracted", async () => {
    const person = await personWithCollection();
    const first = await uploaded(person, "travel-policy.docx", "Policy.docx");
    const second = await leftPending(person, "travel-policy-2.docx", {
      name: "Policy.docx",
      createdAt: Date.now(),
    });
    // Someone saves the document between the extraction's read of its
    // version and its save.
    const racing = racingKnowledge(
      async () =>
        await person.api.knowledge.saveDocument({
          collectionId: person.collectionId,
          path: "Policy.docx",
          text: "# Policy\nEdited by hand.",
          ifVersion: 1,
        })
    );
    const raced = await outcome(
      extractUpload({ ...env, KNOWLEDGE: racing }, second)
    );
    // The step's retry.
    await extractUpload(env, second);
    const { versions } = await person.api.knowledge.history(
      first.documentId ?? ""
    );

    expect({
      raced,
      saved: await person.api.uploads.get(second),
      history: versions.map(({ number, message }) => [number, message]),
    }).toMatchObject({
      raced: "knowledge.conflict",
      saved: { status: "ready", version: 3 },
      history: [
        [3, "Uploaded Policy.docx"],
        [2, null],
        [1, "Uploaded Policy.docx"],
      ],
    });
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
      stored: await originalStored(person.collectionId, failed.id),
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
      failure: upload.failure,
      stored: await originalStored(person.collectionId, upload.id),
    }).toStrictEqual({
      status: "failed",
      failure: {
        code: "internal.unexpected",
        message: "Something went wrong.",
      },
      stored: false,
    });
  });

  it("read a sheet of thousands of rows", async () => {
    const person = await personWithCollection();
    const upload = await uploaded(person, "orders.xlsx");
    const { hits } = await person.api.knowledge.search("Zebra Logistics", {
      collectionId: person.collectionId,
    });

    expect({
      status: upload.status,
      hits: hits.map(({ path, headings }) => ({ path, headings })),
    }).toStrictEqual({
      status: "ready",
      hits: [{ path: "orders.xlsx", headings: ["Orders"] }],
    });
  });

  it("read a Word file of countless unclosed tags in one pass", async () => {
    const person = await personWithCollection();
    // Read by patterns that scan on from every unclosed tag, this takes
    // minutes; read in one pass, a moment.
    const unclosed = 200_000;
    const bytes = wordFile(
      `<w:document><w:body>${"<w:p>".repeat(unclosed)}<w:p><w:r><w:t>Still read</w:t></w:r></w:p></w:body></w:document>`,
      `<w:styles>${'<w:style w:styleId="x">'.repeat(unclosed)}</w:styles>`
    );
    const upload = await person.api.uploads.upload({
      collectionId: person.collectionId,
      name: "unclosed.docx",
      bytes,
    });
    const read = await vi.waitFor(
      async () => {
        const now = await person.api.uploads.get(upload.id);
        if (now.status !== "ready" && now.status !== "failed") {
          throw new Error(`Upload ${upload.id} is ${now.status}`);
        }
        return now;
      },
      { timeout: 10_000, interval: 100 }
    );

    expect([read.status, read.failure]).toStrictEqual(["ready", null]);
  });

  it("fail a file that runs the extractor out of its limits once, and say why", async () => {
    const person = await personWithCollection();
    await using introspector = await introspectWorkflow(env.WORKFLOWS);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    let started = 0;
    // A sandbox that answers as the runtime does once it stopped the
    // isolate over its limits.
    const load = env.LOADER.load.bind(env.LOADER);
    const loading = vi.spyOn(env.LOADER, "load").mockImplementation(() => {
      started += 1;
      return load({
        compatibilityDate,
        mainModule: "extractor.js",
        modules: {
          "extractor.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  extract() { throw new Error("Worker exceeded CPU time limit."); }
}`,
        },
      });
    });
    let upload: Upload | undefined;
    try {
      upload = await uploaded(person, "expense-policy.pdf");
    } finally {
      loading.mockRestore();
    }

    expect({ started, failure: upload.failure }).toStrictEqual({
      started: 1,
      failure: {
        code: "upload.too_complex",
        message:
          "The file takes more work to read than an upload may take: it may be damaged, or built to be. Check that it opens, or save it again as a simpler file, then upload it again.",
      },
    });
  });

  it("save nothing for someone who lost access to the collection meanwhile", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const team = await newTeam(admin, [member]);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Team files ${unique()}`,
      access: "teams",
      teams: [team],
    });
    const id = await leftPending(
      { userId: member.userId, collectionId },
      "travel-policy.docx"
    );
    // Taken out of the team while the file waited to be extracted.
    await env.DB.prepare("DELETE FROM team_members WHERE user_id = ?")
      .bind(member.userId)
      .run();
    await runCron();
    const { documents } = await admin.api.knowledge.listDocuments(collectionId);

    await expect(ended(member.api, id)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "knowledge.forbidden" },
    });
    expect(documents).toStrictEqual([]);
  });

  it("save nothing of an upload whose document a purge rewrote while it was extracted", async () => {
    const person = await personWithCollection();
    const admin = await signedInApi(idp, "admin");
    const saved = await uploaded(person, "offices.xlsx");
    const inFlight = await leftPending(person, "offices.xlsx", {
      createdAt: Date.now(),
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [saved.documentId ?? ""],
      terms: ["facilities@example.com"],
      reason: "erasure_request",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    // The purge lands once the extraction has read the file, before it
    // reads the document's version.
    const readThenPurge = async (key: string) => {
      const original = await env.FILES.get(key);
      const bytes = await original?.arrayBuffer();
      await admin.api.knowledge.purge(input, token);
      return bytes === undefined
        ? null
        : { arrayBuffer: async () => await Promise.resolve(bytes) };
    };
    const files = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === "get") {
          return readThenPurge;
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const raced = await outcome(
      extractUpload({ ...env, FILES: files }, inFlight)
    );
    // The step's retry.
    await extractUpload(env, inFlight);
    const texts = await versionTexts(saved.documentId ?? "");

    expect({
      refused: raced !== "ok",
      upload: await outcome(person.api.uploads.get(inFlight)),
      versions: texts.length,
      purged: texts.every((text) => !text.includes("facilities@example.com")),
    }).toStrictEqual({
      refused: true,
      upload: "upload.not_found",
      versions: 2,
      purged: true,
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
      stored: await originalStored(person.collectionId, upload.id),
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
      stored: await originalStored(personal, upload.id),
      upload: await outcome(person.api.uploads.get(upload.id)),
    }).toStrictEqual({
      ready: "ready",
      stored: false,
      upload: "upload.not_found",
    });
  });
});
