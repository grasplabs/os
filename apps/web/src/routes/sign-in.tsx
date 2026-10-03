import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { loadCoreStatus } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { GraspMark } from "../grasp-mark.tsx";
import { LanguageButton } from "../language-picker.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";

// Where the product sends whoever isn't signed in (routes/_shell.tsx),
// with the page to go back to. Someone already signed in goes straight
// back there.

const signInPath = "/sign-in";

/**
 * What no path of this site holds: control characters and spaces, which
 * browsers drop from an address (`/\t/evil.test` is `//evil.test`), and
 * backslashes, which they read as `/` (`/\evil.test`).
 */
// oxlint-disable-next-line no-control-regex -- control characters are what it looks for
const unsafeInPath = /[\u0000- \u007F\\]/u;

/**
 * The page to go back to: a path of this site, never another site's
 * address (`//evil.test`) and never this page, which would send a signed-in
 * person round in circles. Anyone can put anything in a link.
 */
const returnPathOf = (value: unknown): string =>
  typeof value === "string" &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !unsafeInPath.test(value) &&
  !value.startsWith(signInPath)
    ? value
    : "/";

/**
 * The page in the onboarding's frame (grasplabs/prototype
 * `components/onboarding/onboarding-frame.tsx`): one centred column with
 * Grasp's buddy, the mark bottom left and the language bottom right.
 */
const SignIn = () => {
  const { connected, signInOptions } = Route.useLoaderData();
  const { error, returnTo } = Route.useSearch();
  const { t } = useLingui();
  return (
    <div className="bg-background flex min-h-svh flex-col text-sm">
      <div aria-hidden="true" className="h-18 flex-none" />
      <main className="flex flex-1 flex-col items-center px-4 py-2">
        <div className="my-auto flex w-full max-w-sm flex-col items-center gap-8 text-center">
          <GraspBuddy />
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-medium tracking-tight text-balance">
              <Trans>Sign in to Grasp</Trans>
            </h1>
            {connected ? (
              <p className="text-muted-foreground text-balance">
                <Trans>Use your organization’s account to go on.</Trans>
              </p>
            ) : null}
          </div>
          {connected ? (
            <SignInOptions
              error={error}
              options={signInOptions}
              returnTo={returnTo}
            />
          ) : (
            <ErrorText>
              {t`Grasp can't be reached right now. Try again in a moment.`}
            </ErrorText>
          )}
        </div>
      </main>
      <footer className="bg-background sticky bottom-0 flex h-18 flex-none items-center justify-between px-4 sm:px-10">
        <GraspMark className="text-foreground size-5" />
        <LanguageButton />
      </footer>
    </div>
  );
};

export const Route = createFileRoute("/sign-in")({
  validateSearch: (
    search: Record<string, unknown>
  ): { returnTo: string; error?: string } => ({
    returnTo: returnPathOf(search.returnTo),
    ...signInErrorSearch(search),
  }),
  loaderDeps: ({ search }) => ({ returnTo: search.returnTo }),
  loader: async ({ context: { core }, deps }) => {
    const status = await loadCoreStatus(core);
    if (status.identity !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ href: deps.returnTo });
    }
    return status;
  },
  component: SignIn,
});
