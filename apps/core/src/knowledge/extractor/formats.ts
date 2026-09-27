import { unzipSync } from "fflate";
import { extractText } from "unpdf";

// Each file type's text as Markdown, with the headings that make its
// sections: a PDF's pages, a Word document's own headings, an Excel
// workbook's sheets. This runs only inside the extractor's sandbox
// (worker.ts), never in core: a file crafted to exhaust a parser exhausts
// only that isolate.
//
// Word and Excel files are ZIP archives of XML, unzipped with fflate's
// synchronous `unzipSync` (its asynchronous `unzip` starts Web Workers,
// which a Worker doesn't have) and read here in one pass each: every
// pattern stops at the next `<`, so no input makes them scan back over
// what they read.

/**
 * The most an Office file may unzip to, by the sizes it declares: far past
 * the text one document holds. `unzipSync` inflates each part into the
 * size it declares, so one that understates its size is cut short, never
 * inflated past it.
 */
const unzippedMaxBytes = 16 * 1024 * 1024;

/** Why a file was refused before reading it. */
export class TooLargeError extends Error {
  constructor() {
    super("The file unzips to more than a document holds");
    this.name = "TooLargeError";
  }
}

/** The parts of an Office file that `wanted` names, by name, as text. */
const unzipParts = (
  bytes: Uint8Array,
  wanted: (name: string) => boolean
): Map<string, string> => {
  let total = 0;
  // Lists the parts without unzipping any.
  unzipSync(bytes, {
    filter: ({ originalSize }) => {
      total += originalSize;
      return false;
    },
  });
  if (total > unzippedMaxBytes) {
    throw new TooLargeError();
  }
  const decoder = new TextDecoder();
  const parts = unzipSync(bytes, { filter: ({ name }) => wanted(name) });
  return new Map(
    Object.entries(parts).map(([name, data]) => [name, decoder.decode(data)])
  );
};

/** A PDF, a section per page, as its text layer has it. */
const pdfMarkdown = async (bytes: Uint8Array): Promise<string> => {
  // A copy: pdf.js may take over the buffer it's given.
  const { text } = await extractText(new Uint8Array(bytes), {
    mergePages: false,
  });
  return text
    .map((page, index) => `## Page ${index + 1}\n\n${page.trim()}`)
    .join("\n\n");
};

const xmlEntity =
  /&(?:#x(?<hex>[\da-f]{1,6})|#(?<decimal>\d{1,7})|(?<name>[a-z]{2,4}));/giu;
const hexRadix = 16;
const decimalRadix = 10;
const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** A character by its code point; the reference as it is past Unicode. */
const fromReference = (code: number, reference: string): string =>
  code <= 0x10_ff_ff ? String.fromCodePoint(code) : reference;

/** XML text with its entities decoded. */
const xmlText = (text: string): string =>
  text.replaceAll(
    xmlEntity,
    (entity, hex?: string, decimal?: string, name?: string) => {
      if (hex !== undefined) {
        return fromReference(Number.parseInt(hex, hexRadix), entity);
      }
      if (decimal !== undefined) {
        return fromReference(Number.parseInt(decimal, decimalRadix), entity);
      }
      return namedEntities[name ?? ""] ?? entity;
    }
  );

/**
 * The elements `closing` ends, each from its last opening tag (`opening`,
 * followed by a space, `>` or `/`) up to its closing tag: one pass over
 * the text, whatever it holds. An opening tag never closed is dropped.
 */
const elements = (text: string, opening: string, closing: string): string[] =>
  text.split(closing).flatMap((piece, index, pieces) => {
    if (index === pieces.length - 1) {
      return [];
    }
    for (let at = piece.lastIndexOf(opening); at !== -1;) {
      const next = piece[at + opening.length];
      if (next === " " || next === ">" || next === "/") {
        return [piece.slice(at)];
      }
      at = at === 0 ? -1 : piece.lastIndexOf(opening, at - 1);
    }
    return [];
  });

/**
 * Each tag named `name` in `text`, from just after its name: one pass. A
 * longer name that starts the same (`<sheets>` for `sheet`) isn't one.
 */
const tags = (text: string, name: string): string[] =>
  text
    .split(`<${name}`)
    .slice(1)
    .filter((tag) => tag.startsWith(" ") || tag.startsWith("/"))
    .map((tag) => ` ${tag}`);

/** The value of `name` in the first tag of `element`, if it has one. */
const attribute = (element: string, name: string): string | undefined => {
  const end = element.indexOf(">");
  const tag = end === -1 ? element : element.slice(0, end);
  const at = tag.indexOf(` ${name}="`);
  if (at === -1) {
    return undefined;
  }
  const start = at + name.length + 3;
  const close = tag.indexOf('"', start);
  return close === -1 ? undefined : xmlText(tag.slice(start, close));
};

const styleName = /<w:name\s[^<>]*w:val="(?<name>[^"<>]*)"/u;
const headingName = /^heading (?<level>[1-6])$/iu;
const outlineLevel = /<w:outlineLvl\s[^<>]*w:val="(?<level>\d)"/u;
const paragraphStyle = /<w:pStyle\s[^<>]*w:val="(?<id>[^"<>]*)"/u;
const runContent =
  /<w:t(?:\s[^<>]*)?>(?<text>[^<]*)<\/w:t>|<w:(?<mark>tab|br)(?:\s[^<>]*)?\/>/gu;

