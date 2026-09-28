import type { AppId, WorkspaceId } from "@grasp-os/shared/ids";

/**
 * Durable Objects keep their data in the EU. workerd doesn't implement
 * jurisdictions (tests, local dev) and on-prem has no Cloudflare jurisdiction,
 * so those pass `DURABLE_OBJECT_JURISDICTION=none` with `--var` or as a
 * binding; it is never set in wrangler.jsonc. Unset or any other value means
 * the EU, so a deployment can't leave it by mistake.
 */
/** The namespace to get an object from, in the EU unless turned off. */
export const inJurisdiction = <T extends Rpc.DurableObjectBranded | undefined>(
  env: Pick<Env, "DURABLE_OBJECT_JURISDICTION">,
  namespace: DurableObjectNamespace<T>
): DurableObjectNamespace<T> =>
  env.DURABLE_OBJECT_JURISDICTION === "none"
    ? namespace
    : namespace.jurisdiction("eu");

/** The object that hosts an App's server code (app.ts), named by the App's ID. */
export const appHost = (
  env: Pick<Env, "APPS" | "DURABLE_OBJECT_JURISDICTION">,
  app: AppId
) => inJurisdiction(env, env.APPS).getByName(app);

/** A workspace's object (workspace.ts): its chats and their agent. */
export const workspace = (
  env: Pick<Env, "WORKSPACES" | "DURABLE_OBJECT_JURISDICTION">,
  id: WorkspaceId
) => inJurisdiction(env, env.WORKSPACES).getByName(id);
