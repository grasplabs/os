import { parse } from "@messageformat/parser";
import type { Token } from "@messageformat/parser";
import { describe, expect, it } from "vite-plus/test";

// Every language has every message, each one valid ICU, and each keeps the
// English placeholders and tags: a translation that drops `{name}` or
// `<0>` breaks the page. The catalogs are read as text: the Lingui plugin
// compiles a `.po` import, and this needs what translators wrote.

interface Entry {
  key: string;
  id: string;
  str: string;
}

const translated = ["de", "nl", "es", "fr"] as const;

const files = import.meta.glob<string>("./*/messages.po", {
  query: "?raw",
  import: "default",
  eager: true,
});

const fieldLine = /^(?<field>msgctxt|msgid|msgstr) (?<value>".*")$/u;
const blankLine = /\n\s*\n/u;
const numberedTag = /<\/?\d+\/?>/gu;

const unquote = (quoted: string): string => {
  const value: unknown = JSON.parse(quoted);
  if (typeof value !== "string") {
    throw new TypeError(`Not a quoted string: ${quoted}`);
  }
  return value;
};

/** A block's fields: a field's text continues on the lines that follow it. */
const fieldsOf = (block: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  let field: string | undefined;
  for (const line of block.split("\n")) {
    const { field: named, value } = fieldLine.exec(line)?.groups ?? {};
    if (named !== undefined && value !== undefined) {
      field = named;
      fields[field] = unquote(value);
    } else if (field !== undefined && line.startsWith('"')) {
      fields[field] = `${fields[field] ?? ""}${unquote(line)}`;
    }
  }
  return fields;
};

const catalog = (locale: string): Entry[] => {
  const text = files[`./${locale}/messages.po`];
  if (text === undefined) {
    throw new Error(`No catalog for ${locale}`);
  }
  return text
    .split(blankLine)
    .map((block) => {
      const fields = fieldsOf(block);
      const id = fields.msgid ?? "";
      return {
        key: fields.msgctxt === undefined ? id : `${fields.msgctxt} | ${id}`,
        id,
        str: fields.msgstr ?? "",
      };
    })
    .filter((entry) => entry.id !== "");
};

/** The names a message fills in, and its numbered tags, in a stable order. */
const slots = (message: string): string[] => {
  const names = new Set<string>();
  const walk = (tokens: Token[]): void => {
    for (const token of tokens) {
      if (token.type === "argument" || token.type === "function") {
        names.add(`{${token.arg}}`);
      }
      if (token.type === "plural" || token.type === "select") {
        names.add(`{${token.arg}}`);
        for (const each of token.cases) {
          walk(each.tokens);
        }
      }
    }
  };
  walk(parse(message));
  const tags = message.match(numberedTag) ?? [];
  return [...names, ...new Set(tags)].toSorted();
};

const english = catalog("en");

describe("translations", () => {
  it.each(translated)(
    "%s has every message, and nothing the English hasn't",
    (locale) => {
      const entries = catalog(locale);
      expect(
        entries
          .filter((entry) => entry.str.trim() === "")
          .map((entry) => entry.key)
      ).toStrictEqual([]);
      expect(entries.map((entry) => entry.key).toSorted()).toStrictEqual(
        english.map((entry) => entry.key).toSorted()
      );
    }
  );

  it.each(translated)(
    "%s keeps every placeholder and tag, in valid ICU",
    (locale) => {
      const broken = catalog(locale).flatMap((entry) => {
        try {
          const want = slots(entry.id).join(" ");
          const got = slots(entry.str).join(" ");
          return want === got
            ? []
            : [`${entry.key}: wants ${want}, has ${got}`];
        } catch (error) {
          return [`${entry.key}: ${String(error)}`];
        }
      });
      expect(broken).toStrictEqual([]);
    }
  );
});
