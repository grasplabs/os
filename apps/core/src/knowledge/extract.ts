import type { UploadMediaType } from "@grasp-os/shared/uploads";
import { uploadTypes } from "@grasp-os/shared/uploads";
import { unzipSync } from "fflate";
import type { CellValue, SheetData } from "read-excel-file/universal";

// Extracting an uploaded file's text as Markdown, with the headings that
// make its sections: a PDF's pages, a Word document's own headings, an
// Excel workbook's sheets. Each extractor turns one file into Markdown; which
// one an upload gets is decided in one place (uploads.ts), so another
// profile, such as on-prem, swaps it there.
//
// The local extractor runs here, in the Worker, on libraries that need
// nothing but workerd: unpdf (pdf.js built to run without a DOM or fs) and
// read-excel-file (on fflate). Word files are read here, from their XML,
// unzipped with fflate: mammoth, the usual library, runs on bluebird,
// whose one queue for every request's promises breaks when two requests
// extract at once in one isolate. Images aren't taken: nothing that fits a
// Worker reads text from them.

/** A file to extract: its name, its type (by its extension) and itself. */
export interface ExtractInput {
  name: string;
  mediaType: UploadMediaType;
  bytes: Uint8Array;
}

/** Turns a file into Markdown; throws when it can't read the file. */
export type Extractor = (file: ExtractInput) => Promise<string>;

/**
 * The most an Office file (a ZIP) may unzip to, by the sizes it declares:
 * far past the text a document holds, short of a small file that unzips
 * into more than a Worker's memory.
 */
const unzippedMaxBytes = 64 * 1024 * 1024;

/** Refuses an Office file whose parts would unzip past the limit. */
const requireUnzippable = (bytes: Uint8Array): void => {
  let total = 0;
  // Lists the parts without unzipping any.
  unzipSync(bytes, {
    filter: ({ originalSize }) => {
      total += originalSize;
      return false;
    },
  });
  if (total > unzippedMaxBytes) {
    throw new Error(`The file unzips to ${total} bytes`);
  }
};

/** A PDF, a section per page, as its text layer has it. */
const pdfMarkdown = async (bytes: Uint8Array): Promise<string> => {
  // Loaded on first use: pdf.js is most of core's code, and evaluating it
  // at every start would slow every request.
  const { extractText } = await import("unpdf");
  // A copy: pdf.js may take over the buffer it's given.
  const { text } = await extractText(new Uint8Array(bytes), {
    mergePages: false,
  });
  return text
    .map((page, index) => `## Page ${index + 1}\n\n${page.trim()}`)
    .join("\n\n");
};

const xmlEntity =
  /&(?:#x(?<hex>[\da-f]+)|#(?<decimal>\d+)|(?<name>[a-z]+));/giu;
/** Hex and decimal character references. */
const hexRadix = 16;
const decimalRadix = 10;

/** A character by its code point; the reference as it is past Unicode. */
const fromReference = (code: number, reference: string): string =>
  code <= 0x10_ff_ff ? String.fromCodePoint(code) : reference;

const namedEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

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

const styleElement =
  /<w:style\b[^>]*\bw:styleId="(?<id>[^"]+)"[^>]*>(?<body>[\s\S]*?)<\/w:style>/gu;
const styleName = /<w:name\s+w:val="(?<name>[^"]+)"/u;
const headingName = /^heading (?<level>[1-6])$/iu;
const outlineLevel = /<w:outlineLvl\s+w:val="(?<level>\d)"/u;
const paragraphElement = /<w:p\b[^>]*>(?<body>[\s\S]*?)<\/w:p>/gu;
const paragraphStyle = /<w:pStyle\s+w:val="(?<id>[^"]+)"/u;
const runContent =
  /<w:t(?:\s[^>]*)?>(?<text>[^<]*)<\/w:t>|<w:(?<mark>tab|br)\b[^>]*\/>/gu;

/** A heading's level from an outline level, 0 for the top. */
const levelOfOutline = (body: string): number | undefined => {
  const level = outlineLevel.exec(body)?.groups?.level;
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
  for (const { groups } of styles.matchAll(styleElement)) {
    const { id = "", body = "" } = groups ?? {};
    const named = headingName.exec(styleName.exec(body)?.groups?.name ?? "")
      ?.groups?.level;
    const level = named === undefined ? levelOfOutline(body) : Number(named);
    if (level !== undefined) {
      levels.set(id, level);
    }
  }
  return levels;
};

/** A paragraph's text, with its tabs and line breaks. */
const paragraphText = (body: string): string =>
  Array.from(body.matchAll(runContent), ({ groups }) => {
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
  requireUnzippable(bytes);
  const parts = unzipSync(bytes, { filter: ({ name }) => docxParts.has(name) });
  const document = parts["word/document.xml"];
  if (document === undefined) {
    throw new Error("The file has no Word document in it");
  }
  const decoder = new TextDecoder();
  const styles = parts["word/styles.xml"];
  const headings = headingStyles(
    styles === undefined ? "" : decoder.decode(styles)
  );
  const paragraphs = Array.from(
    decoder.decode(document).matchAll(paragraphElement),
    ({ groups }) => {
      const body = groups?.body ?? "";
      const text = paragraphText(body);
      const style = paragraphStyle.exec(body)?.groups?.id;
      const level =
        levelOfOutline(body) ??
        (style === undefined ? undefined : headings.get(style));
      return level === undefined || text === ""
        ? text
        : `${"#".repeat(level)} ${text}`;
    }
  );
  return paragraphs.filter((paragraph) => paragraph !== "").join("\n\n");
};

const tableSeparator = /[|\\]/gu;
const lineBreaks = /\r?\n/gu;

/** A cell as text in a Markdown table. */
const cellText = (value: CellValue | null | undefined): string => {
  if (value === null || value === undefined) {
    return "";
  }
  const text =
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return text
    .replaceAll(tableSeparator, (character) => `\\${character}`)
    .replaceAll(lineBreaks, " ")
    .trim();
};

/** A sheet's rows as a Markdown table, its first row as the header. */
const markdownTable = (rows: SheetData): string => {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (row: SheetData[number]) =>
    `| ${Array.from({ length: width }, (_, index) => cellText(row[index])).join(" | ")} |`;
  const [header = [], ...body] = rows;
  return [
    line(header),
    `|${" --- |".repeat(width)}`,
    ...body.map((row) => line(row)),
  ].join("\n");
};

/** An Excel workbook, a section per sheet, each as a table. */
const xlsxMarkdown = async (bytes: Uint8Array): Promise<string> => {
  requireUnzippable(bytes);
  const { default: readXlsxFile } = await import("read-excel-file/universal");
  const sheets = await readXlsxFile(new Uint8Array(bytes).buffer);
  return sheets
    .map(({ sheet, data }) => `## ${sheet}\n\n${markdownTable(data)}`)
    .join("\n\n");
};

const extractors: Readonly<
  Record<UploadMediaType, (bytes: Uint8Array) => string | Promise<string>>
> = {
  [uploadTypes.pdf]: pdfMarkdown,
  [uploadTypes.docx]: docxMarkdown,
  [uploadTypes.xlsx]: xlsxMarkdown,
};

/** Extracts text here, in the Worker, whatever the file's collection. */
export const localExtractor: Extractor = async ({ mediaType, bytes }) =>
  await extractors[mediaType](bytes);