/** A heading's level from an outline level, 0 for the top. */
const levelOfOutline = (element: string): number | undefined => {
  const level = outlineLevel.exec(element)?.groups?.level;
  return level !== undefined && Number(level) < 6
    ? Number(level) + 1
    : undefined;
};

/**
 * The heading level of each paragraph style that is a heading: a built-in
 * one by its name (`heading 1`, whatever the styles are called in the
 * document's language), or one with an outline level.
 */
const headingStyles = (styles: string): Map<string, number> => {
  const levels = new Map<string, number>();
  for (const style of elements(styles, "<w:style", "</w:style>")) {
    const id = attribute(style, "w:styleId");
    const named = headingName.exec(styleName.exec(style)?.groups?.name ?? "")
      ?.groups?.level;
    const level = named === undefined ? levelOfOutline(style) : Number(named);
    if (id !== undefined && level !== undefined) {
      levels.set(id, level);
    }
  }
  return levels;
};

/** A paragraph's text, with its tabs and line breaks. */
const paragraphText = (paragraph: string): string =>
  Array.from(paragraph.matchAll(runContent), ({ groups }) => {
    if (groups?.mark === "tab") {
      return "\t";
    }
    if (groups?.mark === "br") {
      return "\n";
    }
    return xmlText(groups?.text ?? "");
  })
    .join("")
    .trim();

const docxParts = new Set(["word/document.xml", "word/styles.xml"]);

/**
 * A Word document, a section per heading: each paragraph on its own, a
 * heading's by its style or outline level, a table's cells each as one.
 */
const docxMarkdown = (bytes: Uint8Array): string => {
  const parts = unzipParts(bytes, (name) => docxParts.has(name));
  const document = parts.get("word/document.xml");
  if (document === undefined) {
    throw new Error("The file has no Word document in it");
  }
  const headings = headingStyles(parts.get("word/styles.xml") ?? "");
  return elements(document, "<w:p", "</w:p>")
    .map((paragraph) => {
      const text = paragraphText(paragraph);
      const style = paragraphStyle.exec(paragraph)?.groups?.id;
      const level =
        levelOfOutline(paragraph) ??
        (style === undefined ? undefined : headings.get(style));
      return level === undefined || text === ""
        ? text
        : `${"#".repeat(level)} ${text}`;
    })
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
};

const textContent = /<t(?:\s[^<>]*)?>(?<text>[^<]*)<\/t>/gu;
const cellValue = /<v(?:\s[^<>]*)?>(?<value>[^<]*)<\/v>/u;
const columnLetters = /^[A-Z]{1,3}/u;
const lettersInAlphabet = 26;

