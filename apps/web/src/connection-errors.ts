import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import { authErrors } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** One family of coded errors, as `defineErrorFamily` makes it. */
interface Family<Code extends string> {
  codeOf: (error: unknown) => Code | undefined;
  create: (code: Code) => Error;
}

/** `family`'s message for `code`, if the code is one of its own. */
const messageIn = <Code extends string>(
  family: Family<Code>,
  code: string
): string | undefined => {
  const known = family.codeOf({ code });
  return known === undefined ? undefined : family.create(known).message;
};

// The known codes' messages are core's, in English; the fallback is the page's.
const fallback = msg`Connecting didn't work. Try again, or ask an admin.`;

/**
 * What a flow that didn't finish says, by the code core's callback sends
 * back in `?connectionError=`. Anyone can put anything in a link, so the
 * page shows only a known code's own message, never the value itself.
 */
export const connectionErrorMessage = (code: string): string =>
  messageIn(connectionErrors, code) ??
  messageIn(connectErrors, code) ??
  messageIn(roleErrors, code) ??
  messageIn(authErrors, code) ??
  i18n._(fallback);
