import { useAction } from "../use-action.ts";
import type { ProvisionErrorCode } from "./control.ts";

/** What staff read when the console refuses a change, by its code. */
const refusals: Readonly<Record<ProvisionErrorCode, string>> = {
  domain_not_set:
    "The console has no CLIENT_DOMAIN yet, so no client can get a hostname.",
  release_not_imported: "That release isn't imported.",
  sign_in_app_missing:
    "The console has no OAuth app for that IdP yet: set ENTRA_CLIENT_ID or GOOGLE_CLIENT_ID on it first.",
  client_exists: "A client with that id exists already: open its page.",
  account_taken: "Another client is on that Cloudflare account.",
  account_in_use:
    "That Cloudflare account already runs Grasp: it's staging, the console's, or another client's.",
  account_unreachable:
    "The deployer isn't a member of that Cloudflare account: add it first.",
  already_running: "Its provisioning is running already.",
  not_provisioning: "It isn't being provisioned, so there's nothing to do.",
};

/** A staff action on a client's provisioning (`useAction`), its refusals worded. */
export const useProvisionAction = () => useAction(refusals);
