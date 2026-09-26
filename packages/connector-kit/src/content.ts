import { z } from "zod";

import { ToolError } from "./connector.ts";

// What connectors share in reading a provider's answers: a file's or an
// attachment's content as the caller asked for it, within the limits
// connect reads.

/**
 * Largest file or attachment a tool reads, in bytes; connect's egress lets
 * a connector read 10 MiB of a provider's answer (`maxEgressResponseBytes`).
 */
const maxReadBytes = 4 * 1024 * 1024;

/**
 * Largest content a read returns, in bytes of JSON: base64 of the largest
 * file fits, and so does text, unless escaping (a control character takes
 * six bytes) would make it larger than connect reads (16 MiB,
 * `nativeResponseBytes`).
 */
const maxContentBytes = 8 * 1024 * 1024;

/** How a caller wants a file's content: as text, or base64 for extraction. */
export const readAsSchema = z.enum(["text", "base64"]);
type ReadAs = z.infer<typeof readAsSchema>;

/** Base64 of `bytes`, a chunk at a time to spare the call stack. */
export const toBase64 = (bytes: Uint8Array): string => {
  const chunk = 0x80_00;
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += chunk) {
    parts.push(String.fromCodePoint(...bytes.subarray(start, start + chunk)));
  }
  return btoa(parts.join(""));
};

/** Bytes from base64, or from base64url as Google sends it. */
export const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.from(
    atob(base64.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.codePointAt(0) ?? 0
  );

/** Refuses content past the read limit. */
export const checkReadable = (size: number): void => {
  if (size > maxReadBytes) {
    throw new ToolError(
      `This is over ${maxReadBytes / 1024 / 1024} MiB, more than a tool reads`,
      { code: "too_large" }
    );
  }
};

/** Content as the caller asked for it: UTF-8 text, or base64. */
export const contentAs = (
  bytes: Uint8Array,
  as: ReadAs
): { encoding: ReadAs; content: string } => {
  checkReadable(bytes.byteLength);
  if (as === "base64") {
    return { encoding: as, content: toBase64(bytes) };
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new ToolError("This isn't text: read it as base64", {
      code: "not_text",
    });
  }
  const escaped = new TextEncoder().encode(JSON.stringify(content));
  if (escaped.byteLength > maxContentBytes) {
    throw new ToolError("This text is too large to return: read it as base64", {
      code: "too_large",
    });
  }
  return { encoding: as, content };
};
