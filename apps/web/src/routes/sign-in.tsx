import { createFileRoute, redirect } from "@tanstack/react-router";

import { loadCoreStatus } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
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

const SignIn = () => {
  const { connected, signInOptions } = Route.useLoaderData();
  const { error, returnTo } = Route.useSearch();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-medium">Grasp</h1>
      {connected ? (
        <>
          <p className="text-muted-foreground text-sm">Sign in to go on.</p>
          <SignInOptions
            options={signInOptions}
            error={error}
            returnTo={returnTo}
          />
        </>
      ) : (
        <ErrorText>
          Grasp can&apos;t be reached right now. Try again in a moment.
        </ErrorText>
      )}
    </main>
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
  loader: async ({ deps }) => {
    const status = await loadCoreStatus();
    if (status.identity !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ href: deps.returnTo });
    }
    return status;
  },
  component: SignIn,
});
