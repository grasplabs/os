import { parse } from "@babel/parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  FunctionExpression,
  ForOfStatement,
  ForStatement,
  IfStatement,
  Node,
  ObjectExpression,
} from "@babel/types";

import { namePattern, stepKinds } from "./steps.ts";
import type { StepKind, StepMethod } from "./steps.ts";
import { WorkflowError } from "./workflow.ts";

export type { StepKind } from "./steps.ts";

/** An option written as a literal. */
export type OptionValue = string | number | boolean;

/** A step as the UI shows it. */
export interface StepOutline {
  type: "step";
  name: string;
  kind: StepKind;
  description: string;
  /** Source of the per-item key, e.g. `invoice.id`; only on keyed steps. */
  key?: string;
  /** Changes something outside Grasp; a decision's `ask` always does. */
  sideEffect: boolean;
  /** Deterministic, with no model involvement. */
  locked: boolean;
  /** Parameters the call reads (options and callback), in source order. */
  params: string[];
  /** Other options written as literals, e.g. `retries` or `instructions`. */
  options: Record<string, OptionValue>;
  line: number;
}

/** Steps that run only when a condition holds. */
export interface BranchOutline {
  type: "branch";
  /** The condition as written, e.g. `extracted.total > params.threshold`. */
  condition: string;
  /** Parameters the condition reads. */
  params: string[];
  /** Steps when the condition holds. */
  steps: OutlineNode[];
  /** Steps when it doesn't (the `else`). */
  otherwise: OutlineNode[];
  line: number;
}

/** Steps that run once per item. */
export interface LoopOutline {
  type: "loop";
  /** The loop's head as written, e.g. `for (const invoice of input.invoices)`. */
  header: string;
  /** Parameters the head reads. */
  params: string[];
  steps: OutlineNode[];
  line: number;
}

export type OutlineNode = StepOutline | BranchOutline | LoopOutline;

/** A workflow's steps, as its code runs them. */
export interface WorkflowOutline {
  steps: OutlineNode[];
}

type OptionRule =
  // A non-empty string literal.
  | "text"
  | "boolean"
  // A whole, non-negative number literal.
  | "count"
  // A parameter, read as `params.name`.
  | "param"
  // Any expression; recorded when it's a literal (durations, say).
  | "any";

const common = { description: "text", key: "any" } as const;
const optionRules: Record<StepMethod, Record<string, OptionRule>> = {
  do: {
    ...common,
    sideEffect: "boolean",
    locked: "boolean",
    retries: "count",
    input: "any",
  },
  llm: {
    ...common,
    model: "param",
    instructions: "text",
    input: "any",
    schema: "any",
    retries: "count",
  },
  decision: {
    ...common,
    from: "param",
    ask: "any",
    timeout: "any",
    remindAfter: "any",
  },
  sleep: { ...common, duration: "any" },
  waitFor: { ...common, type: "text", timeout: "any", schema: "any" },
};
const requiredOptions: Record<StepMethod, string[]> = {
  do: ["description"],
  llm: ["description", "model", "instructions", "input", "schema"],
  decision: ["description", "from", "ask"],
  sleep: ["description", "duration"],
  waitFor: ["description", "type", "timeout"],
};
const ruleHints: Record<OptionRule, string> = {
  text: "must be a non-empty string literal",
  boolean: "must be `true` or `false`",
  count: "must be a whole, non-negative number",
  param: "must be a parameter, e.g. `params.reviewer`",
  any: "",
};
// Options with a field of their own in the outline, or no literal meaning.
const unrecordedOptions = new Set([
  "description",
  "key",
  "sideEffect",
  "locked",
]);

const sdkModule = "@grasp-os/sdk/workflow";
const supportedConstructs = "`if`/`else` and `for`/`for...of` loops";

// Keys that hold no code: positions, comments and TypeScript types.
const ignoredKeys = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
]);

const fail = (node: Node | undefined, message: string): WorkflowError =>
  new WorkflowError(
    "workflow.invalid_definition",
    node?.loc ? `Line ${node.loc.start.line}: ${message}` : message
  );