/** The text of every `<t>` in `element`, joined: a string's runs. */
const texts = (element: string): string =>
  Array.from(element.matchAll(textContent), ({ groups }) =>
    xmlText(groups?.text ?? "")
  ).join("");

/** A cell's column, from 0, by its reference (`C7` is 2). */
const columnOf = (reference: string | undefined): number | undefined => {
  const letters = columnLetters.exec(reference ?? "")?.[0];
  if (letters === undefined) {
    return undefined;
  }
  let column = 0;
  for (const letter of letters) {
    column = column * lettersInAlphabet + ((letter.codePointAt(0) ?? 64) - 64);
  }
  return column - 1;
};

/** A cell as its text: a shared or inline string, a boolean, a number as written. */
const cellText = (cell: string, shared: string[]): string => {
  const type = attribute(cell, "t");
  if (type === "inlineStr") {
    return texts(cell);
  }
  const value = xmlText(cellValue.exec(cell)?.groups?.value ?? "");
  if (type === "s") {
    return shared[Number(value)] ?? "";
  }
  if (type === "b") {
    return value === "1" ? "TRUE" : "FALSE";
  }
  return value;
};

const tableSeparator = /[|\\]/gu;
const lineBreaks = /\r?\n/gu;

/** Text as one cell of a Markdown table. */
const tableCell = (text: string): string =>
  text
    .replaceAll(tableSeparator, (character) => `\\${character}`)
    .replaceAll(lineBreaks, " ")
    .trim();

/** A sheet's rows as a Markdown table, its first row as the header. */
const markdownTable = (rows: string[][]): string => {
  let width = 1;
  for (const row of rows) {
    width = Math.max(width, row.length);
  }
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => tableCell(row[index] ?? "")).join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [
    line(header),
    `|${" --- |".repeat(width)}`,
    ...body.map((row) => line(row)),
  ].join("\n");
};

/** A sheet's rows, each cell at its column, with the strings it shares. */
const sheetRows = (sheet: string, shared: string[]): string[][] =>
  elements(sheet, "<row", "</row>").map((row) => {
    const cells: string[] = [];
    for (const cell of elements(row, "<c", "</c>")) {
      const column = columnOf(attribute(cell, "r")) ?? cells.length;
      cells[column] = cellText(cell, shared);
    }
    return Array.from(cells, (cell) => cell ?? "");
  });

/** Where a workbook part points: a path in the archive, from `xl/`. */
const partPath = (target: string): string =>
  target.startsWith("/") ? target.slice(1) : `xl/${target}`;

/**
 * An Excel workbook, a section per sheet, each as a table: numbers as
 * written (a date is its serial number), strings, booleans.
 */
const xlsxMarkdown = (bytes: Uint8Array): string => {
  const parts = unzipParts(
    bytes,
    (name) => name.endsWith(".xml") || name.endsWith(".rels")
  );
  const workbook = parts.get("xl/workbook.xml");
  if (workbook === undefined) {
    throw new Error("The file has no workbook in it");
  }
  const targets = new Map(
    tags(parts.get("xl/_rels/workbook.xml.rels") ?? "", "Relationship").map(
      (tag): [string, string] => [
        attribute(tag, "Id") ?? "",
        attribute(tag, "Target") ?? "",
      ]
    )
  );
  const shared = elements(
    parts.get("xl/sharedStrings.xml") ?? "",
    "<si",
    "</si>"
  ).map((item) => texts(item));
  const sheets = tags(workbook, "sheet").flatMap((tag) => {
    const name = attribute(tag, "name");
    const target = targets.get(attribute(tag, "r:id") ?? "");
    return name === undefined || target === undefined
      ? []
      : [{ name, path: partPath(target) }];
  });
  return sheets
    .map(
      ({ name, path }) =>
        `## ${name}\n\n${markdownTable(sheetRows(parts.get(path) ?? "", shared))}`
    )
    .join("\n\n");
};

/** The types the extractor reads, by media type. */
export const formats: Readonly<
  Record<string, (bytes: Uint8Array) => string | Promise<string>>
> = {
  "application/pdf": pdfMarkdown,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    docxMarkdown,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    xlsxMarkdown,
};
