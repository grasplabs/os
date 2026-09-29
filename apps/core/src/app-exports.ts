import {
  appErrors,
  appExportsMaxLength,
  appExportsPath,
  appExportsSchema,
} from "@grasp-os/shared/apps";
import type { AppExports } from "@grasp-os/shared/apps";

// An App's exports: the methods of its server code other Apps may call,
// under a permission an admin grants them (`app` objects, permissions.ts).
// Read from the version's files once, as it is committed, and kept on its
// row (`app_versions.exports`), as a version never changes: so a call reads
// no files to find what it may call.

/**
 * The exports `files` declare (`appExportsPath`); none without the file.
 * Refuses with `app.exports_invalid`, naming the issues, a file that isn't
 * JSON, is too long, or isn't valid exports.
 */
export const exportsIn = (files: ReadonlyMap<string, string>): AppExports => {
  const text = files.get(appExportsPath);
  if (text === undefined) {
    return {};
  }
  if (text.length > appExportsMaxLength) {
    throw appErrors.create("app.exports_invalid", {
      issues: [`At most ${appExportsMaxLength} characters`],
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw appErrors.create("app.exports_invalid", {
      issues: ["Not JSON"],
    });
  }
  return appErrors.parse("app.exports_invalid", appExportsSchema, json);
};
