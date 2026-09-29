import { describeWorkflow } from "../src/describe.ts";
import type { OutlineNode } from "../src/describe.ts";

const withoutLines = (nodes: OutlineNode[]): unknown[] =>
  nodes.map(({ line: _line, ...node }) => {
    if (node.type === "step") {
      // Its code as written, which formatting moves too.
      const { code: _code, ...step } = node;
      return step;
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

/** A workflow's step list without line numbers and each step's code, which formatting moves. */
export const outlineOf = (source: string): unknown[] =>
  withoutLines(describeWorkflow(source).steps);