const lineOf = (node: Node): number => node.loc?.start.line ?? 0;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const childrenOf = (node: Node): [string, Node][] =>
  Object.entries(node).flatMap(([key, value]: [string, unknown]) => {
    if (ignoredKeys.has(key)) {
      return [];
    }
    const values: unknown[] = Array.isArray(value) ? value : [value];
    return values.filter(isNode).map((child): [string, Node] => [key, child]);
  });

interface Ancestor {
  node: Node;
  /** The key of the parent that holds the child. */
  key: string;
}

/** Every node under `node` (itself included), with its ancestors. */
const visit = (
  node: Node,
  onNode: (node: Node, ancestors: Ancestor[]) => void,
  ancestors: Ancestor[] = []
): void => {
  onNode(node, ancestors);
  for (const [key, child] of childrenOf(node)) {
    visit(child, onNode, [...ancestors, { node, key }]);
  }
};

const some = (node: Node, predicate: (node: Node) => boolean): boolean => {
  let found = false;
  visit(node, (candidate) => {
    found ||= predicate(candidate);
  });
  return found;
};

/** A string, template without placeholders, number or boolean literal. */
const literalOf = (node: Node): OptionValue | undefined => {
  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral"
  ) {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
};

const nameOf = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  const literal = literalOf(node);
  return typeof literal === "string" ? literal : undefined;
};

/** Names the workflow function binds for its steps and parameters. */
interface Bindings {
  step: string | undefined;
  /** `params` in `async (step, { params }) => …`, or what it's renamed to. */
  params: string | undefined;
  /** `ctx` in `async (step, ctx) => …`, read as `ctx.params.name`. */
  context: string | undefined;
}

const bindingsOf = (params: Node[]): Bindings => {
  const [stepParam, contextParam] = params;
  if (stepParam && stepParam.type !== "Identifier") {
    throw fail(
      stepParam,
      "Name the workflow function's first parameter, e.g. `step`"
    );
  }
  const bindings: Bindings = {
    step: stepParam?.name,
    params: undefined,
    context: undefined,
  };
  if (contextParam?.type === "Identifier") {
    bindings.context = contextParam.name;
    return bindings;
  }
  if (contextParam && contextParam.type !== "ObjectPattern") {
    throw fail(
      contextParam,
      "Name the workflow function's second parameter or destructure it"
    );
  }
  for (const property of contextParam?.properties ?? []) {
    const isParams =
      property.type === "ObjectProperty" &&
      !property.computed &&
      nameOf(property.key) === "params";
    if (!isParams) {
      continue;
    }
    if (property.value.type !== "Identifier") {
      throw fail(
        property,
        "Read parameters as `params.name`, without destructuring them"
      );
    }
    bindings.params = property.value.name;
  }
  return bindings;
};

/** The parameter a node reads (`params.name` or `ctx.params.name`), if any. */
const paramReadOf = (bindings: Bindings, node: Node): string | undefined => {
  if (node.type !== "MemberExpression" || node.computed) {
    return undefined;
  }
  const { object } = node;
  const direct =
    object.type === "Identifier" && object.name === bindings.params;
  const throughContext =
    object.type === "MemberExpression" &&
    !object.computed &&
    object.object.type === "Identifier" &&
    object.object.name === bindings.context &&
    nameOf(object.property) === "params";
  return direct || throughContext ? nameOf(node.property) : undefined;
};

const paramsIn = (bindings: Bindings, nodes: Node[]): string[] => {
  const names: string[] = [];
  for (const node of nodes) {
    visit(node, (candidate) => {
      const name = paramReadOf(bindings, candidate);
      if (name !== undefined && !names.includes(name)) {
        names.push(name);
      }
    });
  }
  return names;
};

const isStepCall = (bindings: Bindings, node: Node): node is CallExpression =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === bindings.step;

