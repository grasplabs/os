import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import {
  checkReadable,
  contentAs,
  readAsSchema,
} from "@grasp-os/connector-kit/content";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  apisHost,
  googleFetch,
  googleJson,
  googleUrl,
  idSchema,
  nextPageOf,
  pageSchema,
  topSchema,
} from "./google.ts";

// Drive, one shared drive per call. Google's Drive API has no path per
// drive: a file is `/drive/v3/files/{id}` whichever drive holds it. So:
//
// - Lists and searches ask for the drive's corpus in the query
//   (`corpora=drive&driveId=...`), which Google holds them to, and which
//   the egress binds to the drive a call's capability names: each route
//   names both parameters (`query`). Only items Google says are in that
//   drive (`driveId`) are passed on.
// - A file read addresses the file by its ID alone, where the drive can't
//   be named. Its routes declare a `check`: before each request, the
//   egress itself asks Google for the file's `driveId` and sends the
//   request only if that is the bound drive. The tool also reads the
//   file's metadata first and goes no further unless it is in the bound
//   drive, not trashed and has content (defence in depth).
//
// A person's My Drive isn't a shared drive and has no drive ID to hold a
// call to, or to check a file against: it is left out. An organization's
// files live in shared drives. Scoping is per drive, not per folder.
//
// Content: Google serves a stored file's bytes from www.googleapis.com
// itself (`alt=media`, no redirect, so the egress follows none). Google's
// own documents, spreadsheets and presentations have no bytes of their
// own; they are exported as text (`/export`), in one request, too.

const files = "/drive/v3/files";

/** Lists and searches of one shared drive, bound to it in the query. */
const driveListRoute = {
  method: "GET",
  host: apisHost,
  path: files,
  query: { corpora: "drive", driveId: "{drive}" },
} as const;

/**
 * How the egress checks a file's drive before a request for it: Google's
 * `driveId` for the file must be the bound drive.
 */
const driveCheck = {
  path: `${files}/{item}`,
  query: { supportsAllDrives: "true", fields: "driveId" },
  field: "driveId",
  equals: "{drive}",
} as const;

/** A shared drive's ID. */
const driveSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w-]+$/u);

const folderMimeType = "application/vnd.google-apps.folder";

/** Google's own formats, as the text each is exported to. */
const exportAs: Readonly<Record<string, string>> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const googleFile = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  /** In bytes, as a string (an int64); none for Google's own formats. */
  size: z.string().regex(/^\d+$/u).nullish(),
  modifiedTime: z.string().nullish(),
  webViewLink: z.string().nullish(),
  parents: z.array(z.string()).nullish(),
  driveId: z.string().nullish(),
  trashed: z.boolean().nullish(),
});
type GoogleFile = z.infer<typeof googleFile>;

const fileFields =
  "id,name,mimeType,size,modifiedTime,webViewLink,parents,driveId,trashed";

const itemSchema = z.strictObject({
  drive: z.string(),
  id: z.string(),
  name: z.string(),
  kind: z.enum(["file", "folder", "other"]),
  mimeType: z.string(),
  size: z.number().nullable(),
  parentId: z.string().nullable(),
  lastModifiedAt: z.string().nullable(),
  webUrl: z.string().nullable(),
});

/** Whether a file has content to read: its own bytes, or an export. */
const isReadable = (file: GoogleFile): boolean =>
  !file.mimeType.startsWith("application/vnd.google-apps.") ||
  Object.hasOwn(exportAs, file.mimeType);

const kindOf = (file: GoogleFile): "file" | "folder" | "other" => {
  if (file.mimeType === folderMimeType) {
    return "folder";
  }
  return isReadable(file) ? "file" : "other";
};

const itemOf = (
  drive: string,
  file: GoogleFile
): z.infer<typeof itemSchema> => ({
  drive,
  id: file.id,
  name: file.name,
  kind: kindOf(file),
  mimeType: file.mimeType,
  size: typeof file.size === "string" ? Number(file.size) : null,
  parentId: file.parents?.[0] ?? null,
  lastModifiedAt: file.modifiedTime ?? null,
  webUrl: file.webViewLink ?? null,
});

const pageOutput = z.strictObject({
  drive: z.string(),
  items: z.array(itemSchema),
  nextPage: z.string().nullable(),
});

const filePage = z.object({
  files: z.array(googleFile).nullish(),
  nextPageToken: z.string().nullish(),
});

/** A value inside a Drive query's quotes: `\` and `'` escaped. */
const quoted = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/**
 * One page of the drive's items matching `q`, as a tool returns it: only
 * those Google says are in the drive.
 */
