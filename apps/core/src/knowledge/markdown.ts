import { documentPathProblem } from "@grasp-os/shared/knowledge";

// How a document's Markdown becomes sections and links. Line based, and
// deliberately small: ATX headings (`# Title`) start sections, `[[links]]`
// name other documents, and neither counts inside fenced code blocks or
// inline code.

/** One part of a document, from a heading to the next heading. */
export interface Section {
  /** The headings above and of this section, outermost first. */
  headings: string[];
  /** Its Markdown, heading line included. */
  text: string;
}

/** A `[[link]]`: the path it names, and its own text if it has one. */
export interface Link {
  path: string;
  label: string | null;
}

const lineBreak = /\r?\n/u;
const atxHeading =
  /^ {0,3}(?<marks>#{1,6})(?:[ \t]+(?<title>.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const fenceOpening = /^ {0,3}(?<fence>`{3,}|~{3,})/u;
const inlineCode = /(?<ticks>`+)[^`]*?\k<ticks>/gu;
const wikiLink = /\[\[(?<inner>[^[\]\n]+)\]\]/gu;
const extension = /\.[^./]+$/u;

/** Tracks fenced code blocks line by line. */
const fenceTracker = () => {
  let open: string | undefined;
  /** Whether `line` is part of a fenced code block, fences included. */
  return (line: string): boolean => {
    const fence = fenceOpening.exec(line)?.groups?.fence;
    if (open === undefined) {
      if (fence !== undefined) {
        open = fence;
        return true;
      }
      return false;
    }
    // A closing fence is the same character, at least as long, and bare.
    if (fence?.startsWith(open) === true && line.trim() === fence) {
      open = undefined;
    }
    return true;
  };
};

/**
 * Splits Markdown into sections by heading. Text before the first heading
 * is a section of its own, without headings, when it isn't blank.
 */
export const splitSections = (markdown: string): Section[] => {
  const sections: Section[] = [];
  const inCode = fenceTracker();
  const stack: { level: number; title: string }[] = [];
  let current: { headings: string[]; lines: string[] } = {
    headings: [],
    lines: [],
  };
  const close = () => {
    const text = current.lines.join("\n").trim();
    if (text !== "") {
      sections.push({ headings: current.headings, text });
    }
  };
  for (const line of markdown.split(lineBreak)) {
    const heading = inCode(line) ? null : atxHeading.exec(line);
    if (heading) {
      close();
      const level = heading.groups?.marks?.length ?? 1;
      while ((stack.at(-1)?.level ?? 0) >= level) {
        stack.pop();
      }
      stack.push({ level, title: heading.groups?.title?.trim() ?? "" });
      current = { headings: stack.map(({ title }) => title), lines: [] };
    }
    current.lines.push(line);
  }
  close();
  return sections;
};

/**
 * The path a link names: relative to the collection, with `.md` added when
 * it names no extension. `undefined` when it isn't a document path.
 */
const linkPath = (target: string): string | undefined => {
  const [withoutHeading = ""] = target.split("#");
  const trimmed = withoutHeading.trim();
  if (trimmed === "") {
    // A link to a heading in the same document.
    return undefined;
  }
  const path = extension.test(trimmed) ? trimmed : `${trimmed}.md`;
  return documentPathProblem(path) === undefined ? path : undefined;
};

/**
 * The `[[links]]` in Markdown, once per path, in order: `[[path]]`,
 * `[[path|label]]` or `[[path#heading]]`. A link that doesn't name a valid
 * path isn't one.
 */
export const extractLinks = (markdown: string): Link[] => {
  const found = new Map<string, Link>();
  const inCode = fenceTracker();
  for (const line of markdown.split(lineBreak)) {
    if (!inCode(line)) {
      for (const { groups } of line
        .replaceAll(inlineCode, "")
        .matchAll(wikiLink)) {
        const [target = "", ...rest] = (groups?.inner ?? "").split("|");
        const path = linkPath(target);
        const label = rest.join("|").trim();
        if (path !== undefined && !found.has(path)) {
          found.set(path, { path, label: label === "" ? null : label });
        }
      }
    }
  }
  return [...found.values()];
};
