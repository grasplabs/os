/**
 * Durable Objects keep their data in the EU. workerd doesn't implement
 * jurisdictions (tests, local dev) and on-prem has no Cloudflare jurisdiction,
 * so those pass `DURABLE_OBJECT_JURISDICTION=none` with `--var` or as a
 * binding; it is never set in wrangler.jsonc. Unset or any other value means
 * the EU, so a deployment can't leave it by mistake.
 */
interface JurisdictionEnv extends Env {
  DURABLE_OBJECT_JURISDICTION?: string;
}

/** The namespace to get an object from, in the EU unless turned off. */
export const inJurisdiction = <T extends Rpc.DurableObjectBranded | undefined>(
  env: JurisdictionEnv,
  namespace: DurableObjectNamespace<T>
): DurableObjectNamespace<T> =>
  env.DURABLE_OBJECT_JURISDICTION === "none"
    ? namespace
    : namespace.jurisdiction("eu");
