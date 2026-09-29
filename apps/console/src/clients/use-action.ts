import { useAction } from "../use-action.ts";
import type { SettingsErrorCode } from "./settings.ts";

/** What staff read when the console refuses a settings change, by its code. */
const refusals: Readonly<Record<SettingsErrorCode, string>> = {
  unknown_client: "There's no such client.",
  sign_in_invalid:
    "That sign-in isn't complete: give an Entra tenant or a Google Workspace, its email domains, and its first admins.",
  admin_unreachable:
    "Name at least one first admin, each with an email in the email domains, or nobody could ever sign in as admin.",
};

/** A staff change to a client's settings (`useAction`), its refusals worded. */
export const useSettingsAction = () => useAction(refusals);
