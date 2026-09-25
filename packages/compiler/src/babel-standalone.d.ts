// @babel/standalone ships without types. This covers the part the compiler uses.
declare module "@babel/standalone" {
  interface TransformOptions {
    filename: string;
    babelrc: false;
    configFile: false;
    sourceType: "module";
    compact?: boolean;
    parserOpts?: { plugins: string[] };
    presets?: unknown[];
    plugins: unknown[];
  }

  interface TransformResult {
    code?: string | null;
  }

  const Babel: {
    transform: (code: string, options: TransformOptions) => TransformResult;
  };
  export default Babel;
}
