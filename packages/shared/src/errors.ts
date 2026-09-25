import { z } from "zod";

/**
 * An error as data, for when it crosses a boundary (an RPC call or an HTTP
 * response body). Plain JSON, so it survives serialisation and reads the same
 * on both sides.
 */
export const errorPayloadSchema = z.object({
  /** Stable and machine-readable, e.g. `permission.denied`; branch on this. */
  code: z.string().min(1),
  /** For people; may change between releases, so never branch on it. */
  message: z.string(),
  /** Structured context, e.g. which input failed validation. */
  details: z.record(z.string(), z.json()).optional(),
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;
