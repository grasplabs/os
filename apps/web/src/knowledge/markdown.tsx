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
import type { ReactNode } from "react";
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
// collection opens it here (wiki-links.ts). The agent's answers render the
// same way (`PlainMarkdown`): they may repeat whatever the agent read.

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

/**
 * A link that leaves the page: in a tab of its own, without this page as
 * its opener. An address the transform emptied was unsafe: the text stays,
 * as text.
 */
const OutsideLink = ({
  href,
  children,
}: {
  href?: string | undefined;
  children?: ReactNode;
}) =>
  href === undefined || href === "" ? (
    <span>{children}</span>
  ) : (
    <a
      className="underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );

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
    const documentId = href === undefined ? undefined : documentOf(href);
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
    return <OutsideLink href={href}>{children}</OutsideLink>;
  },
  img: ({ alt }) =>
    alt === undefined || alt === "" ? null : <span>{alt}</span>,
};

/**
 * The same, for text that isn't a document of a collection (the agent's
 * answers): every link leaves the page.
 */
const plainComponents: Components = {
  ...components,
  a: ({ href, children }) => <OutsideLink href={href}>{children}</OutsideLink>,
};

/**
 * Markdown that isn't a Knowledge document, such as the agent's answers,
 * as safely as a document: no raw HTML, safe links only, no images.
 */
export const PlainMarkdown = ({ text }: { text: string }) => (
  <div className="flex flex-col gap-3">
    <Markdown components={plainComponents} remarkPlugins={[remarkGfm]} skipHtml>
      {text}
    </Markdown>
  </div>
);

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
