import {
  appErrors,
  appRecordTypesMaxLength,
  appRecordTypesPath,
  appRecordTypesSchema,
} from "@grasp-os/shared/apps";
import type { AppRecordTypes } from "@grasp-os/shared/apps";

// An App's record types: the kinds of record it keeps in the collections
// it may write (knowledge/record-types.ts enforces them). Read from the
// version's files once, as it is committed, and kept on its row
// (`app_versions.records`), as a version never changes: so a save reads no
// files to find the types it is checked against.

/**
 * The record types `files` declare (`appRecordTypesPath`); none without
 * the file. Refuses with `app.records_invalid`, naming the issues, a file
 * that isn't JSON, is too long, or isn't valid record types.
 */
export const recordTypesIn = (
  files: ReadonlyMap<string, string>
): AppRecordTypes => {
  const text = files.get(appRecordTypesPath);
  if (text === undefined) {
    return {};
  }
  if (text.length > appRecordTypesMaxLength) {
    throw appErrors.create("app.records_invalid", {
      issues: [`At most ${appRecordTypesMaxLength} characters`],
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw appErrors.create("app.records_invalid", { issues: ["Not JSON"] });
  }
  return appErrors.parse("app.records_invalid", appRecordTypesSchema, json);
};
