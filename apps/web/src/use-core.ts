import { useRouter } from "@tanstack/react-router";

import type { CoreConnection } from "./core-connection.ts";

/**
 * The tab's connection to core, for what a component asks of core itself.
 * It comes with the router's context (main.tsx), as loaders get it.
 */
export const useCore = (): CoreConnection => useRouter().options.context.core;
