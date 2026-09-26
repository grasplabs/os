import { defineConnector } from "@grasp-os/connector-kit/connector";

/**
 * Native Microsoft 365 connector, on Microsoft Graph: mail, calendars, and
 * files in OneDrive and SharePoint. Its tools are added here.
 */
export default defineConnector({
  name: "microsoft-365",
  version: "0.1.0",
  provider: "microsoft",
  scopes: [
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "Calendars.Read",
    "Files.Read.All",
    "Sites.Read.All",
  ],
  hosts: ["graph.microsoft.com"],
  tools: [],
});
