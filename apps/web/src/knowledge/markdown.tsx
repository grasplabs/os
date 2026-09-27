import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// A Knowledge document, rendered. Its text is whatever anyone who may
// change the collection wrote, or whatever an uploaded file held, so
// nothing in it runs or loads: raw HTML is dropped (`skipHtml`), a link
// keeps its address only for a safe protocol (http, https, mailto and a
// few more; react-markdown's `defaultUrlTransform` empties any other, such
// as `javascript:`), and opens in a tab of its own without this page as
// its opener. Images show their alt text: loading one would tell its host
// who read the document, and when.

/** YAML frontmatter at the start of a document: its fields, not its prose. */
const frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u;

/** A document's Markdown without its frontmatter. */
export const bodyOf = (text: string): string => text.replace(frontmatter, "");

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
  table: ({ children }) => (
    <table className="w-full border-collapse text-sm">{children}</table>
  ),
  th: ({ children }) => (
    <th className="border px-2 py-1 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
  // An address the transform emptied was unsafe: the text stays, as text.
  a: ({ href, children }) =>
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
    ),
  img: ({ alt }) =>
    alt === undefined || alt === "" ? null : <span>{alt}</span>,
};

/** A document's text, frontmatter left out, as safe rendered Markdown. */
export const DocumentMarkdown = ({ text }: { text: string }) => {
  const body = bodyOf(text).trim();
  if (body === "") {
    return (
      <p className="text-muted-foreground text-sm">This document is empty.</p>
    );
  }
  return (
    <article className="flex flex-col gap-3">
      <Markdown components={components} remarkPlugins={[remarkGfm]} skipHtml>
        {body}
      </Markdown>
    </article>
  );
};