const itemsOf = async (
  drive: string,
  q: string,
  top: number,
  page: string | undefined,
  orderBy?: string
) => {
  const { files: found, nextPageToken } = await googleJson(
    googleUrl(
      apisHost,
      files,
      {
        corpora: "drive",
        driveId: drive,
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        q,
        orderBy,
        pageSize: String(top),
        fields: `nextPageToken,files(${fileFields})`,
      },
      page
    ),
    filePage
  );
  const items = (found ?? []).filter((file) => file.driveId === drive);
  return {
    output: {
      drive,
      items: items.map((file) => itemOf(drive, file)),
      nextPage: nextPageOf(nextPageToken ?? undefined),
    },
    provenance: items.map(({ id }) => id),
  };
};

const listFolder = defineTool({
  name: "files.list",
  description:
    "Lists the files and folders in a folder of a shared drive, or at its top when no folder is given.",
  input: z.strictObject({
    drive: driveSchema,
    folder: idSchema.optional(),
    top: topSchema(100),
    page: pageSchema,
  }),
  output: pageOutput,
  readOnly: true,
  resource: "drive",
  routes: [driveListRoute],
  run: async ({ drive, folder, top, page }) =>
    // A shared drive's top folder has the drive's own ID.
    await itemsOf(
      drive,
      `${quoted(folder ?? drive)} in parents and trashed = false`,
      top ?? 50,
      page,
      "folder,name"
    ),
});

/** Search text: any, but no control characters. */
const querySchema = z
  .string()
  .min(1)
  .max(256)
  // oxlint-disable-next-line no-control-regex -- control characters are refused
  .regex(/^[^\u0000-\u001F\u007F]+$/u);

const searchFiles = defineTool({
  name: "files.search",
  description:
    "Searches a shared drive for files and folders by name and content, most relevant first.",
  input: z.strictObject({
    drive: driveSchema,
    query: querySchema,
    top: topSchema(100),
    page: pageSchema,
  }),
  output: pageOutput,
  readOnly: true,
  resource: "drive",
  // Drive's full-text search looks through names and contents.
  searches: { query: ["content"] },
  routes: [driveListRoute],
  run: async ({ drive, query, top, page }) =>
    await itemsOf(
      drive,
      `fullText contains ${quoted(query)} and trashed = false`,
      top ?? 50,
      page
    ),
});

const readFile = defineTool({
  name: "files.read",
  description:
    "Reads a file of a shared drive: as text, or as base64 to extract its content (a PDF, say). Google Docs and Slides come as plain text, Sheets as CSV (the first sheet). Up to 4 MiB.",
  input: z.strictObject({
    drive: driveSchema,
    item: idSchema,
    as: readAsSchema.optional(),
  }),
  output: z.strictObject({
    drive: z.string(),
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    /** The content's type: the file's own, or what it was exported to. */
    contentType: z.string(),
    size: z.number(),
    encoding: readAsSchema,
    content: z.string().nullable(),
  }),
  readOnly: true,
  resource: "drive",
  mask: ["content"],
  // A file has no drive in its path: the egress checks it with Google.
  routes: [
    {
      method: "GET",
      host: apisHost,
      path: `${files}/{item}`,
      check: driveCheck,
    },
    {
      method: "GET",
      host: apisHost,
      path: `${files}/{item}/export`,
      check: driveCheck,
    },
  ],
  run: async ({ drive, item: id, as }) => {
    const path = `${files}/${segment(id)}`;
    const file = await googleJson(
      googleUrl(apisHost, path, {
        supportsAllDrives: "true",
        fields: fileFields,
      }),
      googleFile
    );
    if (file.driveId !== drive || file.id !== id || file.trashed === true) {
      throw new ToolError("This drive has no such file", {
        code: "not_found",
      });
    }
    if (kindOf(file) !== "file") {
      throw new ToolError("This isn't a file with content to read", {
        code: "not_a_file",
      });
    }
    const exportType = Object.hasOwn(exportAs, file.mimeType)
      ? exportAs[file.mimeType]
      : undefined;
    checkReadable(Number(file.size ?? 0));
    const response = await googleFetch(
      exportType === undefined
        ? googleUrl(apisHost, path, { alt: "media", supportsAllDrives: "true" })
        : googleUrl(apisHost, `${path}/export`, { mimeType: exportType })
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      output: {
        drive,
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        contentType: exportType ?? file.mimeType,
        size: bytes.byteLength,
        ...contentAs(bytes, as ?? "text"),
      },
      provenance: [file.id],
    };
  },
});

export const driveTools = [listFolder, searchFiles, readFile];
