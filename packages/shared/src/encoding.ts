// Byte encodings core and connect both need, with nothing but Web APIs, so
// they run the same on workerd and in the browser.

const base64UrlPattern = /^[A-Za-z0-9_-]*$/u;

/** Bytes as unpadded base64url (RFC 4648 §5). */
export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

/** Unpadded base64url as bytes; throws a `TypeError` on anything else. */
export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  if (!base64UrlPattern.test(text)) {
    throw new TypeError("Not base64url");
  }
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
};

/** Bytes as lowercase hex. */
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** SHA-256 of `text` (UTF-8), in lowercase hex. */
export const sha256Hex = async (text: string): Promise<string> =>
  toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    )
  );

/** `bytes` random bytes from the platform's CSPRNG, as base64url. */
export const randomToken = (bytes = 32): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
