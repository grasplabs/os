import { isBuiltinDocumentType } from "@grasp-os/shared/knowledge";
import type { BuiltinDocumentType } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Words core sends as codes, as the page shows them in the person's
// language. Read with `i18n._` when rendering, never at module load.

const roleNames = {
  admin: msg`Admin`,
  builder: msg`Builder`,
  user: msg`User`,
} as const satisfies Record<Role, unknown>;

const isRole = (role: string): role is Role => Object.hasOwn(roleNames, role);

/** A member's organization role, as people read it. */
export const roleLabel = (role: string): string =>
  isRole(role) ? i18n._(roleNames[role]) : role;

const documentTypeNames = {
  doc: msg`Document`,
  skill: msg`Skill`,
  memory: msg`Memory`,
  decision: msg`Decision`,
  file: msg`File`,
} as const satisfies Record<BuiltinDocumentType, unknown>;

/**
 * A document's kind, as its page names it: a type the platform knows in
 * the person's language, a record type an App declares by its own name.
 */
export const documentTypeLabel = (type: string): string =>
  isBuiltinDocumentType(type) ? i18n._(documentTypeNames[type]) : type;
