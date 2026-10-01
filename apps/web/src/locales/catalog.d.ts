/** A catalog, compiled by `@lingui/vite-plugin` when it is imported. */
declare module "*.po" {
  import type { Messages } from "@lingui/core";

  export const messages: Messages;
}