/** Whether `ancestors` end in a spot where an identifier is a name, not a use. */
const isNamePosition = (ancestors: Ancestor[]): boolean => {
  const parent = ancestors.at(-1);
  if (!parent) {
    return false;
  }
  const { node, key } = parent;
  if (node.type === "MemberExpression") {
    return key === "property" && !node.computed;
  }
  const hasKey =
    node.type === "ObjectProperty" ||
    node.type === "ObjectMethod" ||
    node.type === "ClassMethod" ||
    node.type === "ClassProperty";
  return hasKey && key === "key" && !node.computed;
};

const isObjectOfMember = (ancestor: Ancestor | undefined): boolean =>
  ancestor?.node.type === "MemberExpression" &&
  ancestor.key === "object" &&
  !ancestor.node.computed;

// `step` may only be called as `step.method(…)`, parameters only read as
// `params.name`: passed around or destructured, their use can't be read.
const checkBindingUses = (body: Node, bindings: Bindings): void => {
  visit(body, (node, ancestors) => {
    if (node.type !== "Identifier" || isNamePosition(ancestors)) {
      return;
    }
    const parent = ancestors.at(-1);
    const grandparent = ancestors.at(-2);
    const member = isObjectOfMember(parent);
    if (node.name === bindings.step) {
      const called =
        member &&
        grandparent?.node.type === "CallExpression" &&
        grandparent.key === "callee";
      if (!called) {
        throw fail(
          node,
          `Only call steps as \`${node.name}.method(…)\`; don't pass \`${node.name}\` around`
        );
      }
    }
    if (node.name === bindings.params && !member) {
      throw fail(
        node,
        `Read parameters as \`${node.name}.name\`, so the step list shows which are used`
      );
    }
    if (node.name !== bindings.context) {
      return;
    }
    if (!member) {
      throw fail(
        node,
        `Read the context as \`${node.name}.input\`, \`${node.name}.params.name\` and so on`
      );
    }
    const readsParams =
      parent?.node.type === "MemberExpression" &&
      nameOf(parent.node.property) === "params";
    if (readsParams && !isObjectOfMember(grandparent)) {
      throw fail(node, `Read parameters as \`${node.name}.params.name\``);
    }
  });
};

// Where the outline shows a parameter read: in a step's call, an `if`
// condition or a loop head.
const isShownPosition = (bindings: Bindings, ancestor: Ancestor): boolean => {
  const { node, key } = ancestor;
  if (node.type === "IfStatement") {
    return key === "test";
  }
  if (node.type === "ForOfStatement") {
    return key === "left" || key === "right";
  }
  if (node.type === "ForStatement") {
    return key === "init" || key === "test" || key === "update";
  }
  return key === "arguments" && isStepCall(bindings, node);
};

// A parameter read anywhere else (into a variable, say) could steer steps in
// ways the outline can't follow, so it's an error rather than a silent gap.
const checkParamReads = (body: Node, bindings: Bindings): void => {
  visit(body, (node, ancestors) => {
    const name = paramReadOf(bindings, node);
    if (
      name !== undefined &&
      !ancestors.some((ancestor) => isShownPosition(bindings, ancestor))
    ) {
      throw fail(
        node,
        `Read parameter "${name}" where it's used: in a step's options or function, an \`if\` condition or a loop head`
      );
    }
  });
};

/** The workflow function: the third argument of the one `workflow` call. */
const findWorkflowFunction = (
  file: Node
): ArrowFunctionExpression | FunctionExpression => {
  const localNames = new Set<string>();
  visit(file, (node) => {
    if (node.type !== "ImportDeclaration" || node.source.value !== sdkModule) {
      return;
    }
    for (const specifier of node.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        nameOf(specifier.imported) === "workflow"
      ) {
        localNames.add(specifier.local.name);
      }
    }
  });
  const calls: CallExpression[] = [];
  visit(file, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      localNames.has(node.callee.name)
    ) {
      calls.push(node);
    }
  });
  const [call, extra] = calls;
  if (!call || extra) {
    throw fail(
      extra,
      `Expected one call to \`workflow\` from "${sdkModule}", found ${calls.length}`
    );
  }
  const run = call.arguments.at(2);
  if (
    run?.type !== "ArrowFunctionExpression" &&
    run?.type !== "FunctionExpression"
  ) {
    throw fail(
      call,
      "Write the workflow's function inline, as the third argument of `workflow`"
    );
  }
  return run;
};

