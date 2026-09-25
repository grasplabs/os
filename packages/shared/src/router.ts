/**
 * The header the router adds to every request it forwards to a client's core,
 * carrying the secret the two share. Core refuses requests without it, so a
 * core's own address is no way around the router.
 */
export const routerSecretHeader = "x-grasp-router-secret";
