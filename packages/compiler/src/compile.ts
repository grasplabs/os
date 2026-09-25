import Babel from "@babel/standalone";
import reactCompiler from "babel-plugin-react-compiler";

/**
 * Compiles one TypeScript or TSX file to a JavaScript module in one Babel
 * pass: the React Compiler, then types stripped and JSX turned into calls to
 * `react/jsx-runtime`. `plugins` run first, on the source as written. Like
 * the frontend's build, it throws on anything the React Compiler can't
 * compile. `enableReanimatedCheck` is off: the check calls
 * `require.resolve`, which a Worker doesn't have.
 */
export const compileModule = (
  source: string,
  filename: string,
  plugins: unknown[] = []
): string => {
  const isTSX = filename.endsWith(".tsx");
  // Babel unwraps the plugin's CommonJS default export itself, the same way
  // under Node (the kit build) and in the bundled compiler.
  const { code } = Babel.transform(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    plugins: [
      ...plugins,
      [
        reactCompiler,
        {
          target: "19",
          panicThreshold: "all_errors",
          enableReanimatedCheck: false,
        },
      ],
    ],
    // Presets run after plugins, in reverse order: types go first.
    presets: [
      ["react", { runtime: "automatic" }],
      ["typescript", { isTSX, allExtensions: true }],
    ],
  });
  return code ?? "";
};

/** Runs Babel plugins over a JavaScript module, e.g. to rewrite its imports. */
export const transformModule = (
  code: string,
  filename: string,
  plugins: unknown[]
): string =>
  Babel.transform(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    compact: true,
    plugins,
  }).code ?? "";
