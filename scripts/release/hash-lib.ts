/**
 * Hashing and collection helpers for release bundles.
 *
 * Two hash schemes, on purpose:
 * - Worker modules and D1 migrations are addressed by their full SHA-256
 *   (hex): our own scheme, for deduplication in R2 and for checking that
 *   what the console deploys is what CI built.
 * - Static assets use the content key of Cloudflare's assets-upload API:
 *   SHA-256 of base64(contents) plus the file's extension, hex, cut to 32
 *   characters. The API treats it as an opaque key per file (Wrangler
 *   computes the same shape with BLAKE3), so CI and the console only have to
 *   agree with each other, byte for byte.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** A file read into a release: its name, content address and bytes. */
export interface CollectedFile {
  /** Path relative to the directory it was collected from, POSIX-separated. */
  name: string;
  /** Full SHA-256 of the contents, hex. */
  sha256: string;
  /** Byte length. */
  size: number;
  /** The contents; never part of the manifest. */
  bytes: Buffer;
}

/** A Worker module the script-upload API understands. */
export interface CollectedModule extends CollectedFile {
  type: ModuleType;
}

/** One static asset in the assets-upload API's manifest. */
export interface AssetEntry {
  /** The asset content key (see {@link cfAssetHash}). */
  hash: string;
  size: number;
}

/** A built static-asset directory: the upload manifest plus deduplicated blobs. */
export interface CollectedAssets {
  /** `{ "/path": { hash, size } }`, the shape the assets-upload API takes. */
  manifest: Record<string, AssetEntry>;
  /** Contents by content key. */
  blobs: Map<string, Buffer>;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The static-asset content key (see the header comment). */
export const cfAssetHash = (bytes: Uint8Array, filePath: string): string =>
  createHash("sha256")
    .update(
      `${Buffer.from(bytes).toString("base64")}${path.extname(filePath).slice(1)}`,
      "utf-8"
    )
    .digest("hex")
    .slice(0, 32);

// Module types by extension, as core's `rules` bundle them: the Durable
// Object migrations (.sql) and the Grasp skills (SKILL.md) are text.
const MODULE_TYPES = {
  ".js": "esm",
  ".mjs": "esm",
  ".sql": "text",
  ".md": "text",
  ".txt": "text",
  ".wasm": "wasm",
  ".bin": "data",
} as const;

/** A module type the script-upload API understands. */
export type ModuleType = (typeof MODULE_TYPES)[keyof typeof MODULE_TYPES];

const isModuleExtension = (
  extension: string
): extension is keyof typeof MODULE_TYPES =>
  Object.hasOwn(MODULE_TYPES, extension);

// What `wrangler deploy --dry-run --outdir` writes next to the modules.
const isDryRunExtra = (name: string): boolean =>
  name.endsWith(".map") || name === "README.md";

/** Every file under `dir`, relative and POSIX-separated, sorted; symlinks skipped as Wrangler does. */
const walkFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(dir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/")
    )
    .toSorted();

const readCollected = (dir: string, name: string): CollectedFile => {
  const bytes = readFileSync(path.join(dir, name));
  return { name, sha256: sha256Hex(bytes), size: bytes.length, bytes };
};

/**
 * Reads a `wrangler deploy --dry-run --outdir` directory. Fails on an
 * extension it doesn't know: a bundle shape this pipeline hasn't seen needs
 * a decision, not a guess.
 */
export const collectModules = (
  outDir: string
): { mainModule: string; modules: CollectedModule[] } => {
  const modules = walkFiles(outDir)
    .filter((name) => !isDryRunExtra(name))
    .map((name): CollectedModule => {
      const extension = path.extname(name);
      if (!isModuleExtension(extension)) {
        throw new Error(
          `Unrecognised module in the dry-run output: ${name} (${outDir})`
        );
      }
      return { ...readCollected(outDir, name), type: MODULE_TYPES[extension] };
    });
  const esm = modules.filter((module) => module.type === "esm");
  const [main] = esm;
  if (main === undefined || esm.length > 1) {
    throw new Error(
      `Expected one ES module in ${outDir}, found: ${esm.map((module) => module.name).join(", ") || "none"}`
    );
  }
  return { mainModule: main.name, modules };
};

/** A D1 migrations directory's SQL files, in the order Wrangler applies them. */
export const collectSqlFiles = (dir: string): CollectedFile[] =>
  walkFiles(dir)
    .filter((name) => !name.includes("/") && name.endsWith(".sql"))
    .map((name) => readCollected(dir, name));

// Files Wrangler reads as configuration rather than serving: the release
// would ship them as plain assets, so they need a decision first.
const ASSET_CONFIG_FILES = new Set([
  ".assetsignore",
  "_headers",
  "_redirects",
  "_worker.js",
]);

/** Reads a built static-asset directory. */
export const collectAssets = (distDir: string): CollectedAssets => {
  const manifest: Record<string, AssetEntry> = {};
  const blobs = new Map<string, Buffer>();
  for (const name of walkFiles(distDir)) {
    if (ASSET_CONFIG_FILES.has(name)) {
      throw new Error(
        `${distDir}/${name} configures assets, which releases don't carry yet`
      );
    }
    const bytes = readFileSync(path.join(distDir, name));
    const hash = cfAssetHash(bytes, name);
    manifest[`/${name}`] = { hash, size: bytes.length };
    blobs.set(hash, bytes);
  }
  return { manifest, blobs };
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, entry]) => [key, sortKeysDeep(entry)])
    );
  }
  return value;
};

/**
 * JSON with every object's keys sorted, so manifests diff cleanly and the
 * golden test is byte-stable. Arrays keep their order: migrations are
 * ordered.
 */
export const stableStringify = (value: unknown): string =>
  `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
