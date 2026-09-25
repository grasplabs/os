/**
 * The kit: what App screens can import. `build.ts` builds it once per
 * release, as ES modules (`KitModules`) and as what the compiler needs to
 * check and rewrite imports and to build CSS (`Kit`).
 *
 * Every module, the kit's and an App's, has a flat name such as `react.js`,
 * `@grasp-os~ui~components~button.js` or `app~screens~desk.js`, and imports
 * others by that name. Flat names are bare specifiers, so a browser page can
 * map them to `data:` URLs with an import map, and they resolve as they are
 * between modules loaded into a Worker.
 */
export interface Kit {
  /** The specifiers App code may import, e.g. `@grasp-os/ui/components/button`. */
  imports: string[];
  /** lucide-react's icons by export name, e.g. `InboxIcon`, and the module that has each. */
  icons: Record<string, string>;
  /** The kit's stylesheet, followed by the stylesheets it imports, by import id. */
  stylesheets: Record<string, string>;
  /** Tailwind class candidates in the kit's own sources. */
  candidates: string[];
}

/** The kit's modules, shared by every App of a release. */
export interface KitModules {
  /** Changes with every change to the kit. */
  version: string;
  /** Module code by flat name. */
  modules: Record<string, string>;
}

/** The kit's stylesheet, by the id its content is filed under in `stylesheets`. */
export const kitStylesheet = "@grasp-os/ui/styles.css";

/** The flat name of the kit module a specifier names, e.g. `react/jsx-runtime`. */
export const kitModuleName = (specifier: string): string =>
  `${specifier.replaceAll("/", "~")}.js`;

const typescriptExtension = /\.tsx?$/u;

/** The flat name of an App file's module, e.g. `app~screens~desk.js`. */
export const appModuleName = (path: string): string =>
  `app~${path.replace(typescriptExtension, "").replaceAll("/", "~")}.js`;
