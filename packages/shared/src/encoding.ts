// Hashes and encodings on the Web platform's own APIs, which every runtime
// Grasp runs in has (Workers, browsers, Node).

/** The SHA-256 of `text` (as UTF-8), as 64 lowercase hex digits. */
export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

/** `bytes` as base64url, without padding (RFC 4648 §5). */
export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

/** The bytes of unpadded base64url text; throws a TypeError on anything else. */
export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  if (!base64UrlPattern.test(text)) {
    throw new TypeError("Not base64url");
  }
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
};
