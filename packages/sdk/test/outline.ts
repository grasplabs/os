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

const factory = /export const \w+ = \([\s\S]*?\) =>\s+workflow\(/u;

/**
 * A sample of the SDK's tests as an App would write it. The samples take
 * the outside systems they talk to as arguments, so each is a function
 * that makes its workflow; an App's workflow is its file's default
 * export, the only kind the reader reads. The same code, exported so.
 */
export const asDefaultExport = (source: string): string => {
  if (!factory.test(source)) {
    throw new Error("The sample isn't a function that makes its workflow");
  }
  return source.replace(factory, "export default workflow(");
};
