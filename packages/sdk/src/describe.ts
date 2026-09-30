import { parse } from "@babel/parser";
import type {
  ArrowFunctionExpression,
  CallExpression,
  ForOfStatement,
  ForStatement,
  IfStatement,
  Node,
  ObjectExpression,
} from "@babel/types";
import { messageOf } from "@grasp-os/shared/errors";
import type {
  OptionValue,
  OutlineNode,
  StepOutline,
  WorkflowOutline,
} from "@grasp-os/shared/workflows";
import { z } from "zod";

import {
  namePattern,
  nameRule,
  optionForms,
  stepKinds,
  stepOptionSchemas,
} from "./steps.ts";
import type { OptionForm, StepMethod } from "./steps.ts";
import { WorkflowError } from "./workflow.ts";

// The outline's types are shared: core returns an outline to the web.
export type {
  BranchOutline,
  LoopOutline,
  OptionValue,
  OutlineNode,
  StepKind,
  StepOutline,
  WorkflowOutline,
} from "@grasp-os/shared/workflows";

const formHints: Record<OptionForm, string> = {
  literal: "must be a literal",
  param: "must be a parameter, e.g. `params.reviewer`",
  value: "must be a literal, an object of literals or a parameter",
  code: "",
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
const literalOf = (node: Node): string | number | boolean | undefined => {
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

/** The SDK's typed stubs of the App's bindings, which take `env`. */
type Stub = "appServer" | "appExports";

const isStub = (name: string | undefined): name is Stub =>
  name === "appServer" || name === "appExports";

/** Names the workflow function binds for its steps, parameters and state. */
interface Bindings {
  step: string | undefined;
  /** `params` in `async (step, { params }) => …`, or what it's renamed to. */
  params: string | undefined;
  /** `state` in `async (step, { state }) => …`, or what it's renamed to. */
  state: string | undefined;
  /** `env` in `async (step, { env }) => …`, or what it's renamed to. */
  env: string | undefined;
  /** The SDK's stubs the file imports, by the name it imports each as. */
  stubs: ReadonlyMap<string, Stub>;
}

const contextKeys = new Set([
  "params",
  "input",
  "state",
  "runId",
  "env",
  "readAttachment",
]);
const contextHint =
  "Destructure the workflow function's context, e.g. `async (step, { params, input, state }) => …`";
const parametersHint =
  "The workflow function takes `step` and its context, without default values or computed names";
const envHint = (env: string): string =>
  `Call the App's bindings as \`${env}.NAME.method(…)\`, \`appServer(${env})\` or \`appExports(${env}.NAME)\`; don't keep \`${env}\` or a binding in a variable or pass it on`;

/** How to read what the workflow function's context holds, instead. */
const destructuringHints = {
  params: "Read parameters as `params.name`, without destructuring it",
  state: "Read state as `state.get(…)`, without destructuring it",
  env: "Call the App's bindings as `env.NAME`, without destructuring it",
} as const;

// A default value or a computed name is code that runs with the context
// in reach, where no step shows it.
const runsCode = (node: Node): boolean =>
  node.type === "AssignmentPattern" ||
  (node.type === "ObjectProperty" && node.computed);

const bindingsOf = (
  params: Node[],
  stubs: ReadonlyMap<string, Stub>
): Bindings => {
  const [stepParam, contextParam, extra] = params;
  if (extra) {
    throw fail(extra, parametersHint);
  }
  if (stepParam && stepParam.type !== "Identifier") {
    throw fail(
      stepParam,
      "Name the workflow function's first parameter, e.g. `step`"
    );
  }
  const bindings: Bindings = {
    step: stepParam?.name,
    params: undefined,
    state: undefined,
    env: undefined,
    stubs,
  };
  if (!contextParam) {
    return bindings;
  }
  if (contextParam.type !== "ObjectPattern") {
    throw fail(contextParam, contextHint);
  }
  for (const property of contextParam.properties) {
    const key =
      property.type === "ObjectProperty" && !property.computed
        ? nameOf(property.key)
        : undefined;
    // A rest element or a computed key would hide what the workflow reads.
    if (
      property.type !== "ObjectProperty" ||
      key === undefined ||
      !contextKeys.has(key)
    ) {
      throw fail(property, contextHint);
    }
    if (key !== "params" && key !== "state" && key !== "env") {
      continue;
    }
    if (property.value.type !== "Identifier") {
      throw fail(property, destructuringHints[key]);
    }
    bindings[key] = property.value.name;
  }
  if (some(contextParam, runsCode)) {
    throw fail(contextParam, parametersHint);
  }
  return bindings;
};

/** The parameter a node reads (`params.name`), if any. */
const paramReadOf = (bindings: Bindings, node: Node): string | undefined =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === bindings.params
    ? nameOf(node.property)
    : undefined;

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

/** Whether `ancestor` holds the one argument of a call to the SDK's `stub`. */
const isStubArgument = (
  bindings: Bindings,
  ancestor: Ancestor | undefined,
  stub: Stub
): boolean =>
  ancestor?.node.type === "CallExpression" &&
  ancestor.key === "arguments" &&
  ancestor.node.arguments.length === 1 &&
  ancestor.node.callee.type === "Identifier" &&
  bindings.stubs.get(ancestor.node.callee.name) === stub;

/**
 * The binding a use of `env` calls, from the use's `ancestors`: `NAME` in
 * `env.NAME.method(…)` and `appExports(env.NAME)`, `APP` in
 * `appServer(env)`. Undefined for any other use (an alias, an argument, a
 * spread, a computed name), which could reach a binding unseen.
 */
const envCallOf = (
  bindings: Bindings,
  ancestors: Ancestor[]
): string | undefined => {
  const parent = ancestors.at(-1);
  const grandparent = ancestors.at(-2);
  if (isStubArgument(bindings, parent, "appServer")) {
    return "APP";
  }
  if (parent?.node.type !== "MemberExpression" || !isObjectOfMember(parent)) {
    return undefined;
  }
  const caller = ancestors.at(-3);
  const called =
    isObjectOfMember(grandparent) &&
    caller?.node.type === "CallExpression" &&
    caller.key === "callee";
  return called || isStubArgument(bindings, grandparent, "appExports")
    ? nameOf(parent.node.property)
    : undefined;
};

/** The App's bindings `nodes` call, in source order. */
const envCallsIn = (bindings: Bindings, nodes: Node[]): string[] => {
  const names: string[] = [];
  for (const node of nodes) {
    visit(node, (candidate, ancestors) => {
      if (
        candidate.type !== "Identifier" ||
        candidate.name !== bindings.env ||
        isNamePosition(ancestors)
      ) {
        return;
      }
      const called = envCallOf(bindings, ancestors);
      if (called !== undefined && !names.includes(called)) {
        names.push(called);
      }
    });
  }
  return names;
};

/** Whether `body` calls the App's bindings anywhere outside a step's call. */
const envOutsideSteps = (body: Node, bindings: Bindings): boolean => {
  let found = false;
  visit(body, (node, ancestors) => {
    if (
      node.type !== "Identifier" ||
      node.name !== bindings.env ||
      isNamePosition(ancestors)
    ) {
      return;
    }
    const inStepCall = ancestors.some(
      ({ node: ancestor, key }) =>
        key === "arguments" && isStepCall(bindings, ancestor)
    );
    found ||= !inStepCall;
  });
  return found;
};

/** Every step of `nodes`, said to call `env` as well. */
const withEnv = (nodes: readonly OutlineNode[]): OutlineNode[] =>
  nodes.map((node): OutlineNode => {
    if (node.type === "step") {
      const env = node.env ?? [];
      return { ...node, env: env.includes("env") ? env : [...env, "env"] };
    }
    if (node.type === "loop") {
      return { ...node, steps: withEnv(node.steps) };
    }
    return {
      ...node,
      steps: withEnv(node.steps),
      otherwise: withEnv(node.otherwise),
    };
  });

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
    // A step's function runs inside the step, where state can't be used, and
    // its options are read before it: state belongs between steps.
    const inStepCall = ancestors.some(
      ({ node: ancestor, key }) =>
        key === "arguments" && isStepCall(bindings, ancestor)
    );
    if (node.name === bindings.state && inStepCall) {
      throw fail(
        node,
        `Read and write \`${node.name}\` between steps, not in a step's options or function`
      );
    }
  });
};

