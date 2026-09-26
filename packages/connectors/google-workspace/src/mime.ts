import { toBase64 } from "@grasp-os/connector-kit/content";
import { z } from "zod";

// Mail as Gmail sends and stores it: RFC 5322 messages. Gmail takes a new
// message as one raw message, which this builds from plain values: every
// header value is either an address the input schema checked (no line
// breaks or controls) or encoded (RFC 2047), and the body is base64, so no
// input can add a header or a MIME part. Gmail hands a stored message back
// as a tree of MIME parts, which this reads the body and attachments from.

const crlf = "\r\n";

/** Base64url without padding, as Gmail takes a raw message. */
const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** Base64 in lines of 76 characters, as MIME wants it. */
const folded = (base64: string): string =>
  (base64.match(/.{1,76}/gu) ?? []).join(crlf);

/**
 * A header value as RFC 2047 encoded words, each well under 75 characters
 * and split only between code points, folded onto lines of their own.
 */
const encodedWords = (value: string): string => {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk !== "" && encoder.encode(chunk + character).byteLength > 36) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk += character;
    }
  }
  chunks.push(chunk);
  return chunks
    .map((each) => `=?UTF-8?B?${toBase64(encoder.encode(each))}?=`)
    .join(`${crlf} `);
};

/** What a new message is made of. */
interface OutgoingMessage {
  from: string;
  subject: string;
  body: string;
  bodyType: "text" | "html";
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  replyTo: readonly string[];
}

/**
 * The message as Gmail's `raw` takes it: base64url of its bytes. Addresses
 * must be plain addresses, as the tools' input schemas check.
 */
export const rawMessage = ({
  from,
  subject,
  body,
  bodyType,
  to,
  cc,
  bcc,
  replyTo,
}: OutgoingMessage): string => {
  const addresses = (name: string, values: readonly string[]): string[] =>
    values.length === 0 ? [] : [`${name}: ${values.join(`,${crlf} `)}`];
  // Every line break in the body becomes CRLF, as RFC 5322 has it.
  const text = body.replaceAll(/\r\n|\r|\n/gu, crlf);
  const lines = [
    `From: ${from}`,
    ...addresses("To", to),
    ...addresses("Cc", cc),
    ...addresses("Bcc", bcc),
    ...addresses("Reply-To", replyTo),
    subject === "" ? "Subject: " : `Subject: ${encodedWords(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: text/${bodyType === "html" ? "html" : "plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    folded(toBase64(new TextEncoder().encode(text))),
  ];
  return toBase64Url(new TextEncoder().encode(lines.join(crlf)));
};

const headerSchema = z.object({ name: z.string(), value: z.string() });

/** One MIME part of a message, as Gmail's `payload` gives it. */
export interface Part {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: z.infer<typeof headerSchema>[] | undefined;
  body?:
    | {
        attachmentId?: string | undefined;
        size?: number | undefined;
        data?: string | undefined;
      }
    | undefined;
  parts?: Part[] | undefined;
}

/** Deepest part tree read: Gmail's are a handful of levels at most. */
const maxDepth = 16;

export const partSchema: z.ZodType<Part> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(headerSchema).optional(),
    body: z
      .object({
        attachmentId: z.string().optional(),
        size: z.number().int().nonnegative().optional(),
        data: z.string().optional(),
      })
      .optional(),
    parts: z.array(partSchema).optional(),
  })
);

/** A header's value, by its name in any case, if the part has it. */
export const headerOf = (
  headers: readonly z.infer<typeof headerSchema>[] | undefined,
  name: string
): string | undefined =>
  headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())
    ?.value;

/** Every part of the tree, depth first, down to `maxDepth`. */
const partsOf = (root: Part | undefined): Part[] => {
  const found: Part[] = [];
  const visit = (part: Part, depth: number): void => {
    found.push(part);
    if (depth < maxDepth) {
      for (const child of part.parts ?? []) {
        visit(child, depth + 1);
      }
    }
  };
  if (root !== undefined) {
    visit(root, 0);
  }
  return found;
};

/** An attachment of a message: a part with a file name. */
export interface Attachment {
  /** Its part's ID (`1`, `1.2`): Gmail's attachment IDs change on every read. */
  id: string;
  name: string;
  contentType: string | null;
  size: number;
  isInline: boolean;
  part: Part;
}

/** A message's attachments, without their content. */
export const attachmentsOf = (payload: Part | undefined): Attachment[] =>
  partsOf(payload).flatMap((part) => {
    const { partId, filename, mimeType, body, headers } = part;
    if (
      partId === undefined ||
      filename === undefined ||
      filename === "" ||
      (body?.attachmentId === undefined && body?.data === undefined)
    ) {
      return [];
    }
    const disposition = headerOf(headers, "content-disposition") ?? "";
    return [
      {
        id: partId,
        name: filename,
        contentType: mimeType ?? null,
        size: body.size ?? 0,
        isInline: disposition.trim().toLowerCase().startsWith("inline"),
        part,
      },
    ];
  });

/** The charset a part's `Content-Type` names, if any. */
const charsetOf = (part: Part): string => {
  const type = headerOf(part.headers, "content-type") ?? "";
  return (
    /charset="?(?<charset>[\w.:-]+)"?/iu.exec(type)?.groups?.charset ?? "utf-8"
  );
};

/** Text of a part's bytes, in its charset (UTF-8 if unknown). */
export const textOf = (part: Part, bytes: Uint8Array): string => {
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

/**
 * A message's body part: its text part, or its HTML part, whichever
 * `prefer` names if it has both; the other if it has only one; `null` if
 * neither. Its data is inline, or, for a part too large for Gmail to send
 * inline, behind its `attachmentId`.
 */
export const bodyPartOf = (
  payload: Part | undefined,
  prefer: "text" | "html"
): { contentType: "text" | "html"; part: Part } | null => {
  const bodies = partsOf(payload).filter(
    ({ filename, body }) =>
      (filename === undefined || filename === "") &&
      (body?.data !== undefined || body?.attachmentId !== undefined)
  );
  const find = (type: "text" | "html") => {
    const mimeType = type === "html" ? "text/html" : "text/plain";
    const part = bodies.find((each) => each.mimeType === mimeType);
    return part === undefined ? null : { contentType: type, part };
  };
  return find(prefer) ?? find(prefer === "text" ? "html" : "text");
};

/** An address, as a header names it: `Name <address>`, or the address. */
interface Address {
  name: string | null;
  address: string | null;
}

/** Splits an address list at its commas, but not those in quotes or `<>`. */
const splitAddresses = (value: string): string[] => {
  const found: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "<") {
      angled = true;
    } else if (!quoted && character === ">") {
      angled = false;
    } else if (!(quoted || angled) && character === ",") {
      found.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  found.push(current);
  return found.map((each) => each.trim()).filter((each) => each !== "");
};

const namedAddress = /^(?<name>.*?)\s*<(?<address>[^<>]*)>$/su;

/** The addresses of an address header (`From`, `To`), in order. */
export const addressesOf = (value: string | undefined): Address[] =>
  splitAddresses(value ?? "").map((each) => {
    const named = namedAddress.exec(each);
    if (named === null) {
      return { name: null, address: each };
    }
    const name = (named.groups?.name ?? "")
      .replace(/^"(?<inner>.*)"$/su, "$<inner>")
      .replaceAll(/\\(?<escaped>.)/gu, "$<escaped>")
      .trim();
    const address = named.groups?.address?.trim() ?? "";
    return {
      name: name === "" ? null : name,
      address: address === "" ? null : address,
    };
  });
