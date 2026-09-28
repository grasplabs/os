/**
 * Prints a client's router secret, derived from the router key as the router
 * derives it, so a core the console doesn't manage yet (grasp-os-staging,
 * grasp-os-internal) can be given it by hand:
 *
 *   op run --env-file router.env -- node scripts/router-secret.ts <clientId> <generation> \
 *     | wrangler secret put ROUTER_SECRET
 *
 * where `router.env` holds `ROUTER_KEY=op://<vault>/<item>/<field>`, a
 * reference 1Password resolves, never the key. Without 1Password, read it
 * without echoing it: `read -s ROUTER_KEY && export ROUTER_KEY`.
 *
 * Reads the key from the environment, never from the command line, so it
 * stays out of shell history and the process list.
 */
import { deriveRouterSecret } from "../packages/shared/src/router.ts";

const [clientId, generation] = process.argv.slice(2);
const routerKey = process.env.ROUTER_KEY;

if (clientId === undefined || generation === undefined) {
  throw new Error(
    "Usage: node scripts/router-secret.ts <clientId> <generation>"
  );
}
if (routerKey === undefined || routerKey === "") {
  throw new Error("ROUTER_KEY is not set");
}
if (!/^\d+$/u.test(generation)) {
  throw new Error("The generation must be a whole number");
}

process.stdout.write(
  await deriveRouterSecret(routerKey, clientId, Number(generation))
);
