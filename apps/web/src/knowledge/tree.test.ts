import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { describe, expect, it } from "vite-plus/test";

import { countDocuments, folderTree, foldersTo } from "./tree.ts";

const document = (path: string): DocumentSummary => ({
  id: documentIdSchema.parse(path),
  collectionId: collectionIdSchema.parse("c"),
  path,
  title: path,
  type: "doc",
  description: "",
  owner: "u",
  tags: [],
  reviewDate: null,
  currentVersion: 1,
  updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("the navigation's tree", () => {
  it("puts each document in the folders its path names, keeping core's order", () => {
    const tree = folderTree(
      ["AGENTS.md", "policies/leave.md", "policies/pay/bonus.md", "x.md"].map(
        document
      )
    );
    expect({
      root: tree.documents.map(({ path }) => path),
      folders: tree.folders.map(({ path, name }) => [path, name]),
      inner: tree.folders[0]?.folders.map(({ path }) => path),
      deepest: tree.folders[0]?.folders[0]?.documents.map(({ path }) => path),
      count: countDocuments(tree),
    }).toStrictEqual({
      root: ["AGENTS.md", "x.md"],
      folders: [["policies", "policies"]],
      inner: ["policies/pay"],
      deepest: ["policies/pay/bonus.md"],
      count: 4,
    });
  });

  it("opens the folders on the way to a document, outermost first", () => {
    expect(foldersTo("a/b/c.md")).toStrictEqual(["a", "a/b"]);
    expect(foldersTo("c.md")).toStrictEqual([]);
  });
});
