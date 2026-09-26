import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import {
  checkReadable,
  contentAs,
  readAsSchema,
} from "@grasp-os/connector-kit/content";
import { segmentValuePattern } from "@grasp-os/connector-kit/manifest";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  downloadHosts,
  driveSchema,
  graphFetch,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  nextPageOf,
  pageOf,
  pageSchema,
  topSchema,
  v1,
} from "./graph.ts";

// Files, in one drive per call: a person's OneDrive or a SharePoint site's
// document library, both as `/drives/{drive}`, so a call's capability
// binds every request to its drive. Items are addressed by ID only.

const drives = `${v1}/drives/{drive}`;

const get = (path: string) =>
  ({ method: "GET", host: graphHost, path: `${drives}${path}` }) as const;

const graphItem = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative().nullish(),
  webUrl: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  file: z.object({ mimeType: z.string().nullish() }).nullish(),
  folder: z.object({ childCount: z.number().nullish() }).nullish(),
  parentReference: z
    .object({ id: z.string().nullish(), driveId: z.string().nullish() })
    .nullish(),
});
type GraphItem = z.infer<typeof graphItem>;

const itemFields =
  "id,name,size,webUrl,lastModifiedDateTime,file,folder,parentReference";

const itemSchema = z.strictObject({
  drive: z.string(),
  id: z.string(),
  name: z.string(),
  kind: z.enum(["file", "folder", "other"]),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
  parentId: z.string().nullable(),
  lastModifiedAt: z.string().nullable(),
  webUrl: z.string().nullable(),
});

const kindOf = (item: GraphItem): "file" | "folder" | "other" => {
  if (item.folder) {
    return "folder";
  }
  return item.file ? "file" : "other";
};

const itemOf = (
  drive: string,
  item: GraphItem
): z.infer<typeof itemSchema> => ({
  drive,
  id: item.id,
  name: item.name,
  kind: kindOf(item),
  mimeType: item.file?.mimeType ?? null,
  size: item.size ?? null,
  parentId: item.parentReference?.id ?? null,
  lastModifiedAt: item.lastModifiedDateTime ?? null,
  webUrl: item.webUrl ?? null,
});

const pageOutput = z.strictObject({
  drive: z.string(),
  items: z.array(itemSchema),
  nextPage: z.string().nullable(),
});

/**
 * Whether an item is in `drive`, as Graph says. A search can find items
 * shared from elsewhere; only the bound drive's are passed on.
 */
const isIn = (drive: string, item: GraphItem): boolean =>
  item.parentReference?.driveId === drive;

/** One page of the drive's items, as a tool returns it. */
const itemsAt = async (drive: string, url: URL, page: string | undefined) => {
  const { value, "@odata.nextLink": nextLink } = await graphJson(
    atPage(url, page),
    pageOf(graphItem)
  );
  const items = value.filter((item) => isIn(drive, item));
  return {
    output: {
      drive,
      items: items.map((item) => itemOf(drive, item)),
      nextPage: nextPageOf(nextLink),
    },
    provenance: items.map(({ id }) => id),
  };
};

const listFolder = defineTool({
  name: "files.list",
  description:
    "Lists the files and folders in a folder of a drive (a OneDrive, or a SharePoint document library), or at its top when no folder is given.",
  input: z.strictObject({
    drive: driveSchema,
    folder: idSchema.optional(),
    top: topSchema,
    page: pageSchema,
  }),
  output: pageOutput,
  readOnly: true,
  resource: "drive",
  routes: [get("/root/children"), get("/items/{folder}/children")],
  run: async ({ drive, folder, top, page }) => {
    const path =
      folder === undefined
        ? `/drives/${segment(drive)}/root/children`
        : `/drives/${segment(drive)}/items/${segment(folder)}/children`;
    return await itemsAt(
      drive,
      graphUrl(path, { $select: itemFields, $top: String(top ?? 50) }),
      page
    );
  },
});

/**
 * Search text for Graph's `search(q='...')`, inside one path segment: no
 * character the egress refuses in a parameter.
 */
const querySchema = z.string().min(1).max(256).regex(segmentValuePattern);

const searchFiles = defineTool({
  name: "files.search",
  description:
    "Searches a drive (a OneDrive, or a SharePoint document library) for files and folders by name and content.",
  input: z.strictObject({
    drive: driveSchema,
    query: querySchema,
    top: topSchema,
    page: pageSchema,
  }),
  output: pageOutput,
  readOnly: true,
  resource: "drive",
  routes: [get("/root/search(q='{query}')")],
  run: async ({ drive, query, top, page }) => {
    // OData quotes a quote by doubling it.
    const quoted = segment(query.replaceAll("'", "''"));
    return await itemsAt(
      drive,
      graphUrl(`/drives/${segment(drive)}/root/search(q='${quoted}')`, {
        $select: itemFields,
        $top: String(top ?? 50),
      }),
      page
    );
  },
});

const readFile = defineTool({
  name: "files.read",
  description:
    "Reads a file of a drive: as text, or as base64 to extract its content (a PDF, say). Up to 4 MiB.",
  input: z.strictObject({
    drive: driveSchema,
    item: idSchema,
    as: readAsSchema.optional(),
  }),
  output: z.strictObject({
    drive: z.string(),
    id: z.string(),
    name: z.string(),
    mimeType: z.string().nullable(),
    size: z.number(),
    encoding: readAsSchema,
    content: z.string().nullable(),
  }),
  readOnly: true,
  resource: "drive",
  mask: ["content"],
  routes: [
    get("/items/{item}"),
    // Graph answers with a redirect to the file on SharePoint, which the
    // egress follows without the token.
    { ...get("/items/{item}/content"), redirects: downloadHosts },
  ],
  run: async ({ drive, item: id, as }) => {
    const path = `/drives/${segment(drive)}/items/${segment(id)}`;
    const item = await graphJson(
      graphUrl(path, { $select: itemFields }),
      graphItem
    );
    if (!isIn(drive, item)) {
      throw new ToolError("This drive has no such item", {
        code: "not_found",
      });
    }
    if (kindOf(item) !== "file") {
      throw new ToolError("This isn't a file", { code: "not_a_file" });
    }
    checkReadable(item.size ?? 0);
    const response = await graphFetch(graphUrl(`${path}/content`));
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      output: {
        drive,
        id: item.id,
        name: item.name,
        mimeType: item.file?.mimeType ?? null,
        size: bytes.byteLength,
        ...contentAs(bytes, as ?? "text"),
      },
      provenance: [item.id],
    };
  },
});

export const fileTools = [listFolder, searchFiles, readFile];