interface Reader {
  source: string;
  bindings: Bindings;
  /** Step names seen so far; each may appear once. */
  names: Set<string>;
}

const textOf = (reader: Reader, node: Node): string =>
  reader.source.slice(node.start ?? 0, node.end ?? 0);

const hasSteps = (reader: Reader, node: Node): boolean =>
  some(node, (candidate) => isStepCall(reader.bindings, candidate));

const stepMethods: StepMethod[] = ["do", "llm", "decision", "sleep", "waitFor"];

const stepMethodOf = (call: CallExpression): StepMethod => {
  const { callee } = call;
  const method =
    callee.type === "MemberExpression" && !callee.computed
      ? nameOf(callee.property)
      : undefined;
  const stepMethod = stepMethods.find((candidate) => candidate === method);
  if (!stepMethod) {
    throw fail(
      call,
      `\`step.${method ?? "?"}\` isn't a step; steps are ${stepMethods.join(", ")}`
    );
  }
  return stepMethod;
};

const optionIsValid = (
  rule: OptionRule,
  value: Node,
  bindings: Bindings
): boolean => {
  const literal = literalOf(value);
  switch (rule) {
    case "text": {
      return typeof literal === "string" && literal.trim() !== "";
    }
    case "boolean": {
      return typeof literal === "boolean";
    }
    case "count": {
      return (
        typeof literal === "number" && Number.isInteger(literal) && literal >= 0
      );
    }
    case "param": {
      return paramReadOf(bindings, value) !== undefined;
    }
    case "any": {
      return true;
    }
    default: {
      return rule satisfies never;
    }
  }
};

const optionOf = (
  name: string,
  property: ObjectExpression["properties"][number]
): { option: string; value: Node } => {
  const option =
    property.type === "ObjectProperty" && !property.computed
      ? nameOf(property.key)
      : undefined;
  if (property.type !== "ObjectProperty" || option === undefined) {
    throw fail(
      property,
      `Write each option of step "${name}" as \`name: value\`, without spreads or computed names`
    );
  }
  return { option, value: property.value };
};

/** The options of a step call, checked against what its method takes. */
const readOptions = (
  reader: Reader,
  name: string,
  method: StepMethod,
  object: ObjectExpression
): Map<string, Node> => {
  const rules = optionRules[method];
  const options = new Map<string, Node>();
  for (const property of object.properties) {
    const { option, value } = optionOf(name, property);
    const rule = rules[option];
    if (!rule) {
      throw fail(
        property,
        `\`${option}\` isn't an option of \`step.${method}\`; it takes ${Object.keys(rules).join(", ")}`
      );
    }
    if (!optionIsValid(rule, value, reader.bindings)) {
      throw fail(
        property,
        `Option \`${option}\` of step "${name}" ${ruleHints[rule]}`
      );
    }
    options.set(option, value);
  }
  const sideEffect = options.get("sideEffect");
  // A side effect's input is what a dry run shows it would write.
  const required =
    method === "do" && sideEffect && literalOf(sideEffect) === true
      ? [...requiredOptions.do, "input"]
      : requiredOptions[method];
  const missing = required.filter((option) => !options.has(option));
  if (missing.length > 0) {
    throw fail(object, `Step "${name}" needs ${missing.join(", ")}`);
  }
  return options;
};

const literalOptions = (
  options: Map<string, Node>,
  rules: Record<string, OptionRule>
): Record<string, OptionValue> => {
  const literals: Record<string, OptionValue> = {};
  for (const [option, value] of options) {
    const literal = literalOf(value);
    if (
      literal !== undefined &&
      !unrecordedOptions.has(option) &&
      rules[option] !== "param"
    ) {
      literals[option] = literal;
    }
  }
  return literals;
};

