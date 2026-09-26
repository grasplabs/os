import type { SignInOption } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";

import { signIn } from "./core.ts";
import { ErrorText } from "./error-text.tsx";
import { signInErrorMessage } from "./sign-in-errors.ts";

/**
 * A button for each way to sign in here, and why the last sign-in was
 * refused, if it was. The IdP sends the person back to `returnTo`.
 */
export const SignInOptions = ({
  options,
  error,
  returnTo,
}: {
  options: SignInOption[];
  error: string | undefined;
  returnTo?: string;
}) => (
  <div className="flex flex-col items-center gap-2">
    <ErrorText>
      {error === undefined ? undefined : signInErrorMessage(error)}
    </ErrorText>
    {options.map(({ providerId, label }) => (
      <Button
        key={providerId}
        onClick={() => {
          void signIn(providerId, returnTo);
        }}
      >
        Sign in with {label}
      </Button>
    ))}
  </div>
);
