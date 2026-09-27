import { isExpectedCode, isExpectedError } from "@grasp-os/shared/errors";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { z } from "zod";

import type { RunStep } from "../workflows/host.ts";
import { localExtractor } from "./extract.ts";
import { extractUpload, failUpload, finalFailures } from "./uploads.ts";

// The extraction workflow: core's own, run on the engine like an App's
// workflows but by the dispatcher's own hand (workflows/dispatcher.ts),
// once per upload (uploads.ts). One step extracts the text and saves it;
// a failure a retry may fix (the database or R2 for a moment, a save that
// conflicted) is retried with backoff, one no retry changes (a file that
// doesn't read, text over a document's limits) isn't. Either way, once it
// fails for good, a last step fails the upload with the reason.
//
// Replaying the run is safe: a step that finished isn't run again, and
// one that ran without its result being kept finds the upload ready (or
// failed) and leaves it.

const inputSchema = z.object({ uploadId: z.string().min(1) });

/**
 * Retries of the extraction step: three, 30 seconds apart and doubling,
 * so a moment's outage passes and a failing file fails within minutes.
 */
const extractConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

/**
 * What the step throws for `error`: an expected error by its code, so the
 * code survives the engine, which keeps only an error's message; one no
 * retry changes as non-retryable. Anything else as it is, to retry.
 */
const stepError = (error: unknown): unknown => {
  if (!isExpectedError(error)) {
    return error;
  }
  return finalFailures.has(error.code)
    ? new NonRetryableError(error.code)
    : new Error(error.code);
};

/**
 * The code to fail the upload with, from the step's last error, whose
 * message the engine hands back as it was, or behind the error's name
 * (`NonRetryableError: upload.no_text`).
 */
const failureCode = (error: unknown): string => {
  const code =
    error instanceof Error ? error.message.split(": ").at(-1) : undefined;
  return isExpectedCode(code) ? code : "upload.unreadable";
};

/** Runs (or resumes) the extraction of one upload. */
export const runExtraction = async (
  env: Env,
  payload: unknown,
  step: RunStep
): Promise<void> => {
  const { uploadId } = inputSchema.parse(payload);
  try {
    await step.do("extract", extractConfig, async () => {
      try {
        await extractUpload(env, uploadId, localExtractor);
      } catch (error) {
        throw stepError(error);
      }
      return null;
    });
  } catch (error) {
    const code = failureCode(error);
    await step.do("fail", {}, async () => {
      await failUpload(env, uploadId, code);
      return null;
    });
  }
};
