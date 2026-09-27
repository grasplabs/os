import { linkPath, wikiLinkPattern } from "@grasp-os/shared/knowledge";

// `[[path]]`, `[[path|label]]` and `[[path#heading]]` links, as a remark
// plugin: each one that names a document the page knows becomes a link to
// it (`?doc=<id>`, on the collection's page), labelled with its label or
// its target. One the page can't resolve stays as it was written. Code
// holds no links: inline and fenced code aren't text nodes.

/** The part of a Markdown syntax tree this plugin reads and writes. */
interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

/** The document ID at `path` in this collection, if the page knows it. */
export type ResolveLink = (path: string) => string | undefined;

/** The address a resolved link goes to: that document, on this page. */
export const documentHref = (documentId: string): string =>
  `?doc=${encodeURIComponent(documentId)}`;

/** Text, with each link in it that `resolve` knows made a link node. */
const linked = (value: string, resolve: ResolveLink): MarkdownNode[] => {
  const nodes: MarkdownNode[] = [];
  let from = 0;
  for (const match of value.matchAll(wikiLinkPattern)) {
    const [target = "", ...rest] = (match.groups?.inner ?? "").split("|");
    const path = linkPath(target);
    const documentId = path === undefined ? undefined : resolve(path);
    if (documentId !== undefined) {
      if (match.index > from) {
        nodes.push({ type: "text", value: value.slice(from, match.index) });
      }
      const label = rest.join("|").trim();
      nodes.push({
        type: "link",
        url: documentHref(documentId),
        children: [
          { type: "text", value: label === "" ? target.trim() : label },
        ],
      });
      from = match.index + match[0].length;
    }
  }
  if (from < value.length) {
    nodes.push({ type: "text", value: value.slice(from) });
  }
  return nodes;
};

/** Rewrites the text under `node`, never inside an existing link. */
const rewrite = (node: MarkdownNode, resolve: ResolveLink): void => {
  if (node.children === undefined) {
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (child.type === "text") {
      return linked(child.value ?? "", resolve);
    }
    if (child.type !== "link" && child.type !== "linkReference") {
      rewrite(child, resolve);
    }
    return [child];
  });
};

/** The remark plugin, resolving links with `resolve`. */
export const remarkWikiLinks =
  ({ resolve }: { resolve: ResolveLink }) =>
  (tree: MarkdownNode): void => {
    rewrite(tree, resolve);
  };
