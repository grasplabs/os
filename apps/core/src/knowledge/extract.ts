import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { log } from "@grasp-os/shared/log";
import { isolateBase } from "@grasp-os/shared/runtime";
import { uploadErrors } from "@grasp-os/shared/uploads";
import type { UploadMediaType } from "@grasp-os/shared/uploads";
import { z } from "zod";

import { extractorAsset } from "./extractor/asset.ts";
import type ExtractorWorker from "./extractor/worker.ts";

// Extracting an uploaded file's text as Markdown. The extractor
// (extractor/worker.ts, with the parsers in extractor/formats.ts) never
// runs in core's isolate: core starts a Dynamic Worker for each
// extraction, with its code from core's static assets
// (build-extractor.ts), no bindings, no network and a CPU limit, and calls
// it over RPC. A file crafted to exhaust a parser (a PDF whose one stream
// inflates to gigabytes, an archive of millions of tags) kills that
// isolate, and the upload fails for good as `upload.too_complex`; core,
// and whatever else it runs, carry on.

/** A file to extract: its name, its type (by its extension) and itself. */
export interface ExtractInput {
  name: string;
  mediaType: UploadMediaType;
  bytes: Uint8Array;
}

/**
 * Turns a file into Markdown. Throws an expected error for what no retry
 * changes (`upload.too_complex`, `knowledge.too_large`),
 * `ExtractorUnavailableError` when it couldn't try, and any other error
 * when it couldn't read the file.
 */
export type Extractor = (file: ExtractInput) => Promise<string>;

/**
 * The extractor couldn't be reached, or failed for a moment, before it
 * read the file: trying again may work.
 */
export class ExtractorUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("The extractor couldn't be reached", options);
    this.name = "ExtractorUnavailableError";
  }
}

/**
 * How the extractor's isolate runs: no bindings, no importable env, no
 * network (`globalOutbound: null` and no subrequests), and at most 20 s of
 * CPU, many times what a large document takes. `nodejs_compat` is for
 * pdf.js, which reaches for Node's built-ins.
 */
const isolateSettings = {
  ...isolateBase,
  compatibilityFlags: [...isolateBase.compatibilityFlags, "nodejs_compat"],
  env: {},
  globalOutbound: null,
  limits: { cpuMs: 20_000, subRequests: 0 },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * How the runtime says it stopped an isolate over its limits: "Worker
 * exceeded CPU time limit." or "… memory limit."
 */
const overLimit = /exceeded (?:its )?(?:CPU|memory)/iu;

/**
 * The extractor's module, from core's static assets. They answer unknown
 * paths with the frontend's index.html, so anything but JavaScript means
 * it is missing: a deployment built without it.
 */
const extractorSource = async (assets: Fetcher): Promise<string> => {
  const response = await assets.fetch(`https://assets/${extractorAsset}`);
  const type = response.headers.get("content-type") ?? "";
  if (!(response.ok && type.includes("javascript"))) {
    // A deployment built without it (build-extractor.ts): nothing about
    // the file, so retried, and failed as unexpected once retries run out.
    log.error("extractor.missing", { status: response.status });
    throw new ExtractorUnavailableError();
  }
  return await response.text();
};

/**
 * The most Markdown core takes from the sandbox, in bytes of UTF-8: a
 * document's limit (documents.ts). Checked here, whatever the sandbox
 * says of itself.
 */
const markdownMaxBytes = 1024 * 1024;

/**
 * What the sandbox may answer. Its code is core's, but it runs what it was
 * handed, so its answer is checked like any other input.
 */
const extractedSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), markdown: z.string() }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["unreadable", "too_large"]),
  }),
]);

/** Extracts in a fresh sandbox, whatever the file's collection. */
export const localExtractor =
  (env: Pick<Env, "ASSETS" | "LOADER">): Extractor =>
  async ({ mediaType, bytes }) => {
    const source = await extractorSource(env.ASSETS);
    const worker = env.LOADER.load({
      ...isolateSettings,
      mainModule: "extractor.js",
      modules: { "extractor.js": source },
    });
    let answer: unknown;
    try {
      answer = await worker
        .getEntrypoint<ExtractorWorker>()
        .extract({ mediaType, bytes });
    } catch (error) {
      if (error instanceof Error && overLimit.test(error.message)) {
        throw uploadErrors.create("upload.too_complex");
      }
      throw new ExtractorUnavailableError({ cause: error });
    }
    const parsed = extractedSchema.safeParse(answer);
    if (!parsed.success) {
      throw new Error("The extractor answered what it may not");
    }
    const extracted = parsed.data;
    if (
      extracted.ok &&
      new TextEncoder().encode(extracted.markdown).byteLength <=
        markdownMaxBytes
    ) {
      return extracted.markdown;
    }
    if (extracted.ok || extracted.reason === "too_large") {
      throw knowledgeErrors.create("knowledge.too_large");
    }
    throw new Error("The extractor couldn't read the file");
  };
