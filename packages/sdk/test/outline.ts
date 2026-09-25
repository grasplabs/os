import { describeWorkflow } from "../src/describe.ts";
import type { OutlineNode } from "../src/describe.ts";

const withoutLines = (nodes: OutlineNode[]): unknown[] =>
  nodes.map(({ line: _line, ...node }) => {
    if (node.type === "step") {
      return node;
    }
    if (node.type === "loop") {
      return { ...node, steps: withoutLines(node.steps) };
    }
    return {
      ...node,
      steps: withoutLines(node.steps),
      otherwise: withoutLines(node.otherwise),
    };
  });

/** A workflow's step list without line numbers, which formatting moves. */
export const outlineOf = (source: string): unknown[] =>
  withoutLines(describeWorkflow(source).steps);