// The context reaches the workflow's code only by the names its parameter
// list binds, and the App's bindings only as calls the step list names.
// `this`, `arguments` and `eval` could read the context unseen; so could
// `env`, a binding or an SDK stub that is kept in a variable, passed on,
// spread or read by a computed name.
const checkEnvUses = (body: Node, bindings: Bindings): void => {
  visit(body, (node, ancestors) => {
    if (node.type === "ThisExpression") {
      throw fail(node, "Don't use `this` in the workflow's function");
    }
    if (node.type !== "Identifier" || isNamePosition(ancestors)) {
      return;
    }
    if (node.name === "arguments" || node.name === "eval") {
      throw fail(node, `Don't use \`${node.name}\` in the workflow's function`);
    }
    const parent = ancestors.at(-1);
    const called =
      parent?.node.type === "CallExpression" && parent.key === "callee";
    if (bindings.stubs.has(node.name) && !called) {
      throw fail(
        node,
        `Only call \`${node.name}\`; don't rename it or pass it on`
      );
    }
    if (
      node.name === bindings.env &&
      envCallOf(bindings, ancestors) === undefined
    ) {
      throw fail(node, envHint(node.name));
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

/** What the file imports from the SDK, by the name it imports each as. */
const sdkImportsOf = (file: Node): Map<string, string | undefined> => {
  const imports = new Map<string, string | undefined>();
  visit(file, (node) => {
    if (node.type !== "ImportDeclaration" || node.source.value !== sdkModule) {
      return;
    }
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportSpecifier") {
        imports.set(specifier.local.name, nameOf(specifier.imported));
      }
    }
  });
  return imports;
};

/** Whether the file exports anything but `call` as its default. */
const exportsAnotherDefault = (file: Node, call: CallExpression): boolean =>
  some(file, (node) => {
    if (node.type === "ExportDefaultDeclaration") {
      return node.declaration !== call;
    }
    return (
      node.type === "ExportNamedDeclaration" &&
      node.specifiers.some(
        (specifier) => nameOf(specifier.exported) === "default"
      )
    );
  });

/**
 * The workflow function: the third argument of the one `workflow` call,
 * with the SDK's stubs the file imports.
 */
const findWorkflowFunction = (
  file: Node
): { run: ArrowFunctionExpression; stubs: Map<string, Stub> } => {
  const imports = sdkImportsOf(file);
  const stubs = new Map<string, Stub>();
  for (const [local, imported] of imports) {
    if (isStub(imported)) {
      stubs.set(local, imported);
    }
  }
  const calls: CallExpression[] = [];
  visit(file, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      imports.get(node.callee.name) === "workflow"
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
  // The file's default export is what runs: a workflow made some other way
  // and exported in this one's place would run under this one's step list.
  // A file without a default export runs as no workflow at all.
  if (exportsAnotherDefault(file, call)) {
    throw fail(
      call,
      "Export the workflow as the file's default: `export default workflow(…)`"
    );
  }
  const run = call.arguments.at(2);
  // An arrow function has no `this` or `arguments` of its own to read its
  // context by.
  if (run?.type !== "ArrowFunctionExpression") {
    throw fail(
      call,
      "Write the workflow's function inline, as an arrow function: the third argument of `workflow`"
    );
  }
  return { run, stubs };
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

const isStepMethod = (method: string | undefined): method is StepMethod =>
  method !== undefined && Object.hasOwn(stepOptionSchemas, method);

const stepMethodOf = (call: CallExpression): StepMethod => {
  const { callee } = call;
  const method =
    callee.type === "MemberExpression" && !callee.computed
      ? nameOf(callee.property)
      : undefined;
  if (!isStepMethod(method)) {
    throw fail(
      call,
      `\`step.${method ?? "?"}\` isn't a step; steps are ${Object.keys(stepOptionSchemas).join(", ")}`
    );
  }
  return method;
};

/** A literal, or an object of them, as written; undefined for anything else. */
const staticValueOf = (node: Node): OptionValue | undefined => {
  const literal = literalOf(node);
  if (literal !== undefined || node.type !== "ObjectExpression") {
    return literal;
  }
  const value: Record<string, OptionValue> = {};
  for (const property of node.properties) {
    const key =
      property.type === "ObjectProperty" && !property.computed
        ? nameOf(property.key)
        : undefined;
    const nested =
      property.type === "ObjectProperty" && key !== undefined
        ? staticValueOf(property.value)
        : undefined;
    if (key === undefined || nested === undefined) {
      return undefined;
    }
    value[key] = nested;
  }
  return value;
};

/** The options a step method takes, each with its schema and form. */
const optionsOfMethod = (method: StepMethod) =>
  new Map(
    Object.entries(stepOptionSchemas[method].shape).map(
      ([option, schema]: [string, z.ZodType]) => [
        option,
        { schema, form: optionForms.get(schema)?.form ?? "code" },
      ]
    )
  );

/** Why an option's value can't be read as its form asks; undefined if it can. */
const optionProblem = (
  { schema, form }: { schema: z.ZodType; form: OptionForm },
  value: Node,
  bindings: Bindings
): string | undefined => {
  if (form === "code") {
    return undefined;
  }
  const isParam = paramReadOf(bindings, value) !== undefined;
  if (form === "param" || (form === "value" && isParam)) {
    return isParam ? undefined : formHints.param;
  }
  const literal = form === "literal" ? literalOf(value) : staticValueOf(value);
  if (literal === undefined) {
    return formHints[form];
  }
  const result = schema.safeParse(literal);
  return result.success
    ? undefined
    : `is invalid: ${z.prettifyError(result.error)}`;
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
  const allowed = optionsOfMethod(method);
  const options = new Map<string, Node>();
  for (const property of object.properties) {
    const { option, value } = optionOf(name, property);
    const allowedOption = allowed.get(option);
    if (!allowedOption) {
      throw fail(
        property,
        `\`${option}\` isn't an option of \`step.${method}\`; it takes ${[...allowed.keys()].join(", ")}`
      );
    }
    const problem = optionProblem(allowedOption, value, reader.bindings);
    if (problem !== undefined) {
      throw fail(property, `Option \`${option}\` of step "${name}" ${problem}`);
    }
    options.set(option, value);
  }
  const sideEffect = options.get("sideEffect");
  const required = [...allowed]
    .filter(([, { schema }]) => !(schema instanceof z.ZodOptional))
    .map(([option]) => option);
  // A side effect's input is what a dry run shows it would write.
  if (sideEffect && literalOf(sideEffect) === true) {
    required.push("input");
  }
  const missing = required.filter((option) => !options.has(option));
  if (missing.length > 0) {
    throw fail(object, `Step "${name}" needs ${missing.join(", ")}`);
  }
  return options;
};

const literalOptions = (
  options: Map<string, Node>
): Record<string, OptionValue> => {
  const literals: Record<string, OptionValue> = {};
  for (const [option, value] of options) {
    const literal = staticValueOf(value);
    if (literal !== undefined && !unrecordedOptions.has(option)) {
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
    throw fail(call, `A step name is a string literal of ${nameRule}`);
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
  const env = envCallsIn(reader.bindings, call.arguments);
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
    options: literalOptions(options),
    ...(env.length === 0 ? {} : { env }),
    code: textOf(reader, call),
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

/** The workflow function of `source` and the names it binds, its use of its context checked. */
const readContext = (
  source: string
): { run: ArrowFunctionExpression; bindings: Bindings } => {
  let file: Node;
  try {
    file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  } catch (error) {
    throw fail(undefined, `The workflow doesn't parse: ${messageOf(error)}`);
  }
  const { run, stubs } = findWorkflowFunction(file);
  const bindings = bindingsOf(run.params, stubs);
  checkEnvUses(run.body, bindings);
  return { run, bindings };
};

/**
 * Throws unless every call a workflow's code makes to the App's bindings
 * can be read from its TypeScript source, so the step list names each. The
 * workflow is the file's default export, made by the SDK's `workflow`, and
 * its function an arrow function that destructures its context in its
 * parameter list: the context has no other name. `env` appears only as
 * `env.NAME.method(…)`, `appServer(env)` or `appExports(env.NAME)`.
 * `this`, `arguments`, `eval`, and `env`, a binding or an SDK stub that is
 * renamed, passed on, spread or read by a computed name are errors, each
 * saying how to write it instead.
 *
 * It is the part of `describeWorkflow` that isn't about how steps are laid
 * out: a workflow that passes may still have steps that can't be read (a
 * step in a `try`, say), which a review then shows as unread, never as a
 * list that leaves a call out.
 */
export const checkWorkflowBindings = (source: string): void => {
  readContext(source);
};

/**
 * Reads a workflow's steps from its TypeScript source, in source order, with
 * the `if`/`else` branches and `for`/`for...of` loops they sit in. Step
 * names and options must be written as literals in each call, so the list is
 * exactly what the code runs. Anything that can't be read that way (a step
 * inside a `switch`, `try`, `while` or nested function, options built
 * elsewhere, a step in a loop without a `key`) is an error that says how to
 * write it instead, and so is any call to the App's bindings that can't be
 * read (`checkWorkflowBindings`): each step names the bindings it calls.
 *
 * Pure JavaScript, so it runs inside workerd, e.g. when a workflow is saved.
 */
export const describeWorkflow = (source: string): WorkflowOutline => {
  const { run, bindings } = readContext(source);
  checkBindingUses(run.body, bindings);
  checkParamReads(run.body, bindings);
  const reader: Reader = { source, bindings, names: new Set() };
  const steps =
    run.body.type === "BlockStatement"
      ? describeStatement(reader, run.body, false)
      : describeExpression(reader, run.body, false);
  // A binding called outside every step's call (in a helper, say) may be
  // reached from any step: then each step is said to call `env`.
  return {
    steps: envOutsideSteps(run.body, bindings) ? withEnv(steps) : steps,
  };
};
