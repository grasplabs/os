import { splitFrontmatterBlock } from "@grasp-os/shared/knowledge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Link } from "@tanstack/react-router";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { remarkWikiLinks } from "./wiki-links.ts";
import type { ResolveLink } from "./wiki-links.ts";

// A Knowledge document, rendered. Its text is whatever anyone who may
// change the collection wrote, or whatever an uploaded file held, so
// nothing in it runs or loads: raw HTML is dropped (`skipHtml`), a link
// keeps its address only for a safe protocol (http, https, mailto and a
// few more; react-markdown's `defaultUrlTransform` empties any other, such
// as `javascript:`), and opens in a tab of its own without this page as
// its opener. Images show their alt text: loading one would tell its host
// who read the document, and when. A `[[link]]` to a document of the
// collection opens it here (wiki-links.ts).

/**
 * A document's Markdown without its frontmatter, found as core finds it.
 * Text that opens a block it never closes (core never saves one) shows
 * whole.
 */
export const bodyOf = (text: string): string =>
  splitFrontmatterBlock(text)?.body ?? text;

/** A resolved `[[link]]`'s address (`documentHref`), or one written so. */
const documentLink = /^\?doc=[^&#]+$/u;

/**
 * The document a link on this page opens, if it is one. Read with
 * `URLSearchParams`, which never throws on a malformed escape, as
 * `decodeURIComponent` would, in the middle of rendering.
 */
const documentOf = (href: string): string | undefined =>
  documentLink.test(href)
    ? (new URLSearchParams(href.slice(1)).get("doc") ?? undefined)
    : undefined;

const components: Components = {
  h1: ({ children }) => <h1 className="text-2xl font-medium">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xl font-medium">{children}</h2>,
  h3: ({ children }) => <h3 className="text-lg font-medium">{children}</h3>,
  h4: ({ children }) => <h4 className="font-medium">{children}</h4>,
  h5: ({ children }) => <h5 className="font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="font-medium">{children}</h6>,
  ul: ({ children }) => <ul className="list-disc pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-6">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="text-muted-foreground border-l-2 pl-4">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="font-mono text-sm">{children}</code>,
  table: ({ children }) => <Table>{children}</Table>,
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
  a: ({ href, children }) => {
    // An address the transform emptied was unsafe: the text stays, as text.
    if (href === undefined || href === "") {
      return <span>{children}</span>;
    }
    const documentId = documentOf(href);
    if (documentId !== undefined) {
      return (
        <Link
          className="underline"
          from="/knowledge/$collection"
          search={{ doc: documentId }}
        >
          {children}
        </Link>
      );
    }
    // Any other, a `#heading` too, opens apart from this page.
    return (
      <a
        className="underline"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {children}
      </a>
    );
  },
  img: ({ alt }) =>
    alt === undefined || alt === "" ? null : <span>{alt}</span>,
};

/**
 * A document's text, frontmatter left out, as safe rendered Markdown, its
 * `[[links]]` resolved by `resolve`.
 */
export const DocumentMarkdown = ({
  text,
  resolve,
}: {
  text: string;
  resolve: ResolveLink;
}) => {
  const body = bodyOf(text).trim();
  if (body === "") {
    return (
      <p className="text-muted-foreground text-sm">This document is empty.</p>
    );
  }
  return (
    <article className="flex flex-col gap-3">
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm, [remarkWikiLinks, { resolve }]]}
        skipHtml
      >
        {body}
      </Markdown>
    </article>
  );
};