const stepNameOf = (
  reader: Reader,
  call: CallExpression,
  method: StepMethod
): string => {
  const expected = method === "do" ? 3 : 2;
  if (call.arguments.length !== expected) {
    throw fail(
      call,
      `\`step.${method}\` takes ${expected === 3 ? "a name, options and a function" : "a name and options"}`
    );
  }
  const [nameNode] = call.arguments;
  const name = nameNode ? literalOf(nameNode) : undefined;
  if (typeof name !== "string" || !namePattern.test(name)) {
    throw fail(
      call,
      'A step name is a string literal of up to 64 letters, digits, "-" or "_", starting with a letter'
    );
  }
  if (reader.names.has(name)) {
    throw fail(
      call,
      `Step "${name}" appears twice; give each step its own name`
    );
  }
  reader.names.add(name);
  return name;
};

const describeCall = (
  reader: Reader,
  call: CallExpression,
  inLoop: boolean
): StepOutline => {
  const method = stepMethodOf(call);
  const name = stepNameOf(reader, call, method);
  const [, optionsNode] = call.arguments;
  if (optionsNode?.type !== "ObjectExpression") {
    throw fail(
      call,
      `Write the options of step "${name}" as an object literal in the call`
    );
  }
  const options = readOptions(reader, name, method, optionsNode);
  const keyNode = options.get("key");
  if (inLoop && !keyNode) {
    throw fail(
      call,
      `Step "${name}" runs in a loop, so it needs a \`key\` that differs per item, e.g. \`key: item.id\``
    );
  }
  const flag = (option: string): boolean => {
    const node = options.get(option);
    return node ? literalOf(node) === true : false;
  };
  const description = options.get("description");
  return {
    type: "step",
    name,
    kind: stepKinds[method],
    description: description ? String(literalOf(description)) : "",
    ...(keyNode ? { key: textOf(reader, keyNode) } : {}),
    sideEffect:
      method === "decision" || (method === "do" && flag("sideEffect")),
    locked: method === "do" && flag("locked"),
    params: paramsIn(reader.bindings, call.arguments),
    options: literalOptions(options, optionRules[method]),
    line: lineOf(call),
  };
};

const isFunctionNode = (node: Node): boolean =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "ObjectMethod" ||
  node.type === "ClassMethod";

/** Parts of a node that run only sometimes: one side of `?:`, `&&`, `||`, `??`. */
const conditionalPartsOf = (node: Node): Node[] => {
  if (node.type === "ConditionalExpression") {
    return [node.consequent, node.alternate];
  }
  return node.type === "LogicalExpression" ? [node.right] : [];
};

// Steps in an expression, in evaluation order. Steps may not hide where the
// outline can't show them: in a nested function, another step's arguments,
// or one side of `?:`, `&&`, `||` or `??`.
const describeExpression = (
  reader: Reader,
  node: Node,
  inLoop: boolean
): StepOutline[] => {
  if (isStepCall(reader.bindings, node)) {
    const nested = node.arguments.find((argument) =>
      hasSteps(reader, argument)
    );
    if (nested) {
      throw fail(
        nested,
        "Run steps one after another, not inside another step"
      );
    }
    return [describeCall(reader, node, inLoop)];
  }
  if (isFunctionNode(node)) {
    if (hasSteps(reader, node)) {
      throw fail(
        node,
        "Run steps in the workflow's function itself, not in a nested function"
      );
    }
    return [];
  }
  const hidden = conditionalPartsOf(node).find((part) =>
    hasSteps(reader, part)
  );
  if (hidden) {
    throw fail(hidden, "Run a step that depends on a condition inside an `if`");
  }
  return childrenOf(node).flatMap(([, child]) =>
    describeExpression(reader, child, inLoop)
  );
};

