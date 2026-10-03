import type { DocumentSummary } from "@grasp-os/shared/knowledge";

// A collection's documents as the navigation shows them: folders from the
// documents' paths (`policies/leave.md` is `leave.md` in `policies`), then
// documents, each level in path order, as core lists them.

/** A folder of a collection, by its path, with what is in it. */
export interface Folder {
  /** Its path in the collection, `""` for the collection itself. */
  path: string;
  /** The last part of its path. */
  name: string;
  folders: Folder[];
  documents: DocumentSummary[];
}

const emptyFolder = (path: string): Folder => ({
  path,
  name: path.split("/").at(-1) ?? path,
  folders: [],
  documents: [],
});

/** The folders and documents of `documents`, as one tree. */
export const folderTree = (documents: readonly DocumentSummary[]): Folder => {
  const root = emptyFolder("");
  const folders = new Map<string, Folder>([["", root]]);
  const folderAt = (path: string): Folder => {
    const known = folders.get(path);
    if (known !== undefined) {
      return known;
    }
    const slash = path.lastIndexOf("/");
    const parent = folderAt(slash === -1 ? "" : path.slice(0, slash));
    const folder = emptyFolder(path);
    parent.folders.push(folder);
    folders.set(path, folder);
    return folder;
  };
  for (const document of documents) {
    const slash = document.path.lastIndexOf("/");
    folderAt(slash === -1 ? "" : document.path.slice(0, slash)).documents.push(
      document
    );
  }
  return root;
};

/** The folders on the way to `path`, outermost first: those to open. */
export const foldersTo = (path: string): string[] => {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, depth) => parts.slice(0, depth + 1).join("/"));
};

/** How many documents a folder holds, in it and in its folders. */
export const countDocuments = (folder: Folder): number =>
  folder.documents.length +
  folder.folders.reduce((sum, inner) => sum + countDocuments(inner), 0);
