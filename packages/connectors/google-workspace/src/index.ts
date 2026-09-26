import { defineConnector } from "@grasp-os/connector-kit/connector";

/**
 * Native Google Workspace connector: Gmail, Calendar and Drive, on Google's
 * APIs. Its tools are added here.
 */
export default defineConnector({
  name: "google-workspace",
  version: "0.1.0",
  provider: "google",
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  hosts: ["gmail.googleapis.com", "www.googleapis.com"],
  tools: [],
});