// Describes a statement; passed in to the helpers for nested statements.
type DescribeStatement = (
  reader: Reader,
  node: Node,
  inLoop: boolean
) => OutlineNode[];

const describeIf = (
  reader: Reader,
  node: IfStatement,
  inLoop: boolean,
  describeBody: DescribeStatement
): OutlineNode[] => {
  if (hasSteps(reader, node.test)) {
    throw fail(node.test, "Run a step before the `if`, not in its condition");
  }
  const steps = describeBody(reader, node.consequent, inLoop);
  const otherwise = node.alternate
    ? describeBody(reader, node.alternate, inLoop)
    : [];
  const params = paramsIn(reader.bindings, [node.test]);
  // Kept when it reads a parameter, so every tunable value that steers the
  // run shows up.
  if (steps.length === 0 && otherwise.length === 0 && params.length === 0) {
    return [];
  }
  return [
    {
      type: "branch",
      condition: textOf(reader, node.test),
      params,
      steps,
      otherwise,
      line: lineOf(node),
    },
  ];
};

const describeLoop = (
  reader: Reader,
  node: ForOfStatement | ForStatement,
  describeBody: DescribeStatement
): OutlineNode[] => {
  const headParts: unknown[] =
    node.type === "ForOfStatement"
      ? [node.left, node.right]
      : [node.init, node.test, node.update];
  const head = headParts.filter(isNode);
  const inHead = head.find((part) => hasSteps(reader, part));
  if (inHead) {
    throw fail(inHead, "Run a step before the loop, not in its head");
  }
  const steps = describeBody(reader, node.body, true);
  const params = paramsIn(reader.bindings, head);
  if (steps.length === 0 && params.length === 0) {
    return [];
  }
  return [
    {
      type: "loop",
      header: reader.source.slice(node.start ?? 0, node.body.start ?? 0).trim(),
      params,
      steps,
      line: lineOf(node),
    },
  ];
};

// Statements whose steps the outline shows as they are.
const plainStatements = new Set([
  "ExpressionStatement",
  "VariableDeclaration",
  "ReturnStatement",
  "ThrowStatement",
  "EmptyStatement",
]);

const describeStatement: DescribeStatement = (reader, node, inLoop) => {
  if (node.type === "BlockStatement") {
    return node.body.flatMap((child) =>
      describeStatement(reader, child, inLoop)
    );
  }
  if (node.type === "IfStatement") {
    return describeIf(reader, node, inLoop, describeStatement);
  }
  if (node.type === "ForOfStatement" || node.type === "ForStatement") {
    return describeLoop(reader, node, describeStatement);
  }
  if (plainStatements.has(node.type)) {
    return describeExpression(reader, node, inLoop);
  }
  if (hasSteps(reader, node)) {
    throw fail(
      node,
      `Steps can sit in ${supportedConstructs} only; move this step out of the construct around it`
    );
  }
  return [];
};

/**
 * Reads a workflow's steps from its TypeScript source, in source order, with
 * the `if`/`else` branches and `for`/`for...of` loops they sit in. Step
 * names and options must be written as literals in each call, so the list is
 * exactly what the code runs. Anything that can't be read that way (a step
 * inside a `switch`, `try`, `while` or nested function, options built
 * elsewhere, a step in a loop without a `key`) is an error that says how to
 * write it instead.
 *
 * Pure JavaScript, so it runs inside workerd, e.g. when a workflow is saved.
 */
export const describeWorkflow = (source: string): WorkflowOutline => {
  let file: Node;
  try {
    file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw fail(undefined, `The workflow doesn't parse: ${reason}`);
  }
  const run = findWorkflowFunction(file);
  const bindings = bindingsOf(run.params);
  checkBindingUses(run.body, bindings);
  checkParamReads(run.body, bindings);
  const reader: Reader = { source, bindings, names: new Set() };
  const steps =
    run.body.type === "BlockStatement"
      ? describeStatement(reader, run.body, false)
      : describeExpression(reader, run.body, false);
  return { steps };
};
