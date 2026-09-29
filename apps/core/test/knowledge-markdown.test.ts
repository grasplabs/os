import { describe, expect, it } from "vite-plus/test";

import {
  FrontmatterError,
  parseFrontmatter,
} from "../src/knowledge/frontmatter.ts";
import { extractLinks, splitSections } from "../src/knowledge/markdown.ts";

// The parsers a save runs: frontmatter, sections and links. Pure logic, so
// tested on its own, in workerd like the rest (the YAML parser runs there).

const typeOf = (path: string, text = "") => parseFrontmatter(path, text).type;

/** The problems a frontmatter was refused for, or "ok". */
const refusal = (path: string, text: string): string[] | "ok" => {
  try {
    parseFrontmatter(path, text);
    return "ok";
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return error.issues;
    }
    throw error;
  }
};

describe("frontmatter", () => {
  it("is optional: a document without it is a doc", () => {
    expect(parseFrontmatter("notes.md", "# Notes\n\nText.")).toStrictEqual({
      type: "doc",
      frontmatter: { description: "", tags: [] },
      body: "# Notes\n\nText.",
    });
  });

  it("is read and checked against its type, and split from the body", () => {
    const text = [
      "---",
      "type: decision",
      "title: Use D1 for Knowledge",
      "description: Read before choosing storage.",
      "owner: jakob@acme.test",
      "tags: [storage, eu]",
      "review: 2027-01-31",
      "status: accepted",
      "aliases: [d1]",
      "---",
      "Body.",
    ].join("\r\n");
    expect(parseFrontmatter("decisions/d1.md", text)).toStrictEqual({
      type: "decision",
      frontmatter: {
        title: "Use D1 for Knowledge",
        description: "Read before choosing storage.",
        owner: "jakob@acme.test",
        tags: ["storage", "eu"],
        review: "2027-01-31",
        status: "accepted",
      },
      body: "Body.",
    });
  });

  it("gives standard file names their type, unless the frontmatter names one", () => {
    expect([
      typeOf("pdf/SKILL.md", "---\nname: pdf\ndescription: Read PDFs.\n---"),
      typeOf("AGENTS.md"),
      typeOf("people/ann/USER.md"),
      typeOf("MEMORY.md"),
      typeOf("AGENTS.md", "---\ntype: doc\n---"),
      typeOf("skill.md"),
    ]).toStrictEqual(["skill", "memory", "memory", "memory", "doc", "doc"]);
  });

  it("refuses a skill without its name and description", () => {
    expect(refusal("pdf/SKILL.md", "---\nname: Read PDFs\n---")).toStrictEqual([
      "frontmatter.description: Invalid input: expected string, received undefined",
      "frontmatter.name: Lowercase letters, digits and single hyphens",
    ]);
  });

  it("refuses what doesn't match its schema, naming each problem", () => {
    expect({
      type: refusal("a.md", "---\ntype: essay\n---"),
      review: refusal("a.md", "---\nreview: next week\n---"),
      tags: refusal("a.md", "---\ntags: [ok, '']\n---"),
      title: refusal("a.md", `---\ntitle: ${"x".repeat(201)}\n---`),
    }).toStrictEqual({
      type: ["frontmatter.type: one of doc, skill, memory, decision, file"],
      review: ["frontmatter.review: Invalid ISO date"],
      tags: [
        "frontmatter.tags.1: Too small: expected string to have >=1 characters",
      ],
      title: [
        "frontmatter.title: Too big: expected string to have <=200 characters",
      ],
    });
  });

  it("refuses YAML that isn't a mapping, doesn't parse or isn't closed", () => {
    const results = [
      refusal("a.md", "---\n- a list\n---"),
      refusal("a.md", "---\ntitle: [unclosed\n---"),
      refusal("a.md", "---\ntitle: Open\n\nNo closing line."),
      refusal("a.md", "---\ntitle: One\ntitle: Two\n---"),
    ];
    expect(
      results.map((issues) => issues !== "ok" && issues.length === 1)
    ).toStrictEqual([true, true, true, true]);
  });

  it("refuses YAML aliases that would expand a small block into a huge one", () => {
    const bomb = [
      "---",
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "---",
    ].join("\n");
    expect(refusal("a.md", bomb)).not.toBe("ok");
  });

  it("isn't fooled by a __proto__ key", () => {
    const { frontmatter } = parseFrontmatter(
      "a.md",
      "---\n__proto__: { polluted: true }\ntitle: Safe\n---"
    );
    const polluted: unknown = Reflect.get({}, "polluted");
    expect({ frontmatter, polluted }).toStrictEqual({
      frontmatter: { title: "Safe", description: "", tags: [] },
      polluted: undefined,
    });
  });
});

describe("sections", () => {
  it("split at each heading, with the headings above them", () => {
    const markdown = [
      "Intro before any heading.",
      "",
      "# Leave",
      "Everyone gets leave.",
      "## Parental leave ##",
      "Sixteen weeks.",
      "### Partners",
      "Six weeks.",
      "## Sick leave",
      "Call in.",
      "# Expenses",
    ].join("\n");
    expect(splitSections(markdown)).toStrictEqual([
      { headings: [], text: "Intro before any heading." },
      { headings: ["Leave"], text: "# Leave\nEveryone gets leave." },
      {
        headings: ["Leave", "Parental leave"],
        text: "## Parental leave ##\nSixteen weeks.",
      },
      {
        headings: ["Leave", "Parental leave", "Partners"],
        text: "### Partners\nSix weeks.",
      },
      { headings: ["Leave", "Sick leave"], text: "## Sick leave\nCall in." },
      { headings: ["Expenses"], text: "# Expenses" },
    ]);
  });

  it("don't start inside a fenced code block or without a space after #", () => {
    const markdown = [
      "# Setup",
      "```sh",
      "# not a heading",
      "````",
      "~~~",
      "```",
      "# still code: only ~~~ closes this block",
      "~~~",
      "#hashtag and #7 aren't headings either",
      "## Next",
    ].join("\n");
    expect(
      splitSections(markdown).map(({ headings }) => headings)
    ).toStrictEqual([["Setup"], ["Setup", "Next"]]);
  });

  it("leave out a blank document", () => {
    expect(splitSections("\n  \n")).toStrictEqual([]);
  });
});

describe("links", () => {
  it("name documents by path, with .md added, once each, with their label", () => {
    const markdown = [
      "See [[handbook/leave]] and [[handbook/leave.md|the leave policy]].",
      "Also [[ expenses#Travel | travel costs ]] and [[sheet.csv]].",
    ].join("\n");
    expect(extractLinks(markdown)).toStrictEqual([
      { path: "handbook/leave.md", label: null },
      { path: "expenses.md", label: "travel costs" },
      { path: "sheet.csv", label: null },
    ]);
  });

  it("aren't read from code or from targets that aren't paths", () => {
    const markdown = [
      "Inline `[[in-code]]` code.",
      "```",
      "[[in-block]]",
      "```",
      "[[#Only a heading]] [[../outside]] [[/absolute]] [[a//b]]",
      "[[real]]",
    ].join("\n");
    expect(extractLinks(markdown)).toStrictEqual([
      { path: "real.md", label: null },
    ]);
  });
});
