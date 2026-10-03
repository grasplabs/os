/**
 * Grasp's own lint rules, loaded by oxlint as a JS plugin (vite.config.ts).
 *
 * no-scrollbars: the product shows no scrollbars (apps/web/src/styles.css
 * hides them; areas still scroll). This rule stops code from bringing one
 * back: the ScrollBar part of a scroll area, or a class or selector that
 * shows or styles a bar (`findScrollbar`).
 */
import { findScrollbar } from "./no-scrollbars.ts";

interface Node {
  type: string;
  value?: unknown;
  name?: Node | string;
  quasis?: { value: { raw: string } }[];
}

interface Context {
  report: (report: {
    node: Node;
    messageId: string;
    data?: Record<string, string>;
  }) => void;
}

const noScrollbars = {
  meta: {
    type: "problem",
    docs: {
      description: "The product shows no scrollbars; don't bring one back.",
    },
    messages: {
      component:
        "No scrollbars in the product: leave out <ScrollBar>. The area still scrolls without it.",
      className:
        'No scrollbars in the product: "{{found}}" shows or styles a scrollbar. Use overflow-auto; styles.css hides every bar.',
    },
    schema: [],
  },
  create: (context: Context) => {
    const check = (node: Node, text: string): void => {
      const found = findScrollbar(text);
      if (found !== undefined) {
        context.report({ node, messageId: "className", data: { found } });
      }
    };
    return {
      JSXOpeningElement: (node: Node): void => {
        const { name } = node;
        if (
          typeof name === "object" &&
          name.type === "JSXIdentifier" &&
          name.name === "ScrollBar"
        ) {
          context.report({ node, messageId: "component" });
        }
      },
      Literal: (node: Node): void => {
        if (typeof node.value === "string") {
          check(node, node.value);
        }
      },
      TemplateLiteral: (node: Node): void => {
        for (const quasi of node.quasis ?? []) {
          check(node, quasi.value.raw);
        }
      },
    };
  },
};

export default {
  meta: { name: "grasp" },
  rules: { "no-scrollbars": noScrollbars },
};
